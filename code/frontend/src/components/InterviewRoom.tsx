"use client";

import { useEffect, useRef, useState } from "react";
import { Avatar, type AvatarControl } from "@/components/Avatar";
import { DebriefView } from "@/components/DebriefView";
import { ScreenShareButton } from "@/components/ScreenShareButton";
import { ApiError, SAVE_TIMEOUT_MS, api } from "@/lib/api";
import { captureFrame } from "@/lib/screenFrames";
import { watchConnection } from "@/lib/useConnectionWatch";
import type { Persona, SessionEvent } from "@/lib/contracts";
import { QUARTIER_BOERSE_GUIDE } from "@/lib/sample";

// Voice interview pilot: the browser talks to OpenAI Realtime over WebRTC with a short-lived
// client secret from our backend. Our backend never holds the audio connection.

type Turn = { who: "interviewer" | "persona"; text: string; cancelled?: boolean };
type Phase = "idle" | "connecting" | "live" | "ending" | "waiting" | "saving" | "ended" | "unsaved" | "error";
type Speaker = "interviewer" | "persona";
type Metrics = { latenciesMs: number[]; inputTokens: number; outputTokens: number };
type EndTimings = { drainMs?: number; saveMs?: number; closeMs?: number };

// How often the persona gets a fresh look at the interviewer's camera.
const CAMERA_FRAME_MS = 15_000;
// After End: how long before the popup offers to close without the missing work.
const DRAIN_PATIENCE_MS = 8_000;
// After End: lets the last audio packets reach the provider before committing them.
const COMMIT_DELAY_MS = 200;
const SAVE_ATTEMPTS = 3;

