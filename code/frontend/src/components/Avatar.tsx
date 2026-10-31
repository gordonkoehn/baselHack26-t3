"use client";

import { useEffect, useRef, useState } from "react";
import { LogLevel, SimliClient } from "simli-client";
import { api } from "@/lib/api";

export type AvatarControl = { clear: () => void };

// The persona's face: Simli lip-syncs the persona's voice (the Realtime audio track) and plays
// it with the video. While it runs, the call's own <audio> is muted so the voice isn't doubled.
// If the avatar can't start, the interview simply continues voice-only.
export function Avatar({
  sessionId,
  track,
  onActive,
}: {
  sessionId: string;
  track: MediaStreamTrack;
  // Called with a control once the avatar speaks (to cut it short on interruption), null when off.
  onActive: (control: AvatarControl | null) => void;
}) {
  const video = useRef<HTMLVideoElement | null>(null);
  const audio = useRef<HTMLAudioElement | null>(null);
  const [state, setState] = useState<"starting" | "live" | "off">("starting");

  useEffect(() => {
    let client: SimliClient | null = null;
    let cancelled = false;
    const fail = () => {
      if (cancelled) return;
      // A failed or ended session still holds a connection: release it.
      void client?.stop();
      onActive(null);
      setState("off");
    };
    (async () => {
      try {
        const { token } = await api.avatarToken(sessionId);
        if (cancelled || !token || !video.current || !audio.current) return;
        client = new SimliClient(token, video.current, audio.current, null, LogLevel.ERROR);
        client.on("error", fail);
        client.on("stop", fail);
        await client.start();
        if (cancelled) return;
        client.listenToMediastreamTrack(track);
        const live = client;
        onActive({ clear: () => live.ClearBuffer() });
        setState("live");
      } catch {
        fail();
      }
    })();
    return () => {
      cancelled = true;
      onActive(null);
      void client?.stop();
    };
    // One avatar session per interview session and voice track.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, track]);

  return (
    <div className="mt-3" data-testid="avatar">
      <video
        ref={video}
        autoPlay
        playsInline
        className={`aspect-square w-full max-w-xs rounded-lg bg-surface ${state === "off" ? "hidden" : ""}`}
      />
      <audio ref={audio} autoPlay />
      {state === "starting" && <p className="mt-1 text-xs text-muted">Avatar is joining…</p>}
      {state === "off" && <p className="mt-1 text-xs text-muted">Avatar unavailable, voice only.</p>}
    </div>
  );
}
