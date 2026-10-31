"use client";

import { useEffect, useRef, useState } from "react";
import { Avatar, type AvatarControl } from "@/components/Avatar";
import { DebriefView } from "@/components/DebriefView";
import { GuideCheck } from "@/components/GuideCheck";
import { ScreenShareButton, ScreenSharePreview, frameBudget } from "@/components/ScreenShareButton";
import { ZoomStage } from "@/components/ZoomStage";
import { ApiError, api } from "@/lib/api";
import { captureFrame } from "@/lib/screenFrames";
import { watchConnection } from "@/lib/useConnectionWatch";
import type { Persona, SessionEvent } from "@/lib/contracts";
import { DRAIN_ATTEMPT_MS, SAVE_ATTEMPTS, TranscriptWork, drainDescription } from "@/lib/transcriptFinalization";
import { sampleTurns } from "@/lib/sample";

// Video interview pilot: the browser talks to OpenAI Realtime over WebRTC with a short-lived
// client secret from our backend. Our backend never holds the audio connection.

type Turn = { who: "interviewer" | "persona"; text: string; cancelled?: boolean };
type Phase = "idle" | "sample" | "connecting" | "live" | "ending" | "waiting" | "ended" | "unsaved" | "error";
type Speaker = "interviewer" | "persona";
type Metrics = { latenciesMs: number[]; inputTokens: number; outputTokens: number };

// How often the persona gets a fresh look at the interviewer's camera.
const CAMERA_FRAME_MS = 15_000;
// While the prototype is shared it replaces the camera, refreshed faster so navigation shows up.
const SCREEN_FRAME_MS = 10_000;
// Permission prompts, token, SDP and channel setup can all hang; give up after this long.
const START_TIMEOUT_MS = 45_000;
// The persona prompt (realtime.py) keys on this exact label; keep them in sync.
const SCREEN_LABEL = "(Interviewer's shared screen, the prototype, right now.)";

// Realtime server events we act on (subset of the GA event list).
type ServerEvent = {
  type: string;
  item_id?: string;
  response_id?: string;
  content_index?: number;
  transcript?: string;
  response?: {
    id?: string;
    status?: string;
    output?: { id?: string; content?: { type: string; transcript?: string; text?: string }[] }[];
    usage?: { input_tokens?: number; output_tokens?: number };
  };
  error?: { message?: string; event_id?: string };
};