const seconds = (ms?: number) => (ms === undefined ? "–" : `${(ms / 1000).toFixed(1)} s`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// What End is still waiting for, in the interviewer's words.
function pendingNote(pending: Set<string>) {
  const keys = [...pending];
  if (keys.some((k) => k === "speech" || k.startsWith("t:"))) return "Transcribing your last sentence";
  if (keys.some((k) => k.startsWith("a:"))) return "Waiting for the persona to take your question";
  return "Waiting for the persona to finish answering";
}

// Realtime server events we act on (subset of the GA event list).
type ServerEvent = {
  type: string;
  item_id?: string;
  content_index?: number;
  transcript?: string;
  response?: { id?: string; status?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  error?: { message?: string; event_id?: string };
};

export function InterviewRoom({ persona }: { persona: Persona }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [metrics, setMetrics] = useState<Metrics>({ latenciesMs: [], inputTokens: 0, outputTokens: 0 });
  const [typed, setTyped] = useState("");
  const [guide, setGuide] = useState(QUARTIER_BOERSE_GUIDE.join("\n"));
  // Transcript persistence: every finalized turn becomes an event with the next seq. The browser is
  // the only writer, so events[] is the truth and `saved` is how many the backend has confirmed.
  const events = useRef<SessionEvent[]>([]);
  const saved = useRef(0);
  const sending = useRef<Promise<void> | null>(null);
  const [saveState, setSaveState] = useState({ saved: 0, total: 0, failed: false });
  const liveSince = useRef(0);
  // The session the debrief is for, set once its transcript is fully saved and it is marked ended.
  const [ended, setEnded] = useState<{ id: string; questions: number } | null>(null);
  const questions = useRef(0);
  // Provider work still in flight: committed speech awaiting its transcript, and open responses.
  // "End" waits for both, so the last turn isn't cut off by closing the call.
  const pending = useRef(new Set<string>());
  // A provider turn that failed (not cancelled) leaves a hole: the transcript then counts as incomplete.
  const lost = useRef(false);
  // Finalized provider items already recorded; the same item must never become two seqs.
  const seen = useRef(new Set<string>());
  // Bumped on every start: callbacks of an earlier call or save must not touch the new session.
  const gen = useRef(0);
  const asks = useRef(0);
  const [lastTurnMissing, setLastTurnMissing] = useState(false);
  const giveUp = useRef(false);
  // The commit End sent for speech the provider's VAD can no longer hear finish.
  const endCommit = useRef<string | null>(null);
  const waitSince = useRef(0);
  const [endWait, setEndWait] = useState({ note: "", seconds: 0 });
  const [endTimings, setEndTimings] = useState<EndTimings | null>(null);
  const [connectionLost, setConnectionLost] = useState(false);
  const callLost = useRef(false);
  const callClosed = useRef(true);
  const finalizing = useRef(false);
  const finishing = useRef(false);
  const stopWatching = useRef<(() => void) | null>(null);
  const callAbort = useRef<AbortController | null>(null);
  const pc = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const mic = useRef<MediaStream | null>(null);
  // Muted: the mic track sends silence, so room talk can't start a turn; typing still works.
  const [muted, setMuted] = useState(false);
  // The interviewer's camera: shown to them in the popup and sent to the persona as still frames.
  const [cam, setCam] = useState<MediaStream | null>(null);
  const camStream = useRef<MediaStream | null>(null);
  const cameraItem = useRef<string | null>(null);
  const cameraSeq = useRef(0);
  const cameraPaused = useRef(false);
  const cameraDelete = useRef<{ itemId: string; eventId: string; resolve: (removed: boolean) => void } | null>(null);
  const camView = useRef<HTMLVideoElement>(null);
  const [camNote, setCamNote] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  // The persona's voice track; the avatar lip-syncs it and then plays it instead of <audio>.
  const [voice, setVoice] = useState<MediaStreamTrack | null>(null);
  const [avatarOn, setAvatarOn] = useState(false);
  const avatar = useRef<AvatarControl | null>(null);
  const sessionId = useRef<string | null>(null);
  // When the interviewer stopped talking (or sent text); the gap to the first persona audio is latency.
  const askedAt = useRef<number | null>(null);

  const dialog = useRef<HTMLDialogElement>(null);
  const transcript = useRef<HTMLOListElement>(null);
  const [liveSeconds, setLiveSeconds] = useState(0);

  // Never leave the microphone or the call open when the card goes away.
  useEffect(() => () => {
    gen.current += 1;
    hangUp();
  }, []);

  // The call runs in a popup; it closes once the call is over and the result shows on the page.
  const inCall = !connectionLost && (phase === "connecting" || phase === "live" || phase === "ending" || phase === "waiting" || phase === "saving");
  useEffect(() => {
    const d = dialog.current;
    if (inCall && !d?.open) d?.showModal();
    if (!inCall && d?.open) d.close();
  }, [inCall]);

  useEffect(() => {
    if (camView.current) camView.current.srcObject = cam;
  }, [cam]);

  // The persona sees the interviewer: a frame now and every CAMERA_FRAME_MS, added as context only
  // (no response.create), so it shapes the next answer without making the persona talk.
  useEffect(() => {
    if (phase !== "live" || !cam) return;
    const g = gen.current;
    let cancelled = false;
    let busy = false;
    const current = () => !cancelled && g === gen.current && !callClosed.current && camStream.current === cam;
    const send = async () => {
      if (busy || cameraPaused.current || !current()) return;
      busy = true;
      try {
        const image = await captureFrame(cam);
        if (!current()) return;
        const dc = channel.current;
        if (dc?.readyState !== "open") return;
        const previous = cameraItem.current;
        if (previous) {
          // Do not add another image until the old one is confirmed gone. A failed/slow
          // deletion pauses camera updates instead of growing the context indefinitely.
          const eventId = `cam_delete_${g}_${++cameraSeq.current}`;
          const removed = await new Promise<boolean>((resolve) => {
            const done = (ok: boolean) => {
              clearTimeout(timer);
              if (cameraDelete.current?.eventId === eventId) cameraDelete.current = null;
              resolve(ok);
            };
            const timer = setTimeout(() => done(false), 5_000);
            cameraDelete.current = { itemId: previous, eventId, resolve: done };
            try {
              dc.send(JSON.stringify({ type: "conversation.item.delete", item_id: previous, event_id: eventId }));
            } catch {
              done(false);
            }
          });
          if (!current()) return;
          if (!removed) {
            cameraPaused.current = true;
            setCamNote("Camera updates paused: the previous image could not be removed. Voice still works.");
            return;
          }
          cameraItem.current = null;
        }
        const itemId = `cam_${g}_${++cameraSeq.current}`;
        cameraItem.current = itemId;
        dc.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              id: itemId,
              type: "message",
              role: "user",
              content: [
                { type: "input_text", text: "(Camera view of the interviewer right now. Do not comment on it unless it matters.)" },
                { type: "input_image", image_url: image },
              ],
            },
          }),
        );
      } catch {
        // A missed frame is fine; the next one follows.
      } finally {
        busy = false;
      }
    };
    void send();
    const id = setInterval(send, CAMERA_FRAME_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      cameraDelete.current?.resolve(false);
    };
  }, [phase, cam]);

  // A visible clock while live (interviews run 20–30 min).
  useEffect(() => {
    if (phase !== "live") return;
    const id = setInterval(() => setLiveSeconds(Math.floor((Date.now() - liveSince.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase]);

  // While End is in progress, say what it is waiting for and for how long.
  useEffect(() => {
    if (phase !== "ending" && phase !== "waiting" && phase !== "saving") return;
    const id = setInterval(
      () => setEndWait({ note: pendingNote(pending.current), seconds: Math.floor((performance.now() - waitSince.current) / 1000) }),
      500,
    );
    return () => clearInterval(id);
  }, [phase]);

  // Keep the newest turn visible; only the transcript box scrolls, never the page.
  useEffect(() => {
    const el = transcript.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length]);

  function hangUp() {
    callClosed.current = true;
    cameraDelete.current?.resolve(false);
    stopWatching.current?.();
    stopWatching.current = null;
    callAbort.current?.abort();
    callAbort.current = null;
    if (channel.current) channel.current.onmessage = null;
    if (pc.current) pc.current.ontrack = null;
    mic.current?.getTracks().forEach((t) => t.stop());
    camStream.current?.getTracks().forEach((t) => t.stop());
    channel.current?.close();
    pc.current?.close();
    mic.current = camStream.current = channel.current = pc.current = null;
    if (audio.current) audio.current.srcObject = null;
    setVoice(null);
    setCam(null);
    setMuted(false);
  }

  function loseConnection(g: number) {
    if (g !== gen.current || callClosed.current) return;
    callLost.current = true;
    setConnectionLost(true);
    // Freeze the transcript before another queued callback can claim a missing turn arrived.
    if (pending.current.size > 0) lost.current = true;
    hangUp();
    void end();
  }

  function onEvent(e: ServerEvent) {
    switch (e.type) {
      case "conversation.item.deleted":
        if (e.item_id === cameraDelete.current?.itemId) cameraDelete.current?.resolve(true);
        break;
      case "input_audio_buffer.speech_stopped":
        askedAt.current = performance.now();
        break;
      case "output_audio_buffer.started":
        if (askedAt.current !== null) {
          const ms = performance.now() - askedAt.current;
          setMetrics((m) => ({ ...m, latenciesMs: [...m.latenciesMs, ms] }));
          askedAt.current = null;
        }
        break;
      case "input_audio_buffer.speech_started":
        // The interviewer talks over the persona: stop the avatar's queued mouth movement too.
        avatar.current?.clear();
        pending.current.add("speech");
        break;
      case "input_audio_buffer.committed":
        // A repeat says nothing about the speech reserved now, which may be a newer turn.
        if (!once(`c:${e.item_id}`)) break;
        pending.current.delete("speech");
        endCommit.current = null;
        // Already settled (out of order): this commit must not reopen a turn that can't finish again.
        if (e.item_id && !seen.current.has(`t:${e.item_id}`)) pending.current.add(`t:${e.item_id}`);
        break;
      case "conversation.item.input_audio_transcription.failed":
        if (e.item_id) pending.current.delete(`t:${e.item_id}`);
        once(`t:${e.item_id}`);
        lost.current = true;
        break;
      case "response.created": {
        // A repeat acknowledges nothing new: the waiting typed question belongs to a later response.
        if (!once(`rc:${e.response?.id}`)) break;
        // The oldest typed question waiting for its answer is now acknowledged by a real response.
        const ask = [...pending.current].find((k) => k.startsWith("a:"));
        if (ask) pending.current.delete(ask);
        if (e.response?.id && !seen.current.has(`r:${e.response.id}`)) pending.current.add(`r:${e.response.id}`);
        break;
      }
      case "conversation.item.input_audio_transcription.completed":
        if (e.item_id) pending.current.delete(`t:${e.item_id}`);
        if (once(`t:${e.item_id}`) && e.transcript?.trim()) addTurn("interviewer", e.transcript.trim());
        break;
      case "response.output_audio_transcript.done":
        if (e.transcript?.trim() && once(`o:${e.item_id}:${e.content_index}`)) addTurn("persona", e.transcript.trim());
        break;
      case "response.done": {
        if (e.response?.id) pending.current.delete(`r:${e.response.id}`);
        if (!once(`r:${e.response?.id}`)) break;
        if (e.response?.status === "failed" || e.response?.status === "incomplete") lost.current = true;
        const usage = e.response?.usage;
        setMetrics((m) => ({
          ...m,
          inputTokens: m.inputTokens + (usage?.input_tokens ?? 0),
          outputTokens: m.outputTokens + (usage?.output_tokens ?? 0),
        }));
        // Interrupted answers end as "cancelled": keep them visible but marked, never silently dropped.
        if (e.response?.status === "cancelled") {
          setTurns((t) => [...t, { who: "persona", text: "(interrupted)", cancelled: true }]);
        }
        break;
      }
      case "error": {
        const removal = cameraDelete.current;
        if (removal && e.error?.event_id === removal.eventId) {
          // Only an explicitly missing camera item is benign; other errors stay visible.
          const message = e.error.message ?? "";
          const missing = new RegExp(`^(?:Conversation )?Item(?: with ID)? ['"]?${removal.itemId}['"]? (?:not found|does not exist|already deleted)[.!]?$`, "i").test(message);
          removal.resolve(missing);
          if (missing) break;
        }
        if (e.error?.event_id?.startsWith("end_commit_")) {
          endCommit.current = null;
          // A natural commit can win the race and empty the buffer: then nothing is missing. If speech
          // is still reserved, it was heard but can't be transcribed, so the transcript has a hole.
          if (pending.current.delete("speech")) lost.current = true;
          break;
        }
        // A rejected response.create (e.g. one is already running) will never get a response:
        // release its reservation so "End" doesn't wait for an answer that can't come.
        if (e.error?.event_id?.startsWith("a:")) pending.current.delete(e.error.event_id);
        setError(e.error?.message ?? "Realtime error");
        break;
      }
    }
  }

  // True the first time a provider item is seen. Events without an id are always new.
  function once(key: string) {
    if (key.includes("undefined")) return true;
    if (seen.current.has(key)) return false;
    seen.current.add(key);
    return true;
  }

  function addTurn(who: Speaker, text: string) {
    setTurns((t) => [...t, { who, text }]);
    record("utterance", { speaker: who, text });
  }

  function record(type: "utterance" | "session.ended", data: object) {
    const sid = sessionId.current;
    if (!sid) return;
    // Built once and kept: a retry must resend the exact same event, or the backend answers 409.
    events.current.push({
      sessionId: sid,
      seq: events.current.length + 1,
      at: new Date().toISOString(),
      type,
      data,
    } as SessionEvent);
    setSaveState((st) => ({ ...st, total: events.current.length }));
    void flush();
  }

  // Send everything not yet confirmed, one request at a time so seqs arrive in order.
  // Resolves true once every recorded event is stored.
  async function flush(): Promise<boolean> {
    const sid = sessionId.current;
    const g = gen.current;
    while (sid && g === gen.current && saved.current < events.current.length) {
      if (sending.current) {
        await sending.current;
        continue;
      }
      const batch = events.current.slice(saved.current);
      let ok = false;
      const request: Promise<void> = api
        .postEvents(sid, batch)
        .then(() => {
          if (g !== gen.current) return; // an answer for an earlier session
          saved.current += batch.length;
          ok = true;
        })
        .catch(() => {})
        .finally(() => {
          if (sending.current === request) sending.current = null;
          if (g === gen.current) setSaveState({ saved: saved.current, total: events.current.length, failed: !ok });
        });
      sending.current = request;
      await request;
      // Keep the unsent rest for the next turn or the final save instead of hammering the API.
      if (!ok) return false;
    }
    return true;
  }

  async function start() {
    hangUp();
    setPhase("connecting");
    setError(null);
    setTurns([]);
    setVoice(null);
    setMetrics({ latenciesMs: [], inputTokens: 0, outputTokens: 0 });
    gen.current += 1;
    const g = gen.current;
    callClosed.current = false;
    callLost.current = false;
    finalizing.current = finishing.current = false;
    setConnectionLost(false);
    const abort = new AbortController();
    callAbort.current = abort;
    const current = () => g === gen.current && !callClosed.current;
    sessionId.current = null;
    liveSince.current = Date.now();
    cameraItem.current = null;
    cameraSeq.current = 0;
    cameraPaused.current = false;
    events.current = [];
    saved.current = 0;
    setEnded(null);
    sending.current = null;
    seen.current.clear();
    lost.current = false;
    pending.current.clear();
    giveUp.current = false;
    endCommit.current = null;
    setEndTimings(null);
    setLastTurnMissing(false);
    setSaveState({ saved: 0, total: 0, failed: false });
    try {
      const interviewGuide = guide
        .split("\n")
        .map((q) => q.trim())
        .filter(Boolean);
      questions.current = interviewGuide.length;
      const session = await api.createSession({ personaId: persona.id, interviewGuide });
      if (!current()) return;
      sessionId.current = session.id;
      const token = await api.sessionToken(session.id);
      if (!current()) return;
      if (!token.token || !token.url) throw new Error("no realtime token");

      const conn = new RTCPeerConnection();
      pc.current = conn;
      conn.ontrack = (ev) => {
        if (!current()) return;
        if (audio.current) audio.current.srcObject = ev.streams[0];
        setVoice(ev.track);
      };
      // Ask the browser to filter echo and room noise (ideal values: ignored where unsupported).
      const microphone = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true },
      });
      if (!current()) {
        microphone.getTracks().forEach((t) => t.stop());
        return;
      }
      mic.current = microphone;
      mic.current.getTracks().forEach((t) => conn.addTrack(t, mic.current!));
      // The camera is a bonus: without it the interview still runs, voice only.
      setCamNote(null);
      try {
        const camera = await navigator.mediaDevices.getUserMedia({ video: true });
        if (!current()) {
          camera.getTracks().forEach((t) => t.stop());
          return;
        }
        camStream.current = camera;
        setCam(camera);
      } catch {
        if (!current()) return;
        setCamNote("Camera is off (blocked or not available). The persona only hears you.");
      }
      const dc = conn.createDataChannel("oai-events");
      channel.current = dc;
      dc.onmessage = (m) => current() && onEvent(JSON.parse(m.data));
      stopWatching.current = watchConnection(conn, dc, () => loseConnection(g));
      if (!current()) return;

      const offer = await conn.createOffer();
      if (!current()) return;
      await conn.setLocalDescription(offer);
      if (!current()) return;
      const answer = await fetch(token.url, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/sdp" },
        signal: abort.signal,
      });
      if (!answer.ok) throw new Error(`OpenAI refused the call (${answer.status})`);
      const sdp = await answer.text();
      if (!current()) return;
      await conn.setRemoteDescription({ type: "answer", sdp });
      if (!current()) return;
      // Only "live" once events can flow both ways, so an early typed question isn't dropped.
      if (dc.readyState !== "open") await new Promise<void>((resolve, reject) => {
        const opened = () => { cleanup(); resolve(); };
        const cancelled = () => { cleanup(); reject(new Error("Call closed")); };
        const cleanup = () => {
          dc.removeEventListener("open", opened);
          abort.signal.removeEventListener("abort", cancelled);
        };
        dc.addEventListener("open", opened, { once: true });
        abort.signal.addEventListener("abort", cancelled, { once: true });
        if (abort.signal.aborted) cancelled();
      });
      if (!current()) return;
      await api.updateSession(session.id, { status: "live" });
      if (!current()) return;
      liveSince.current = Date.now();
      setLiveSeconds(0);
      setPhase("live");
    } catch (e) {
      if (!current()) return;
      hangUp();
      setPhase("error");
      if (e instanceof DOMException && e.name === "NotAllowedError") setError("Microphone access was denied.");
      else if (e instanceof ApiError) setError(`Could not start (${e.status}): ${e.detail}`);
      else setError(e instanceof Error ? e.message : "Could not start the interview.");
    }
  }

  // Sends interviewer content (typed text or a screen frame) and asks the persona to answer it.
  // Every path goes through here so "End" always waits for the answer it triggered.
  function askWith(content: object[]): boolean {
    const dc = channel.current;
    if (!dc || dc.readyState !== "open") return false;
    dc.send(JSON.stringify({ type: "conversation.item.create", item: { type: "message", role: "user", content } }));
    // Registered before sending, so "End" waits for this answer even before the provider confirms it.
    const ask = `a:${++asks.current}`;
    pending.current.add(ask);
    // The id comes back in an "error" event if the provider rejects this request.
    dc.send(JSON.stringify({ type: "response.create", event_id: ask }));
    askedAt.current = performance.now();
    return true;
  }

  // Typed question: a fallback when the room is noisy, and the same path the pilot uses.
  function ask() {
    const text = typed.trim();
    if (!text || !askWith([{ type: "input_text", text }])) return;
    addTurn("interviewer", text);
    setTyped("");
  }

  // Hypothesis from #99, not verified against the provider: with the mic off, VAD may never see this
  // speech end. So commit it, only while speech is really reserved (the provider rejects an empty
  // commit). Whether a commit under semantic_vad also starts a response is unmeasured; if it does,
  // that response is reserved like any other and End waits for it.
  function commitSpeech() {
    const dc = channel.current;
    if (!pending.current.has("speech") || endCommit.current || dc?.readyState !== "open") return;
    const eventId = `end_commit_${++asks.current}`;
    endCommit.current = eventId;
    dc.send(JSON.stringify({ type: "input_audio_buffer.commit", event_id: eventId }));
  }

  async function end() {
    if (finalizing.current) return;
    finalizing.current = true;
    const g = gen.current;
    const since = performance.now();
    waitSince.current = since;
    setEndWait({ note: pendingNote(pending.current), seconds: 0 });
    setPhase("ending");
    // Capture stops now (screen sharing with the live controls); the call stays open only so the
    // provider can deliver every transcript and answer it started, so the last turn isn't cut off.
    mic.current?.getTracks().forEach((t) => t.stop());
    camStream.current?.getTracks().forEach((t) => t.stop());
    setCam(null);
    // No time limit: unresolved work is never dropped automatically, the interviewer decides.
    while (pending.current.size > 0 && !giveUp.current && !callLost.current && g === gen.current) {
      const waited = performance.now() - since;
      if (waited >= COMMIT_DELAY_MS) commitSpeech();
      if (waited >= DRAIN_PATIENCE_MS) setPhase("waiting");
      await sleep(200);
    }
    if (g !== gen.current) return;
    setEndTimings({ drainMs: performance.now() - since });
    const incomplete = pending.current.size > 0 || lost.current;
    setLastTurnMissing(incomplete);
    hangUp();
    // No end marker for an incomplete transcript: the backend then refuses a debrief (409) on its own.
    if (!incomplete) {
      record("session.ended", { durationSeconds: Math.round((Date.now() - liveSince.current) / 1000) });
    }
    await finish();
  }

  // A finite retry budget; false once it is spent or a newer session took over.
  async function retry(g: number, step: () => Promise<boolean>) {
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt++) {
      if (attempt) await sleep(1000 * attempt);
      if (g !== gen.current) return false;
      if (await step()) return true;
    }
    return false;
  }

  // The session is only marked ended once the whole transcript, marker included, is stored.
  async function finish() {
    if (finishing.current) return;
    finishing.current = true;
    const g = gen.current;
    const sid = sessionId.current;
    let since = performance.now();
    waitSince.current = since;
    setEndWait({ note: "", seconds: 0 });
    setPhase("saving");
    setError(null);
    try {
      const stored = await retry(g, flush);
      if (g !== gen.current) return;
      if (!stored) throw new Error("transcript not saved");
      const saveMs = performance.now() - since;
      setEndTimings((t) => ({ ...t, saveMs }));
      if (sid) {
        since = performance.now();
        // Repeating "ended" is a no-op on the backend, so a timed-out PATCH is safe to resend. No need
        // to wait for startup's "live": the backend refuses it once "ended" is stored.
        const closed = await retry(g, () => api.updateSession(sid, { status: "ended" }, SAVE_TIMEOUT_MS).then(() => true, () => false));
        if (g !== gen.current) return;
        if (!closed) throw new Error("session not closed");
        const closeMs = performance.now() - since;
        setEndTimings((t) => ({ ...t, closeMs }));
        if (!lost.current && pending.current.size === 0) setEnded({ id: sid, questions: questions.current });
      }
      setPhase("ended");
    } catch {
      if (g !== gen.current) return;
      setPhase("unsaved");
      setError(`Could not finish saving (${saved.current}/${events.current.length} events stored). The call is closed. Choose Save again to retry.`);
    } finally {
      if (g === gen.current) finishing.current = false;
    }
  }

  const avgMs = metrics.latenciesMs.length
    ? Math.round(metrics.latenciesMs.reduce((a, b) => a + b, 0) / metrics.latenciesMs.length)
    : null;
  const showAvatar = voice !== null && sessionId.current !== null && (phase === "live" || phase === "ending" || phase === "waiting");

  const btn = "rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-muted";
  const errorBox = error && (
    <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      {error}
    </p>
  );
  const saveLine = saveState.total > 0 && (
    <p className="mt-2 text-xs tabular-nums text-muted" data-testid="save-state">
      Transcript saved {saveState.saved}/{saveState.total}
      {phase === "live" && saveState.failed && saveState.saved < saveState.total
        ? " · not saved yet, retrying with the next turn"
        : ""}
    </p>
  );

  return (
    <section className="mt-8 rounded-xl border border-line bg-background/60 p-5" data-testid="interview-room">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted">Voice interview</h3>
        {(phase === "idle" || phase === "ended" || phase === "error") && (
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface hover:opacity-90"
            onClick={start}
          >
            {phase === "idle" ? "Start voice interview" : "Start again"}
          </button>
        )}
        {inCall && <span className="text-sm text-muted">Interview running in the popup…</span>}
        {phase === "ended" && (
          <span className="text-sm text-muted">
            {lastTurnMissing
              ? "Ended without the last turn. This transcript is incomplete, so there is no debrief for it."
              : "Ended. Microphone and camera are off, transcript saved."}
          </span>
        )}
        {phase === "unsaved" && (
          <button type="button" className={btn} onClick={finish}>
            Save again
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">
        You are talking to an AI persona ({persona.name}), not a real person. It hears you and sees your camera.
        {" "}If you allow camera access, an image is sent to OpenAI every 15 seconds so the persona can see you.
      </p>
      {connectionLost && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200" data-testid="connection-lost">
          Connection lost. Microphone, camera and screen sharing are off.
          {lastTurnMissing ? " This transcript is incomplete; no debrief will be generated." : ""}
          {phase === "saving" ? " Saving captured turns…" : phase === "unsaved"
            ? " Save the captured turns before starting again."
            : " Start again begins a new conversation."}
        </p>
      )}
      {(phase === "idle" || phase === "ended" || phase === "error") && (
        <label className="mt-3 block text-sm">
          <span className="text-muted">Interview questions, one per line (the debrief answers these)</span>
          <textarea
            className="mt-1 h-20 w-full rounded-md border border-line bg-surface p-2 text-sm"
            value={guide}
            onChange={(e) => setGuide(e.target.value)}
          />
        </label>
      )}
      {!inCall && saveLine}
      {!inCall && errorBox}

      {/* Plays the persona's voice once; the microphone is never routed back to the speakers. */}
      {/* Stays attached even while muted: Chrome only feeds remote audio to the avatar then. */}
      <audio ref={audio} autoPlay muted={avatarOn} />

      <dialog
        ref={dialog}
        aria-label={`Interview with ${persona.name}`}
        className="m-auto w-[min(64rem,calc(100%-2rem))] max-h-[calc(100dvh-2rem)] overflow-y-auto rounded-xl border border-line bg-surface p-5 text-foreground shadow-xl backdrop:bg-black/60"
        // Esc must not silently drop a running call; ending goes through "End interview".
        onCancel={(e) => e.preventDefault()}
        onClose={() => inCall && dialog.current?.showModal()}
      >
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="font-semibold">{persona.name}</h3>
          {phase === "connecting" && <span className="text-sm text-muted">Connecting…</span>}
          {phase === "live" && (
            <>
              <span className="flex items-center gap-2 text-sm font-medium text-accent">
                <span aria-hidden className="size-2 animate-pulse rounded-full bg-accent" />
                Live, speak now
                <span className="font-normal tabular-nums text-muted">
                  {Math.floor(liveSeconds / 60)}:{String(liveSeconds % 60).padStart(2, "0")}
                </span>
              </span>
              <button type="button" className={btn} onClick={end}>
                End interview
              </button>
              <button
                type="button"
                className={btn}
                aria-pressed={muted}
                onClick={() => {
                  mic.current?.getAudioTracks().forEach((t) => (t.enabled = muted));
                  setMuted(!muted);
                }}
              >
                {muted ? "Unmute mic" : "Mute mic"}
              </button>
              {muted && <span className="text-sm text-muted">Mic muted, type your question instead.</span>}
              <ScreenShareButton pc={pc} ask={askWith} />
            </>
          )}
          {(phase === "ending" || phase === "waiting") && (
            <span className="text-sm text-muted tabular-nums" data-testid="end-wait">
              {endWait.note}… {endWait.seconds}s
            </span>
          )}
          {phase === "waiting" && (
            <>
              <span className="text-sm text-muted">
                This is taking longer than usual. You can keep waiting, or close now: the transcript stays incomplete and gets no debrief.
              </span>
              <button type="button" className={btn} onClick={() => (giveUp.current = true)}>
                Close with incomplete transcript
              </button>
            </>
          )}
          {phase === "saving" && (
            <span className="text-sm text-muted tabular-nums">Saving transcript… {endWait.seconds}s</span>
          )}
        </div>

        <div className="mt-4 grid items-start gap-4 sm:grid-cols-[minmax(0,16rem)_1fr]">
          <div className="space-y-3">
            {showAvatar && sessionId.current && voice && (
              <Avatar
                sessionId={sessionId.current}
                track={voice}
                onActive={(control) => {
                  avatar.current = control;
                  setAvatarOn(control !== null);
                }}
              />
            )}
            {/* Mirrored like a video call self-view; the persona gets the unmirrored frames. */}
            <video
              ref={camView}
              autoPlay
              muted
              playsInline
              aria-label="Your camera"
              className={`aspect-video w-full -scale-x-100 rounded-lg bg-black object-cover ${cam ? "" : "hidden"}`}
            />
            {camNote && <p className="text-xs text-muted">{camNote}</p>}
          </div>
          <ol ref={transcript} className="max-h-[28rem] space-y-2 overflow-y-auto pr-1 text-sm" data-testid="transcript">
            {turns.length === 0 && phase === "live" && <li className="text-muted">Say hello to start.</li>}
            {turns.map((t, i) => (
              <li
                key={i}
                className={`w-fit max-w-[85%] rounded-lg px-3 py-2 leading-relaxed wrap-anywhere ${
                  t.who === "persona" ? "border border-line bg-surface" : "ml-auto bg-accent-soft"
                } ${t.cancelled ? "opacity-50" : ""}`}
              >
                <span className="mb-0.5 block text-xs font-medium text-muted">
                  {t.who === "persona" ? persona.name : "You"}
                </span>
                {t.text}
              </li>
            ))}
          </ol>
        </div>

        {phase === "live" && (
          <div className="mt-3 flex gap-2">
            <input
              aria-label="Type a question"
              className="min-w-0 flex-1 rounded-md border border-line bg-surface px-3 py-1.5 text-sm"
              placeholder="…or type a question"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && ask()}
            />
            <button type="button" className={btn} onClick={ask}>
              Ask
            </button>
          </div>
        )}
        {inCall && saveLine}
        {inCall && errorBox}
      </dialog>

      {(phase === "ended" || (connectionLost && !inCall)) && turns.length > 0 && (
        <details className="mt-4 text-sm" open={connectionLost}>
          <summary className="cursor-pointer text-muted">Transcript ({turns.length} turns)</summary>
          <ol className="mt-2 space-y-1">
            {turns.map((t, i) => (
              <li key={i} className={t.cancelled ? "opacity-50" : ""}>
                <span className="font-medium">{t.who === "persona" ? persona.name : "You"}:</span> {t.text}
              </li>
            ))}
          </ol>
        </details>
      )}
      {(metrics.latenciesMs.length > 0 || metrics.outputTokens > 0) && (
        <p className="mt-3 text-xs tabular-nums text-muted" data-testid="metrics">
          Latency to first audio: {avgMs ?? "–"} ms avg over {metrics.latenciesMs.length} turns · tokens in{" "}
          {metrics.inputTokens} / out {metrics.outputTokens}
        </p>
      )}
      {endTimings && (
        <p className="mt-1 text-xs tabular-nums text-muted" data-testid="end-timings">
          End call: provider finished {seconds(endTimings.drainMs)} · events saved {seconds(endTimings.saveMs)} · session closed {seconds(endTimings.closeMs)}
        </p>
      )}
      {phase === "ended" && ended && ended.questions > 0 && !lastTurnMissing && (
        <DebriefView key={ended.id} sessionId={ended.id} personaName={persona.name} />
      )}
      {phase === "ended" && ended && ended.questions === 0 && (
        <p className="mt-4 text-sm text-muted">
          No debrief: this interview had no interview questions. Add some above and start again.
        </p>
      )}
    </section>
  );
}
