"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import { captureFrame } from "@/lib/screenFrames";

// Chrome negotiates 256 KiB; leave room for the JSON envelope around the data URL.
const FALLBACK_MESSAGE_BYTES = 256 * 1024;
const ENVELOPE_BYTES = 1024;

// Lets the interviewer show the persona their screen: one frame per click, sent as an image into
// the running Realtime conversation. Nothing is stored or sent anywhere else.
export function ScreenShareButton({
  pc,
  channel,
}: {
  pc: RefObject<RTCPeerConnection | null>;
  channel: RefObject<RTCDataChannel | null>;
}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const current = useRef<MediaStream | null>(null);

  // Stop sharing when the interview ends or the card goes away.
  useEffect(() => () => current.current?.getTracks().forEach((t) => t.stop()), []);

  async function share() {
    setNote(null);
    try {
      const s = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false });
      // The browser's own "Stop sharing" ends the track; mirror that here.
      s.getVideoTracks()[0]?.addEventListener("ended", () => setStream(null), { once: true });
      current.current = s;
      setStream(s);
    } catch {
      setNote("Screen sharing was cancelled or blocked.");
    }
  }

  function stop() {
    stream?.getTracks().forEach((t) => t.stop());
    setStream(null);
  }

  async function show() {
    const dc = channel.current;
    if (!stream || !dc || dc.readyState !== "open") return;
    setBusy(true);
    setNote(null);
    try {
      const negotiated = pc.current?.sctp?.maxMessageSize;
      const limit = Number.isFinite(negotiated) && negotiated ? negotiated : FALLBACK_MESSAGE_BYTES;
      const image = await captureFrame(stream, { maxBytes: Math.min(limit, FALLBACK_MESSAGE_BYTES) - ENVELOPE_BYTES });
      dc.send(
        JSON.stringify({
          type: "conversation.item.create",
          item: { type: "message", role: "user", content: [{ type: "input_image", image_url: image }] },
        }),
      );
      // The persona reacts to what it now sees, in character.
      dc.send(JSON.stringify({ type: "response.create" }));
      setNote("Shown to the persona.");
    } catch (e) {
      setNote(e instanceof Error ? e.message : "Could not capture the screen.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      {!stream ? (
        <button type="button" className="rounded border border-current/30 px-3 py-1.5 text-sm" onClick={share}>
          Share screen
        </button>
      ) : (
        <>
          <button
            type="button"
            className="rounded bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-50"
            onClick={show}
            disabled={busy}
          >
            {busy ? "Capturing…" : "Show screen to persona"}
          </button>
          <button type="button" className="rounded border border-current/30 px-3 py-1.5 text-sm" onClick={stop}>
            Stop sharing
          </button>
        </>
      )}
      {note && <span className="text-xs opacity-70">{note}</span>}
    </>
  );
}
