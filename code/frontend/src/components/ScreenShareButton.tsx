"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import { captureFrame } from "@/lib/screenFrames";

// Chrome negotiates 256 KiB; leave room for the JSON envelope around the data URL.
const FALLBACK_MESSAGE_BYTES = 256 * 1024;
const ENVELOPE_BYTES = 1024;

// Largest data URL one data-channel message can carry on this call.
export function frameBudget(pc: RTCPeerConnection | null) {
  const negotiated = pc?.sctp?.maxMessageSize;
  const limit = Number.isFinite(negotiated) && negotiated ? negotiated : FALLBACK_MESSAGE_BYTES;
  return Math.min(limit, FALLBACK_MESSAGE_BYTES) - ENVELOPE_BYTES;
}

// Lets the interviewer show the persona their screen. While shared, InterviewRoom sends fresh frames
// as silent context (onSharing); a click here asks the persona to react to the screen right now.
// Nothing is stored or sent anywhere else.
export function ScreenShareButton({
  pc,
  ask,
  onSharing,
}: {
  pc: RefObject<RTCPeerConnection | null>;
  // InterviewRoom's send path: registers the expected answer so "End" waits for it.
  ask: (content: object[]) => boolean;
  onSharing?: (stream: MediaStream | null) => void;
}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const current = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  // One browser picker at a time; a second click while it is open does nothing.
  const picking = useRef(false);
  const report = useRef(onSharing);
  useEffect(() => {
    report.current = onSharing;
  });

  // Stop sharing when the interview ends or the card goes away.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current?.getTracks().forEach((t) => t.stop());
      current.current = null;
      report.current?.(null);
    };
  }, []);

  async function share() {
    if (picking.current) return;
    picking.current = true;
    setNote(null);
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      // Granted after the interview ended: don't leave the screen captured.
      if (!mounted.current) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      // The browser's own "Stop sharing" ends the track; mirror that here.
      s.getVideoTracks()[0]?.addEventListener(
        "ended",
        () => {
          if (current.current !== s) return;
          current.current = null;
          report.current?.(null);
          if (mounted.current) setStream(null);
        },
        { once: true },
      );
      current.current = s;
      setStream(s);
      report.current?.(s);
    } catch {
      if (mounted.current) setNote("Screen sharing was cancelled or blocked.");
    } finally {
      picking.current = false;
    }
  }

  function stop() {
    stream?.getTracks().forEach((t) => t.stop());
    current.current = null;
    setStream(null);
    report.current?.(null);
  }

  async function show() {
    const shared = stream;
    if (!shared) return;
    setBusy(true);
    setNote(null);
    try {
      const image = await captureFrame(shared, { maxBytes: frameBudget(pc.current) });
      // Sharing stopped (or the card closed) while capturing: send nothing.
      if (!mounted.current || current.current !== shared) return;
      // The persona reacts to what it now sees, in character.
      const shown = ask([
        // The persona prompt (realtime.py) keys on this exact label; keep them in sync.
        { type: "input_text", text: "(Interviewer's shared screen, the prototype, right now.)" },
        { type: "input_image", image_url: image },
      ]);
      setNote(shown ? "Shown to the persona." : "The call is not open.");
    } catch (e) {
      if (mounted.current) setNote(e instanceof Error ? e.message : "Could not capture the screen.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  return (
    <>
      {!stream ? (
        <button type="button" className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-muted" onClick={share}>
          Share screen
        </button>
      ) : (
        <>
          <button
            type="button"
            className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-50"
            onClick={show}
            disabled={busy}
          >
            {busy ? "Capturing…" : "Show screen to persona"}
          </button>
          <button type="button" className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-muted" onClick={stop}>
            Stop sharing
          </button>
        </>
      )}
      {stream && !note && (
        <span className="text-xs text-muted">
          Share the prototype&apos;s tab or window, not this call.
        </span>
      )}
      {note && <span className="text-xs text-muted">{note}</span>}
    </>
  );
}
