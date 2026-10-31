"use client";

import { useEffect, useRef, useState } from "react";
import { LogLevel, SimliClient } from "simli-client";
import { api } from "@/lib/api";
import { logAvatarFailure } from "@/lib/avatarLog";

export type AvatarControl = { clear: () => void };

// Samples (16 kHz) Simli collects before it sends audio; the SDK default 3000 waits ~190 ms on every
// reply's first words. 1024 (64 ms) cuts that; raise it again if the lip sync stutters (#159).
const AUDIO_BUFFER_SAMPLES = 1024;

// The persona's face: Simli lip-syncs the persona's voice (the Realtime audio track) and plays
// it with the video. While it runs, the call's own <audio> is muted so the voice isn't doubled.
// If the avatar can't start, the interview simply continues voice-only.
export function Avatar({
  sessionId,
  track,
  onActive,
  onSpeaking,
}: {
  sessionId: string;
  track: MediaStreamTrack;
  // Called with a control once the avatar speaks (to cut it short on interruption), null when off.
  onActive: (control: AvatarControl | null) => void;
  // Called when the avatar starts to move its mouth (Simli "speaking"); used to measure reply delay.
  onSpeaking?: () => void;
}) {
  const video = useRef<HTMLVideoElement | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<"starting" | "live" | "off">("starting");

  useEffect(() => {
    let client: SimliClient | null = null;
    // Unmounted or failed: either way this attempt is over and nothing may revive it.
    let cancelled = false;
    let failed = false;
    const stop = () => {
      if (!client) return;
      // shortcut: SimliClient.stop() closes its socket but keeps its private AudioWorklet
      // sending into it (a flood of "Invalid State, WS Connection 3"); closing the context
      // stops it. Drop when simli-client cleans up its own audio graph.
      void (client as unknown as { audioContext: AudioContext }).audioContext.close().catch(() => {});
      void client.stop();
    };
    // "error" passes the server's message, "stop" passes nothing, the catch below what start() threw.
    const fail = (cause?: unknown) => {
      if (cancelled || failed) return;
      failed = true;
      logAvatarFailure("off", cause ?? "Simli ended the session (stop event)");
      // A failed or ended session still holds a connection: release it.
      stop();
      onActive(null);
      setState("off");
    };
    // Only while this attempt is open: what follows a failure or a hang-up is just its aftermath.
    const note = (stage: string, cause: unknown) => {
      if (!cancelled && !failed) logAvatarFailure(stage, cause);
    };
    (async () => {
      try {
        const { token } = await api.avatarToken(sessionId);
        if (cancelled || failed || !token || !video.current || !audio.current) return;
        client = new SimliClient(
          token, video.current, audio.current, null, LogLevel.ERROR, undefined, undefined, undefined,
          AUDIO_BUFFER_SAMPLES,
        );
        client.on("error", fail);
        client.on("speaking", () => onSpeaking?.());
        client.on("stop", fail);
        // Each failed attempt while start() retries, which takes minutes and then only says "Too Many
        // Retry Attempts".
        client.on("startup_error", (message) => note("attempt failed", message));
        // shortcut: the SDK's own error lines print server messages raw, which can hold join tokens,
        // and are the only place a timed-out attempt shows up. Keep them, filtered.
        (client as unknown as { logger: { error: (message: string) => void } }).logger.error = (message) =>
          note("sdk", message);
        await client.start();
        // An "error"/"stop" can arrive while start() is still pending; it wins.
        if (cancelled || failed) return;
        client.listenToMediastreamTrack(track);
        const live = client;
        onActive({ clear: () => live.ClearBuffer() });
        setState("live");
      } catch (e) {
        // shortcut: stopped during the SDK's retry backoff, start() still opens a new websocket
        // and only then throws. Only a second stop() reaches that socket. Drop when simli-client
        // checks for a stop before it retries.
        if (cancelled || failed) stop();
        else fail(e);
      }
    })();
    return () => {
      cancelled = true;
      onActive(null);
      stop();
    };
    // One avatar session per interview session and voice track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, track]);

  return (
    <div data-testid="avatar">
      <video
        ref={video}
        autoPlay
        playsInline
        className={`aspect-square w-full max-w-xs rounded-lg border border-line bg-surface ${state === "off" ? "hidden" : ""}`}
      />
      <audio ref={audio} autoPlay />
      {state === "starting" && <p className="mt-1 text-xs text-muted">Avatar is joining…</p>}
      {state === "off" && <p className="mt-1 text-xs text-muted">Avatar unavailable, voice only.</p>}
    </div>
  );
}
