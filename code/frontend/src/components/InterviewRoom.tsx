"use client";

import { useEffect, useRef, useState } from "react";
import { DebriefView } from "@/components/DebriefView";
import { ScreenShareButton } from "@/components/ScreenShareButton";
import { ApiError, api } from "@/lib/api";
import type { Persona, SessionEvent } from "@/lib/contracts";
import { QUARTIER_BOERSE_GUIDE } from "@/lib/sample";

// Voice interview pilot: the browser talks to OpenAI Realtime over WebRTC with a short-lived
// client secret from our backend. Our backend never holds the audio connection.

type Turn = { who: "interviewer" | "persona"; text: string; cancelled?: boolean };
type Phase = "idle" | "connecting" | "live" | "ending" | "waiting" | "ended" | "unsaved" | "error";
type Speaker = "interviewer" | "persona";
type Metrics = { latenciesMs: number[]; inputTokens: number; outputTokens: number };

// Realtime server events we act on (subset of the GA event list).
type ServerEvent = {
  type: string;
  item_id?: string;
  content_index?: number;
  transcript?: string;
  response?: { id?: string; status?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  error?: { message?: string };
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
  const pc = useRef<RTCPeerConnection | null>(null);
  const channel = useRef<RTCDataChannel | null>(null);
  const mic = useRef<MediaStream | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const sessionId = useRef<string | null>(null);
  // When the interviewer stopped talking (or sent text); the gap to the first persona audio is latency.
  const askedAt = useRef<number | null>(null);

  // Never leave the microphone or the call open when the card goes away.
  useEffect(() => () => hangUp(), []);

  function hangUp() {
    mic.current?.getTracks().forEach((t) => t.stop());
    channel.current?.close();
    pc.current?.close();
    mic.current = channel.current = pc.current = null;
  }

  function onEvent(e: ServerEvent) {
    switch (e.type) {
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
        pending.current.add("speech");
        break;
      case "input_audio_buffer.committed":
        pending.current.delete("speech");
        if (e.item_id) pending.current.add(`t:${e.item_id}`);
        break;
      case "conversation.item.input_audio_transcription.failed":
        if (e.item_id) pending.current.delete(`t:${e.item_id}`);
        lost.current = true;
        break;
      case "response.created": {
        // The oldest typed question waiting for its answer is now acknowledged by a real response.
        const ask = [...pending.current].find((k) => k.startsWith("a:"));
        if (ask) pending.current.delete(ask);
        if (e.response?.id) pending.current.add(`r:${e.response.id}`);
        break;
      }
      case "conversation.item.input_audio_transcription.completed":
        if (e.item_id) pending.current.delete(`t:${e.item_id}`);
        if (e.transcript?.trim() && once(`t:${e.item_id}`)) addTurn("interviewer", e.transcript.trim());
        break;
      case "response.output_audio_transcript.done":
        if (e.transcript?.trim() && once(`o:${e.item_id}:${e.content_index}`)) addTurn("persona", e.transcript.trim());
        break;
      case "response.done": {
        if (e.response?.id) pending.current.delete(`r:${e.response.id}`);
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
      case "error":
        setError(e.error?.message ?? "Realtime error");
        break;
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
    setPhase("connecting");
    setError(null);
    setTurns([]);
    setMetrics({ latenciesMs: [], inputTokens: 0, outputTokens: 0 });
    gen.current += 1;
    const g = gen.current;
    events.current = [];
    saved.current = 0;
    setEnded(null);
    sending.current = null;
    seen.current.clear();
    lost.current = false;
    pending.current.clear();
    giveUp.current = false;
    setLastTurnMissing(false);
    setSaveState({ saved: 0, total: 0, failed: false });
    try {
      const interviewGuide = guide
        .split("\n")
        .map((q) => q.trim())
        .filter(Boolean);
      questions.current = interviewGuide.length;
      const session = await api.createSession({ personaId: persona.id, interviewGuide });
      sessionId.current = session.id;
      const token = await api.sessionToken(session.id);
      if (!token.token || !token.url) throw new Error("no realtime token");

      const conn = new RTCPeerConnection();
      pc.current = conn;
      conn.ontrack = (ev) => {
        if (audio.current) audio.current.srcObject = ev.streams[0];
      };
      mic.current = await navigator.mediaDevices.getUserMedia({ audio: true });
      mic.current.getTracks().forEach((t) => conn.addTrack(t, mic.current!));
      const dc = conn.createDataChannel("oai-events");
      channel.current = dc;
      dc.onmessage = (m) => g === gen.current && onEvent(JSON.parse(m.data));

      const offer = await conn.createOffer();
      await conn.setLocalDescription(offer);
      const answer = await fetch(token.url, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/sdp" },
      });
      if (!answer.ok) throw new Error(`OpenAI refused the call (${answer.status})`);
      await conn.setRemoteDescription({ type: "answer", sdp: await answer.text() });
      // Only "live" once events can flow both ways, so an early typed question isn't dropped.
      if (dc.readyState !== "open") await new Promise((r) => dc.addEventListener("open", r, { once: true }));
      await api.updateSession(session.id, { status: "live" });
      liveSince.current = Date.now();
      setPhase("live");
    } catch (e) {
      hangUp();
      setPhase("error");
      if (e instanceof DOMException && e.name === "NotAllowedError") setError("Microphone access was denied.");
      else if (e instanceof ApiError) setError(`Could not start (${e.status}): ${e.detail}`);
      else setError(e instanceof Error ? e.message : "Could not start the interview.");
    }
  }

  // Typed question: a fallback when the room is noisy, and the same path the pilot uses.
  function ask() {
    const dc = channel.current;
    if (!dc || dc.readyState !== "open" || !typed.trim()) return;
    dc.send(
      JSON.stringify({
        type: "conversation.item.create",
        item: { type: "message", role: "user", content: [{ type: "input_text", text: typed.trim() }] },
      }),
    );
    // Registered before sending, so "End" waits for this answer even before the provider confirms it.
    pending.current.add(`a:${++asks.current}`);
    dc.send(JSON.stringify({ type: "response.create" }));
    addTurn("interviewer", typed.trim());
    askedAt.current = performance.now();
    setTyped("");
  }

  async function end() {
    setPhase("ending");
    // Mic off first, then wait until the provider has finished every transcript and answer it
    // started; only then close the call, so the last turn can't be cut off.
    mic.current?.getTracks().forEach((t) => t.stop());
    for (let waited = 0; pending.current.size > 0 && waited < 10_000; waited += 200) {
      await new Promise((r) => setTimeout(r, 200));
    }
    if (pending.current.size > 0) {
      // Still not done: keep the call open and let the interviewer decide, never guess "complete".
      setPhase("waiting");
      while (pending.current.size > 0 && !giveUp.current) await new Promise((r) => setTimeout(r, 500));
    }
    const incomplete = pending.current.size > 0 || lost.current;
    setLastTurnMissing(incomplete);
    hangUp();
    // No end marker for an incomplete transcript: the backend then refuses a debrief (409) on its own.
    if (!incomplete) {
      record("session.ended", { durationSeconds: Math.round((Date.now() - liveSince.current) / 1000) });
    }
    await finish();
  }

  // The session is only marked ended once the whole transcript, marker included, is stored.
  async function finish() {
    setPhase("ending");
    setError(null);
    let ok = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, 1000 * attempt));
      ok = await flush();
    }
    try {
      if (!ok) throw new Error("transcript not saved");
      if (sessionId.current) {
        await api.updateSession(sessionId.current, { status: "ended" });
        setEnded({ id: sessionId.current, questions: questions.current });
      }
      setPhase("ended");
    } catch {
      setPhase("unsaved");
      setError(`Transcript not fully saved (${saved.current}/${events.current.length} events). The call is closed.`);
    }
  }

  const avgMs = metrics.latenciesMs.length
    ? Math.round(metrics.latenciesMs.reduce((a, b) => a + b, 0) / metrics.latenciesMs.length)
    : null;

  return (
    <section className="mt-8 rounded-xl border border-line bg-background/60 p-5" data-testid="interview-room">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-xs font-semibold uppercase tracking-widest text-muted">Voice interview (pilot)</h3>
        {(phase === "idle" || phase === "ended" || phase === "error") && (
          <button
            type="button"
            className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface hover:opacity-90"
            onClick={start}
          >
            {phase === "idle" ? "Start voice interview" : "Start again"}
          </button>
        )}
        {phase === "connecting" && <span className="text-sm text-muted">Connecting…</span>}
        {phase === "live" && (
          <>
            <span className="flex items-center gap-2 text-sm font-medium text-accent">
              <span aria-hidden className="size-2 animate-pulse rounded-full bg-accent" />
              Live, speak now
            </span>
            <button type="button" className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-muted" onClick={end}>
              End interview
            </button>
            <ScreenShareButton pc={pc} channel={channel} />
          </>
        )}
        {phase === "ending" && <span className="text-sm text-muted">Saving transcript…</span>}
        {phase === "waiting" && (
          <>
            <span className="text-sm text-muted">Waiting for the last turn to finish…</span>
            <button
              type="button"
              className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-muted"
              onClick={() => (giveUp.current = true)}
            >
              Close without it
            </button>
          </>
        )}
        {phase === "ended" && (
          <span className="text-sm text-muted">
            {lastTurnMissing
              ? "Ended without the last turn. This transcript is incomplete, so there is no debrief for it."
              : "Ended. Microphone is off, transcript saved."}
          </span>
        )}
        {phase === "unsaved" && (
          <button type="button" className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-muted" onClick={finish}>
            Save again
          </button>
        )}
      </div>
      <p className="mt-2 text-xs text-muted">
        You are talking to an AI persona ({persona.name}), not a real person.
      </p>
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
      {saveState.total > 0 && (
        <p className="mt-2 text-xs tabular-nums text-muted" data-testid="save-state">
          Transcript saved {saveState.saved}/{saveState.total}
          {phase === "live" && saveState.failed && saveState.saved < saveState.total
            ? " · not saved yet, retrying with the next turn"
            : ""}
        </p>
      )}
      {/* Plays the persona's voice once; the microphone is never routed back to the speakers. */}
      <audio ref={audio} autoPlay />

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
          <button type="button" className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-muted" onClick={ask}>
            Ask
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      {turns.length > 0 && (
        <ol className="mt-4 space-y-2 text-sm" data-testid="transcript">
          {turns.map((t, i) => (
            <li
              key={i}
              className={`w-fit max-w-[85%] rounded-lg px-3 py-2 leading-relaxed ${
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
      )}

      {(metrics.latenciesMs.length > 0 || metrics.outputTokens > 0) && (
        <p className="mt-3 text-xs tabular-nums text-muted" data-testid="metrics">
          Latency to first audio: {avgMs ?? "–"} ms avg over {metrics.latenciesMs.length} turns · tokens in{" "}
          {metrics.inputTokens} / out {metrics.outputTokens}
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
