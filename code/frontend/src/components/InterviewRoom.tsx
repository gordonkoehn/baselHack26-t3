"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { Persona } from "@/lib/contracts";

// Voice interview pilot: the browser talks to OpenAI Realtime over WebRTC with a short-lived
// client secret from our backend. Our backend never holds the audio connection.

type Turn = { who: "interviewer" | "persona"; text: string; cancelled?: boolean };
type Phase = "idle" | "connecting" | "live" | "ending" | "ended" | "error";
type Metrics = { latenciesMs: number[]; inputTokens: number; outputTokens: number };

// Realtime server events we act on (subset of the GA event list).
type ServerEvent = {
  type: string;
  transcript?: string;
  response?: { status?: string; usage?: { input_tokens?: number; output_tokens?: number } };
  error?: { message?: string };
};

export function InterviewRoom({ persona }: { persona: Persona }) {
  const [phase, setPhase] = useState<Phase>("idle");
  const [error, setError] = useState<string | null>(null);
  const [turns, setTurns] = useState<Turn[]>([]);
  const [metrics, setMetrics] = useState<Metrics>({ latenciesMs: [], inputTokens: 0, outputTokens: 0 });
  const [typed, setTyped] = useState("");
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
      case "conversation.item.input_audio_transcription.completed":
        if (e.transcript?.trim()) setTurns((t) => [...t, { who: "interviewer", text: e.transcript!.trim() }]);
        break;
      case "response.output_audio_transcript.done":
        if (e.transcript?.trim()) setTurns((t) => [...t, { who: "persona", text: e.transcript!.trim() }]);
        break;
      case "response.done": {
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

  async function start() {
    setPhase("connecting");
    setError(null);
    setTurns([]);
    setMetrics({ latenciesMs: [], inputTokens: 0, outputTokens: 0 });
    try {
      const session = await api.createSession({ personaId: persona.id });
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
      dc.onmessage = (m) => onEvent(JSON.parse(m.data));

      const offer = await conn.createOffer();
      await conn.setLocalDescription(offer);
      const answer = await fetch(token.url, {
        method: "POST",
        body: offer.sdp,
        headers: { Authorization: `Bearer ${token.token}`, "Content-Type": "application/sdp" },
      });
      if (!answer.ok) throw new Error(`OpenAI refused the call (${answer.status})`);
      await conn.setRemoteDescription({ type: "answer", sdp: await answer.text() });
      await api.updateSession(session.id, { status: "live" });
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
    dc.send(JSON.stringify({ type: "response.create" }));
    setTurns((t) => [...t, { who: "interviewer", text: typed.trim() }]);
    askedAt.current = performance.now();
    setTyped("");
  }

  async function end() {
    setPhase("ending");
    hangUp();
    try {
      if (sessionId.current) await api.updateSession(sessionId.current, { status: "ended" });
    } finally {
      setPhase("ended");
    }
  }

  const avgMs = metrics.latenciesMs.length
    ? Math.round(metrics.latenciesMs.reduce((a, b) => a + b, 0) / metrics.latenciesMs.length)
    : null;

  return (
    <section className="mt-8 rounded border border-current/20 p-4" data-testid="interview-room">
      <div className="flex flex-wrap items-center gap-3">
        <h3 className="text-sm font-semibold uppercase tracking-wide opacity-60">Voice interview (pilot)</h3>
        {(phase === "idle" || phase === "ended" || phase === "error") && (
          <button
            type="button"
            className="rounded bg-foreground px-3 py-1.5 text-sm text-background"
            onClick={start}
          >
            {phase === "idle" ? "Start voice interview" : "Start again"}
          </button>
        )}
        {phase === "connecting" && <span className="text-sm opacity-70">Connecting…</span>}
        {phase === "live" && (
          <>
            <span className="text-sm text-green-600">● Live, speak now</span>
            <button type="button" className="rounded border border-current/30 px-3 py-1.5 text-sm" onClick={end}>
              End interview
            </button>
          </>
        )}
        {phase === "ended" && <span className="text-sm opacity-70">Ended. Microphone is off.</span>}
      </div>
      <p className="mt-1 text-xs opacity-60">
        You are talking to an AI persona ({persona.name}), not a real person.
      </p>
      {/* Plays the persona's voice once; the microphone is never routed back to the speakers. */}
      <audio ref={audio} autoPlay />

      {phase === "live" && (
        <div className="mt-3 flex gap-2">
          <input
            aria-label="Type a question"
            className="min-w-0 flex-1 rounded border border-current/30 bg-transparent px-2 py-1 text-sm"
            placeholder="…or type a question"
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && ask()}
          />
          <button type="button" className="rounded border border-current/30 px-3 py-1 text-sm" onClick={ask}>
            Ask
          </button>
        </div>
      )}

      {error && (
        <p role="alert" className="mt-3 rounded bg-red-50 p-3 text-sm text-red-800">
          {error}
        </p>
      )}

      {turns.length > 0 && (
        <ol className="mt-4 space-y-2 text-sm" data-testid="transcript">
          {turns.map((t, i) => (
            <li key={i} className={t.cancelled ? "opacity-50" : ""}>
              <span className="mr-2 text-xs font-medium uppercase opacity-60">
                {t.who === "persona" ? persona.name : "You"}
              </span>
              {t.text}
            </li>
          ))}
        </ol>
      )}

      {(metrics.latenciesMs.length > 0 || metrics.outputTokens > 0) && (
        <p className="mt-3 text-xs tabular-nums opacity-60" data-testid="metrics">
          Latency to first audio: {avgMs ?? "–"} ms avg over {metrics.latenciesMs.length} turns · tokens in{" "}
          {metrics.inputTokens} / out {metrics.outputTokens}
        </p>
      )}
    </section>
  );
}