export function InterviewRoom({
  persona,
  startBlocked,
  initialGuide = "",
  questionsRequired = true,
}: {
  persona: Persona;
  startBlocked: boolean;
  /** Questions the debrief will answer. Empty for a saved persona, so the sample sprint questions never come back. */
  initialGuide?: string;
  /** False for the short test call on the persona tab: no debrief questions needed. */
  questionsRequired?: boolean;
}) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [metrics, setMetrics] = useState<Metrics>({ latenciesMs: [], inputTokens: 0, outputTokens: 0 });
  const [typed, setTyped] = useState("");
  const [guide, setGuide] = useState(initialGuide);
  // Transcript persistence: every finalized turn becomes an event with the next seq. The browser is
  // the only writer, so events[] is the truth and `saved` is how many the backend has confirmed.
  const events = useRef<SessionEvent[]>([]);
  const saved = useRef(0);
  const sending = useRef<Promise<void> | null>(null);
  const [saveState, setSaveState] = useState({ saved: 0, total: 0, failed: false });
  const liveSince = useRef(0);
  const liveEstablished = useRef(false);
  const startupFailure = useRef<string | null>(null);
  // The session the debrief is for, set once its transcript is fully saved and it is marked ended.
  const [ended, setEnded] = useState<{ id: string; questions: number; sample?: boolean } | null>(null);
  const questions = useRef(0);
  // Provider work still in flight: committed speech awaiting its transcript, and open responses.
  // "End" waits for both, so the last turn isn't cut off by closing the call.
  const work = useRef(new TranscriptWork());
  const pending = useRef(work.current.pending);
  const providerActivity = useRef(0);
  const finalProviderAt = useRef<number | null>(null);
  const endStarted = useRef<number | null>(null);
  const drainStarted = useRef(0);
  const commitAttempted = useRef(false);
  const durationSeconds = useRef(0);
  const [finalStage, setFinalStage] = useState("Checking the final provider events");
  const [endSeconds, setEndSeconds] = useState(0);
  const retryBatch = useRef<{ events: SessionEvent[]; attempts: number } | null>(null);
  // A provider turn that failed (not cancelled) leaves a hole: the saved transcript is marked as having gaps.
  const lost = useRef(false);
  // Finalized provider items already recorded; the same item must never become two seqs.
  const seen = useRef(new Set<string>());
  // Bumped on every start: callbacks of an earlier call or save must not touch the new session.
  const gen = useRef(0);
  const asks = useRef(0);
  const [lastTurnMissing, setLastTurnMissing] = useState(false);
  const [connectionLost, setConnectionLost] = useState(false);
  const callLost = useRef(false);
  const callClosed = useRef(true);
  const finalizing = useRef(false);
  const finishing = useRef(false);
  const draining = useRef(false);
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
  const [screenShare, setScreenShare] = useState<MediaStream | null>(null);
  const screenShareRef = useRef<MediaStream | null>(null);
  // When the last screen image went out (in liveSeconds), or why it failed; shown while sharing.
  const [screenSentAt, setScreenSentAt] = useState<number | null>(null);
  const [screenNote, setScreenNote] = useState<string | null>(null);
  const startTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [camNote, setCamNote] = useState<string | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  // The persona's voice track; the avatar lip-syncs it and then plays it instead of <audio>.
  const [voice, setVoice] = useState<MediaStreamTrack | null>(null);
  const [avatarOn, setAvatarOn] = useState(false);
  // The interviewer's off switch. Unmounting the avatar releases it and hands the voice back to <audio>.
  const [avatarOff, setAvatarOff] = useState(false);
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
  const inCall = !connectionLost && (phase === "connecting" || phase === "live" || phase === "ending" || phase === "waiting");
  useEffect(() => {
    const d = dialog.current;
    if (inCall && !d?.open) d?.showModal();
    if (!inCall && d?.open) d.close();
  }, [inCall]);

  useEffect(() => {
    if (camView.current) camView.current.srcObject = cam;
  }, [cam]);

  // The persona sees one image at a time: the shared prototype while sharing, else the camera.
  // A frame now and then on a timer, added as context only (no response.create), so it shapes the
  // next answer without making the persona talk. Each new frame replaces the previous one.
  const view = screenShare ?? cam;
  useEffect(() => {
    if (phase !== "live" || !view) return;
    const isScreen = view === screenShare;
    const g = gen.current;
    let cancelled = false;
    let busy = false;
    const current = () => !cancelled && g === gen.current && !callClosed.current && (isScreen || camStream.current === view);
    const send = async () => {
      if (busy || cameraPaused.current || !current()) return;
      busy = true;
      try {
        const image = await captureFrame(view, { maxBytes: frameBudget(pc.current) });
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
            setCamNote("Image updates paused: the previous image could not be removed. Voice still works.");
            return;
          }
          cameraItem.current = null;
        }
        const itemId = `${isScreen ? "screen" : "cam"}_${g}_${++cameraSeq.current}`;
        cameraItem.current = itemId;
        dc.send(
          JSON.stringify({
            type: "conversation.item.create",
            item: {
              id: itemId,
              type: "message",
              role: "user",
              content: [
                {
                  type: "input_text",
                  text: isScreen ? SCREEN_LABEL : "(Camera view of the interviewer right now. Do not comment on it unless it matters.)",
                },
                { type: "input_image", image_url: image },
              ],
            },
          }),
        );
        if (isScreen) {
          setScreenSentAt(Math.floor((Date.now() - liveSince.current) / 1000));
          setScreenNote(null);
        }
      } catch (e) {
        // A missed camera frame is fine; the next one follows. A missed screen frame is shown.
        if (isScreen && current()) {
          setScreenNote(`The last screen image failed (${e instanceof Error ? e.message : "unknown error"}). Retrying.`);
        }
      } finally {
        busy = false;
      }
    };
    void send();
    const id = setInterval(send, isScreen ? SCREEN_FRAME_MS : CAMERA_FRAME_MS);
    return () => {
      cancelled = true;
      clearInterval(id);
      cameraDelete.current?.resolve(false);
    };
  }, [phase, view, screenShare]);

  // A visible clock while live (interviews run 20–30 min).
  useEffect(() => {
    if (phase !== "live") return;
    const id = setInterval(() => setLiveSeconds(Math.floor((Date.now() - liveSince.current) / 1000)), 1000);
    return () => clearInterval(id);
  }, [phase]);

  useEffect(() => {
    if (phase !== "ending" && phase !== "waiting") return;
    const tick = () => {
      setEndSeconds(Math.floor((Date.now() - (endStarted.current ?? Date.now())) / 1000));
      if (!callClosed.current) setFinalStage(drainDescription(pending.current));
    };
    tick();
    const id = setInterval(tick, 200);
    return () => clearInterval(id);
  }, [phase]);

  // Only durations, counts and fixed error classes; never provider payloads or user content.
  function measure(stage: string, since: number, outcome = "ok", until = performance.now()) {
    console.info("Transcript finalization", {
      stage, elapsedMs: Math.max(0, Math.round(until - since)),
      pending: pending.current.size, saved: saved.current, total: events.current.length, outcome,
    });
  }

  // Keep the newest turn visible; only the transcript box scrolls, never the page.
  useEffect(() => {
    const el = transcript.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [turns.length]);

  function hangUp() {
    callClosed.current = true;
    clearTimeout(startTimer.current);
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
    screenShareRef.current = null;
    setScreenShare(null);
    setMuted(false);
  }

  // Sharing started or stopped. On stop, the last screen image leaves the context and the persona is
  // told, so it never describes an old screen as live. Text only: no response.create.
  function sharing(stream: MediaStream | null) {
    const wasSharing = screenShareRef.current !== null;
    screenShareRef.current = stream;
    setScreenShare(stream);
    setScreenSentAt(null);
    setScreenNote(null);
    const dc = channel.current;
    // Ignore null reports when nothing was shared (button mount/unmount must not pollute the call).
    if (stream || !wasSharing || finalizing.current || dc?.readyState !== "open") return;
    try {
      const previous = cameraItem.current;
      if (previous?.startsWith("screen_")) {
        cameraItem.current = null;
        dc.send(JSON.stringify({ type: "conversation.item.delete", item_id: previous }));
      }
      dc.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "(Screen sharing stopped. You no longer see the prototype; do not describe it as if you still see it.)" }],
          },
        }),
      );
    } catch {
      // The channel closed meanwhile; the call is ending anyway.
    }
  }

  function loseConnection(g: number) {
    if (g !== gen.current || callClosed.current) return;
    callLost.current = true;
    setConnectionLost(true);
    // Turns cut off by a drop leave no provider event, so nothing open proves nothing was lost.
    lost.current = true;
    hangUp();
    if (finalizing.current) {
      if (!draining.current) void closeDrained();
    } else void end();
  }

  function onEvent(e: ServerEvent) {
    providerActivity.current = Date.now();
    switch (e.type) {
      case "conversation.item.deleted":
        if (e.item_id === cameraDelete.current?.itemId) cameraDelete.current?.resolve(true);
        break;
      case "input_audio_buffer.speech_stopped":
        work.current.stopped(e.item_id);
        askedAt.current = performance.now();
        break;
      case "output_audio_buffer.started":
        work.current.playback(e.response_id, false);
        if (askedAt.current !== null) {
          const ms = performance.now() - askedAt.current;
          setMetrics((m) => ({ ...m, latenciesMs: [...m.latenciesMs, ms] }));
          askedAt.current = null;
        }
        break;
      case "output_audio_buffer.stopped":
      case "output_audio_buffer.cleared":
        work.current.playback(e.response_id, true);
        break;
      case "input_audio_buffer.speech_started":
        // The interviewer talks over the persona: stop the avatar's queued mouth movement too.
        avatar.current?.clear();
        work.current.speech(e.item_id);
        break;
      case "input_audio_buffer.committed":
        work.current.commit(e.item_id);
        break;
      case "conversation.item.input_audio_transcription.failed":
        work.current.transcribed(e.item_id, true);
        lost.current = true;
        break;
      case "response.created": {
        if (!e.response?.id) lost.current = true;
        work.current.created(e.response?.id);
        break;
      }
      case "conversation.item.input_audio_transcription.completed":
        if (!e.item_id) lost.current = true;
        if (!e.transcript?.trim()) work.current.blank(e.item_id);
        if (work.current.transcribed(e.item_id) && e.transcript?.trim()) addTurn("interviewer", e.transcript.trim());
        break;
      case "response.output_audio_transcript.done":
        if (e.transcript?.trim()) work.current.spoke(e.response_id);
        if (e.transcript?.trim() && once(`o:${e.item_id}:${e.content_index ?? 0}`)) addTurn("persona", e.transcript.trim());
        break;
      case "response.done": {
        if (!e.response?.id || !["completed", "cancelled", "failed", "incomplete"].includes(e.response.status ?? "")) lost.current = true;
        if (!work.current.done(e.response?.id)) break;
        // Reconcile missing transcript.done events from the terminal response output,
        // using the same item/content key, including empty or cancelled answers.
        for (const item of e.response?.output ?? []) {
          item.content?.forEach((content, index) => {
            const text = content.transcript ?? content.text;
            if (text?.trim()) work.current.spoke(e.response?.id);
            if (text?.trim() && once(`o:${item.id}:${index}`)) addTurn("persona", text.trim());
          });
        }
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
          record("utterance", { speaker: "persona", text: "(interrupted)" });
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
        // A rejected response.create (e.g. one is already running) will never get a response:
        // release its reservation so "End" doesn't wait for an answer that can't come.
        if (e.error?.event_id?.startsWith("a:")) pending.current.delete(e.error.event_id);
        setError(e.error?.message ?? "Realtime error");
        break;
      }
    }
    if (finalizing.current) {
      finalProviderAt.current = pending.current.size === 0 ? performance.now() : null;
      // Past the wait limit nothing else rechecks: the last item arriving must still finish the call.
      if (!work.current.missingTurns) void drain();
    }
  }

  // True the first time a provider item is seen. Events without an id are always new.
  function once(key: string) {
    if (key.includes("undefined")) {
      lost.current = true;
      return true;
    }
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
    if (!finalizing.current) {
      // A new live turn can retry an exhausted, idle batch without changing its payload.
      // Events during an active attempt or finalization never replenish that budget.
      if (liveEstablished.current && !sending.current && retryBatch.current && retryBatch.current.attempts >= SAVE_ATTEMPTS) {
        retryBatch.current.attempts = 0;
      }
      void flush();
    }
  }

  // Send everything not yet confirmed, one request at a time so seqs arrive in order.
  // Resolves true once every recorded event is stored.
  async function flush(): Promise<boolean> {
    const sid = sessionId.current;
    const g = gen.current;
    if (!sid) return false;
    if (sending.current) {
      await sending.current;
      if (g !== gen.current) return false;
      return flush();
    }
    if (g !== gen.current) return false;
    if (saved.current >= events.current.length) return true;
    // Keep the failed batch intact even when new turns arrive during its request.
    // Concurrent callers share one finite retry budget for this exact batch.
    const request = (async () => {
      while (g === gen.current && saved.current < events.current.length) {
        const batch = retryBatch.current ?? { events: events.current.slice(saved.current), attempts: 0 };
        retryBatch.current = batch;
        if (batch.attempts >= SAVE_ATTEMPTS) return;
        batch.attempts += 1;
        const requestStarted = performance.now();
        try {
          await api.postEvents(sid, batch.events);
          if (g !== gen.current) return;
          saved.current += batch.events.length;
          retryBatch.current = null;
          setSaveState({ saved: saved.current, total: events.current.length, failed: false });
        } catch (error) {
          if (g !== gen.current) return;
          setSaveState({ saved: saved.current, total: events.current.length, failed: true });
          if (endStarted.current !== null) measure("events", requestStarted, error instanceof Error ? error.name : "Error");
          if (error instanceof ApiError && error.status < 500) batch.attempts = SAVE_ATTEMPTS;
          if (batch.attempts < SAVE_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, 250));
        }
      }
    })();
    sending.current = request;
    try {
      await request;
      return g === gen.current && saved.current === events.current.length;
    } finally {
      if (sending.current === request) sending.current = null;
    }
  }

  async function start() {
    if (startBlocked || (questionsRequired && guide.split("\n").every((q) => !q.trim()))) return;
    hangUp();
    setPhase("connecting");
    startupFailure.current = null;
    liveEstablished.current = false;
    setError(null);
    setTurns([]);
    setVoice(null);
    setMetrics({ latenciesMs: [], inputTokens: 0, outputTokens: 0 });
    gen.current += 1;
    const g = gen.current;
    callClosed.current = false;
    callLost.current = false;
    finalizing.current = finishing.current = draining.current = false;
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
    work.current = new TranscriptWork();
    pending.current = work.current.pending;
    providerActivity.current = Date.now();
    endStarted.current = null;
    commitAttempted.current = false;
    retryBatch.current = null;
    setEndSeconds(0);
    setLastTurnMissing(false);
    setSaveState({ saved: 0, total: 0, failed: false });
    startTimer.current = setTimeout(() => {
      if (!current()) return;
      cancelStart();
      setError("Connecting took too long. Check microphone permission and your network, then start again.");
      setPhase("error");
    }, START_TIMEOUT_MS);
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
      // The camera is a bonus: never awaited, so an unanswered permission prompt can't block voice.
      // Prompts can't be aborted; a grant that lands after cancel, end or a newer call stops at once.
      setCamNote(null);
      navigator.mediaDevices.getUserMedia({ video: true }).then(
        (camera) => {
          // finalizing: End was pressed while the prompt was open; the call is no longer capturing.
          if (!current() || finalizing.current) return camera.getTracks().forEach((t) => t.stop());
          camStream.current = camera;
          setCam(camera);
        },
        () => current() && !finalizing.current && setCamNote("Camera is off (blocked or not available). The persona only hears you."),
      );
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
      clearTimeout(startTimer.current);
      liveSince.current = Date.now();
      setLiveSeconds(0);
      liveEstablished.current = true;
      setPhase("live");
    } catch (e) {
      if (!current()) return;
      startupFailure.current = e instanceof DOMException && e.name === "NotAllowedError"
        ? "Microphone access was denied. Allow microphone access in your browser and start again."
        : e instanceof ApiError ? `Could not start (${e.status}): ${e.detail}`
          : `Could not start: ${e instanceof Error ? e.message : "the interview could not connect."}`;
      setError(startupFailure.current);
      if (sessionId.current) {
        // A failed startup may already have captured turns or mutated remote state.
        // Close as incomplete and preserve the same save/retry path as an ended call.
        lost.current = true;
        finalizing.current = true;
        endStarted.current = Date.now();
        drainStarted.current = performance.now();
        durationSeconds.current = Math.round((Date.now() - liveSince.current) / 1000);
        await closeDrained();
        return;
      }
      hangUp();
      setPhase("error");
    }
  }

  // A startup step can hang with nothing else to press: leave at once so the fallbacks are reachable.
  // The ended status is terminal on the server, so a startup request finishing late can't reopen it.
  function cancelStart() {
    const sid = sessionId.current;
    gen.current += 1;
    hangUp();
    sessionId.current = null;
    setSaveState({ saved: 0, total: 0, failed: false });
    setTurns([]);
    setError(null);
    setPhase("idle");
    if (sid) void api.updateSession(sid, { status: "ended" }).catch(() => {});
  }

  // Demo fallback when the live call can't run: save the scripted transcript as an ended session
  // marked sample, then show its debrief. No token, microphone or provider call is involved.
  async function runSample() {
    if (startBlocked || (questionsRequired && guide.split("\n").every((q) => !q.trim()))) return;
    hangUp();
    gen.current += 1;
    const g = gen.current;
    sessionId.current = null;
    startupFailure.current = null;
    setPhase("sample");
    setError(null);
    setTurns([]);
    setEnded(null);
    setConnectionLost(false);
    setLastTurnMissing(false);
    setSaveState({ saved: 0, total: 0, failed: false });
    setMetrics({ latenciesMs: [], inputTokens: 0, outputTokens: 0 });
    try {
      const interviewGuide = guide
        .split("\n")
        .map((q) => q.trim())
        .filter(Boolean);
      const session = await api.createSession({ personaId: persona.id, interviewGuide, sample: true });
      if (g !== gen.current) return;
      const script = sampleTurns();
      const at = new Date().toISOString();
      await api.postEvents(session.id, [
        ...script.map((data, i) => ({ sessionId: session.id, seq: i + 1, at, type: "utterance" as const, data })),
        { sessionId: session.id, seq: script.length + 1, at, type: "session.ended" as const, data: { durationSeconds: 0 } },
      ]);
      if (g !== gen.current) return;
      await api.updateSession(session.id, { status: "ended" });
      if (g !== gen.current) return;
      setTurns(script.map(({ speaker, text }) => ({ who: speaker, text })));
      setEnded({ id: session.id, questions: interviewGuide.length, sample: true });
      setPhase("ended");
    } catch (e) {
      if (g !== gen.current) return;
      setPhase("error");
      setError(e instanceof ApiError ? `Could not load the sample interview (${e.status}): ${e.detail}` : "Could not load the sample interview: backend not reachable.");
    }
  }

  // Sends interviewer content (typed text or a screen frame) and asks the persona to answer it.
  // Every path goes through here so "End" always waits for the answer it triggered.
  function askWith(content: object[]): boolean {
    const dc = channel.current;
    if (finalizing.current || !dc || dc.readyState !== "open") return false;
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

  // Words said into a bad connection leave no event, and "disconnected" only counts as lost after
  // its grace, so End can come first. A browser that doesn't report a state can't show anything.
  function markBadConnection() {
    const state = pc.current?.connectionState;
    if (state && state !== "connected") lost.current = true;
  }

  async function end() {
    if (finalizing.current) return;
    markBadConnection();
    finalizing.current = true;
    endStarted.current = Date.now();
    providerActivity.current = endStarted.current;
    finalProviderAt.current = null;
    durationSeconds.current = Math.round((Date.now() - liveSince.current) / 1000);
    drainStarted.current = performance.now();
    // Stop all capture immediately. ScreenShareButton unmounts when leaving live.
    mic.current?.getTracks().forEach((t) => t.stop());
    camStream.current?.getTracks().forEach((t) => t.stop());
    camStream.current = null; // Invalidate an already-running camera capture before React cleanup.
    setCam(null);
    await drain();
  }

  async function drain() {
    if (draining.current || finishing.current) return;
    draining.current = true;
    const g = gen.current;
    const until = Date.now() + DRAIN_ATTEMPT_MS;
    setPhase("ending");
    setFinalStage(drainDescription(pending.current));
    // Allow VAD to settle naturally first. Only server-confirmed active speech that has
    // not stopped/committed/transcribed warrants one conditional commit at End.
    // Manual commit starts transcription, not a response; never cancel an answer.
    while (g === gen.current && !callLost.current) {
      if (!commitAttempted.current && Date.now() - (endStarted.current ?? Date.now()) >= 500 && work.current.reserveCommit()) {
        commitAttempted.current = true;
        try {
          if (channel.current?.readyState === "open") {
            channel.current.send(JSON.stringify({ type: "input_audio_buffer.commit", event_id: `end_commit_${g}` }));
          }
        } catch {
          lost.current = true;
        }
      }
      // All expected responses must reach a terminal event; this small scheduling
      // grace only lets already completed work finish dispatching queued events.
      if (pending.current.size === 0 && Date.now() - providerActivity.current >= 300) break;
      if (Date.now() >= until) {
        if (!work.current.missingTurns) break; // Only audio is left and its words are saved: don't ask.
        draining.current = false;
        setPhase("waiting");
        measure("provider-drain", drainStarted.current, "waiting");
        return; // Another bounded attempt requires an explicit click.
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    if (g !== gen.current) return;
    draining.current = false;
    await closeDrained();
  }

  async function closeDrained() {
    if (finishing.current || draining.current) return;
    markBadConnection();
    if (work.current.missingTurns || work.current.unrecordedTurns) lost.current = true;
    setLastTurnMissing(lost.current);
    measure("provider-drain", drainStarted.current, lost.current ? "incomplete" : "ok", finalProviderAt.current ?? performance.now());
    hangUp();
    await finish();
  }

  // Create the terminal marker once, only after all captured turns are stored. A call that went live
  // always gets one, so it always reaches a debrief; lost turns are stated on it, never hidden.
  // Failed POST/PATCH attempts keep the exact events for an explicit Save again.
  async function finish(retry = false) {
    if (finishing.current) return;
    finishing.current = true;
    if (retry && retryBatch.current) retryBatch.current.attempts = 0;
    const g = gen.current;
    const sid = sessionId.current;
    const persistStarted = performance.now();
    setPhase("ending");
    setFinalStage("Saving captured text");
    setError(startupFailure.current);
    try {
      if (!await flush()) throw new Error("TranscriptSaveError");
      if (g !== gen.current) return;
      if (liveEstablished.current && !events.current.some((event) => event.type === "session.ended")) {
        record("session.ended", { durationSeconds: durationSeconds.current, ...(lost.current && { transcriptGaps: true }) });
        if (!await flush()) throw new Error("TranscriptSaveError");
      }
      if (g !== gen.current) return;
      measure("events", persistStarted);
      setFinalStage("Closing the saved session");
      const patchStarted = performance.now();
      if (sid) {
        // Atomic server transitions keep ended terminal even if startup finishes late.
        for (let attempt = 1; ; attempt++) {
          try {
            await api.updateSession(sid, { status: "ended" });
            break;
          } catch (error) {
            if (g !== gen.current) return;
            if (attempt >= SAVE_ATTEMPTS || (error instanceof ApiError && error.status < 500)) throw error;
            await new Promise((resolve) => setTimeout(resolve, 250));
          }
        }
        if (g !== gen.current) return;
        if (liveEstablished.current) setEnded({ id: sid, questions: questions.current });
      }
      measure("session-patch", patchStarted);
      measure("total", drainStarted.current);
      setPhase("ended");
    } catch (error) {
      if (g !== gen.current) return;
      measure("persistence", persistStarted, error instanceof Error ? error.name : "Error");
      setPhase("unsaved");
      setError(`${startupFailure.current ? `${startupFailure.current} ` : ""}Could not finish saving (${saved.current}/${events.current.length} events stored). The call is closed. Choose Save again to retry.`);
    } finally {
      if (g === gen.current) finishing.current = false;
    }
  }

  const avgMs = metrics.latenciesMs.length
    ? Math.round(metrics.latenciesMs.reduce((a, b) => a + b, 0) / metrics.latenciesMs.length)
    : null;
  const showAvatar = !avatarOff && voice !== null && sessionId.current !== null && (phase === "live" || phase === "ending" || phase === "waiting");
  const questionCount = guide.split("\n").map((q) => q.trim()).filter(Boolean).length;
  const canStart = !questionsRequired || questionCount > 0;

  const btn = "rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-muted";
  const avatarSwitch = (
    <button type="button" className={btn} onClick={() => setAvatarOff(!avatarOff)}>
      {avatarOff ? "Turn avatar on" : "Turn avatar off"}
    </button>
  );
  const speakerName = (who: Speaker) =>
    ended?.sample ? (who === "persona" ? "Sample participant" : "Interviewer") : who === "persona" ? persona.name : "You";
  const errorBox = error && (
    <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
      {error}
    </p>
  );
  const saveLine = saveState.total > 0 && (
    <p className="mt-2 text-xs tabular-nums text-muted" data-testid="save-state">
      Transcript saved {saveState.saved}/{saveState.total}
      {phase === "live" && saveState.failed && saveState.saved < saveState.total
        ? " · save paused; the next turn retries, or finish the call and choose Save again"
        : ""}
    </p>
  );

  return (
    <section className="mt-4 rounded-xl border border-line bg-background/60 p-5" data-testid="interview-room">
      {questionsRequired && (phase === "idle" || phase === "ended" || phase === "error") && (
        <label className="mb-1 block text-sm">
          <span className="text-muted">Interview questions, one per line (the debrief answers these)</span>
          <textarea
            className="mt-1 h-24 w-full rounded-md border border-line bg-surface p-2 text-sm"
            value={guide}
            onChange={(e) => setGuide(e.target.value)}
          />
        </label>
      )}
      {questionsRequired && (phase === "idle" || phase === "ended" || phase === "error") && (
        <p className="-mt-2 mb-1 text-xs text-muted">
          {questionCount === 0
            ? "Add at least one question. The interview can start once the debrief has something to answer."
            : `${questionCount} ${questionCount === 1 ? "question" : "questions"}. End the call and the debrief answers each line.`}
        </p>
      )}
      {questionsRequired && (phase === "idle" || phase === "ended" || phase === "error") && (
        <GuideCheck guide={guide} language={persona.language} onGuideChange={setGuide} />
      )}
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted">Video interview</h3>
        {(phase === "idle" || phase === "ended" || phase === "error") && (
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-40"
            onClick={start}
            disabled={startBlocked || !canStart}
          >
            {phase === "idle" || ended?.sample ? "Start video interview" : "Start again"}
          </button>
        )}
        {(phase === "idle" || phase === "ended" || phase === "error") && (
          <>
            <button type="button" className={btn} onClick={runSample} disabled={startBlocked || !canStart}>
              Use sample interview
            </button>
            {avatarSwitch}
          </>
        )}
        {phase === "sample" && (
          <>
            <span role="status" className="text-sm text-muted">Loading the sample interview…</span>
            <button type="button" className={btn} onClick={cancelStart}>
              Cancel
            </button>
          </>
        )}
        {inCall && <span className="text-sm text-muted">Interview running in the popup…</span>}
        {phase === "ended" && (
          <span className="text-sm text-muted">
            {ended?.sample
              ? "Sample interview loaded: a scripted transcript. No live call took place and nobody was interviewed."
              : startupFailure.current
              ? "Interview could not start. Capture is off; this incomplete session has no debrief. Start again to retry."
              : lastTurnMissing && ended
              ? "Ended. Microphone and camera are off. This transcript has gaps: part of the call was not captured."
              : lastTurnMissing
              ? "Ended without the last turn. This transcript is incomplete, so there is no debrief for it."
              : "Ended. Microphone and camera are off, transcript saved."}
          </span>
        )}
        {phase === "unsaved" && (
          <button type="button" className={btn} onClick={() => finish(true)}>
            Save again
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">
        You are talking to an AI persona ({persona.name}), not a real person. It hears you and sees your camera.
        {" "}If you allow camera access, an image is sent to OpenAI every 15 seconds so the persona can see you.
        {" "}&ldquo;Use sample interview&rdquo; skips the call and debriefs a scripted transcript, clearly marked as a sample.
      </p>
      {connectionLost && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200" data-testid="connection-lost">
          Connection lost. Microphone, camera and screen sharing are off.
          {lastTurnMissing ? (liveEstablished.current ? " This transcript has gaps." : " This transcript is incomplete; no debrief will be generated.") : ""}
          {phase === "ending" ? " Saving captured turns…" : phase === "unsaved"
            ? " Save the captured turns before starting again."
            : " Start again begins a new conversation."}
        </p>
      )}
      {!inCall && phase === "ending" && <p role="status">{finalStage} · {endSeconds}s elapsed</p>}
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
          {phase === "connecting" && (
            <>
              <span className="text-sm text-muted">Connecting…</span>
              <button type="button" className={btn} onClick={cancelStart}>
                Cancel
              </button>
            </>
          )}
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
              <ScreenShareButton pc={pc} ask={askWith} onSharing={sharing} />
              {avatarSwitch}
            </>
          )}
          {(phase === "ending" || phase === "waiting") && (
            <span role="status" className="text-sm text-muted">{finalStage} · {endSeconds}s elapsed</span>
          )}
          {phase === "waiting" && (
            <>
              <span className="text-sm text-muted">The wait limit was reached. Capture is off. Closing now marks the transcript as having gaps.</span>
              {channel.current?.readyState === "open" && (
                <button type="button" className={btn} onClick={drain}>Continue waiting (10 seconds)</button>
              )}
              <button type="button" className={btn} onClick={closeDrained}>
                Close without it
              </button>
            </>
          )}
        </div>

        <div className="mt-4 grid items-start gap-4 sm:grid-cols-[minmax(0,20rem)_1fr]">
          <div className="space-y-3">
            {screenShare && (
              <ZoomStage label="Shared screen">
                <ScreenSharePreview stream={screenShare} />
                {phase === "live" && (
                  <p className="mt-2 text-xs text-room-muted" data-testid="screen-status">
                    {screenNote ??
                      (screenSentAt === null
                        ? "Sending the first screen image to the persona…"
                        : `Screen image sent to the persona ${Math.max(0, liveSeconds - screenSentAt)}s ago.`)}
                  </p>
                )}
              </ZoomStage>
            )}
            <ZoomStage label="Video call">
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
              {avatarOff && phase === "live" && <p className="mt-1 text-xs text-room-muted">Avatar off, voice only.</p>}
              {/* Mirrored like a video call self-view; the persona gets the unmirrored frames. */}
              <video
                ref={camView}
                autoPlay
                muted
                playsInline
                aria-label="Your camera"
                className={`mt-3 aspect-video w-full -scale-x-100 rounded-lg bg-black object-cover ${cam ? "" : "hidden"}`}
              />
              {camNote && <p className="mt-1 text-xs text-room-muted">{camNote}</p>}
            </ZoomStage>
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

      {(phase === "ended" || phase === "unsaved" || (connectionLost && !inCall)) && turns.length > 0 && (
        <details className="mt-4 text-sm" open={connectionLost || phase === "unsaved"}>
          <summary className="cursor-pointer text-muted">
            {ended?.sample ? "Sample transcript" : "Transcript"} ({turns.length} turns{lastTurnMissing ? ", has gaps" : ""})
          </summary>
          <ol className="mt-2 space-y-1">
            {turns.map((t, i) => (
              <li key={i} className={t.cancelled ? "opacity-50" : ""}>
                <span className="font-medium">{speakerName(t.who)}:</span> {t.text}
              </li>
            ))}
          </ol>
        </details>
      )}
      {(metrics.latenciesMs.length > 0 || metrics.outputTokens > 0) && (
        <details className="mt-3 text-xs text-muted">
          <summary className="cursor-pointer">Call diagnostics</summary>
          <p className="mt-1 tabular-nums" data-testid="metrics">
            Latency to first audio: {avgMs ?? "–"} ms avg over {metrics.latenciesMs.length} turns · tokens in{" "}
            {metrics.inputTokens} / out {metrics.outputTokens}
          </p>
        </details>
      )}
      {phase === "ended" && ended && ended.questions > 0 && (
        <DebriefView key={ended.id} sessionId={ended.id} personaName={persona.name} sample={ended.sample} />
      )}
      {phase === "ended" && ended && ended.questions === 0 && (
        <p className="mt-4 text-sm text-muted">
          No debrief: this interview had no interview questions. Add some above and start again.
        </p>
      )}
    </section>
  );
}
