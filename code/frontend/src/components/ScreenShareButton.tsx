"use client";

import { type RefObject, useEffect, useRef, useState } from "react";
import { captureFrame } from "@/lib/screenFrames";

// Chrome negotiates 256 KiB; leave room for the JSON envelope around the data URL.
const FALLBACK_MESSAGE_BYTES = 256 * 1024;
const ENVELOPE_BYTES = 1024;
// The persona prompt (realtime.py) keys on this exact prefix; keep them in sync.
const LABEL = "(Interviewer's shared screen, the prototype, right now.)";
const SYNC_MS = 10_000;
const ACK_MS = 5_000;
// Screen capture only emits frames when something changes: no frame within this window means unchanged.
const GRAB_MS = 3_000;

type Ack = "ok" | "error" | "timeout";

// ImageCapture reads the track directly, so it keeps working while the interviewer is on the
// prototype's tab and this page is hidden (a <video> element stops rendering frames then).
type Grabber = { grabFrame(): Promise<ImageBitmap> };
type GrabberCtor = new (track: MediaStreamTrack) => Grabber;

function encode(bitmap: ImageBitmap, maxBytes: number): string {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  if (!context) throw new Error("Canvas frame capture is not supported in this browser.");
  let scale = Math.min(1, 1280 / bitmap.width, 720 / bitmap.height);
  for (let attempt = 0; attempt < 12; attempt++) {
    canvas.width = Math.max(1, Math.floor(bitmap.width * scale));
    canvas.height = Math.max(1, Math.floor(bitmap.height * scale));
    context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    for (const quality of [0.8, 0.6, 0.4]) {
      const url = canvas.toDataURL("image/jpeg", quality);
      if (url.length <= maxBytes) return url;
    }
    scale /= 2;
  }
  throw new Error("The screen frame cannot fit into one message.");
}

/** A fresh frame, or null when the screen produced no new frame (it hasn't changed). */
async function grab(stream: MediaStream, maxBytes: number): Promise<string | null> {
  const Capture = (globalThis as unknown as { ImageCapture?: GrabberCtor }).ImageCapture;
  if (!Capture) return captureFrame(stream, { maxBytes });
  const pending = new Capture(stream.getVideoTracks()[0]).grabFrame();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bitmap = await Promise.race([
    pending,
    new Promise<null>((resolve) => (timer = setTimeout(() => resolve(null), GRAB_MS))),
  ]).finally(() => clearTimeout(timer));
  if (!bitmap) {
    pending.then((late) => late.close(), () => {});
    return null;
  }
  try {
    return encode(bitmap, maxBytes);
  } finally {
    bitmap.close();
  }
}

/** Sends one event and waits for the server's confirmation (or its error for this event_id). */
function request(dc: RTCDataChannel, event: { event_id: string }, confirms: (e: Record<string, unknown>) => boolean) {
  return new Promise<{ result: Ack; message?: string }>((resolve) => {
    const done = (result: Ack, message?: string) => {
      clearTimeout(timer);
      dc.removeEventListener("message", onMessage);
      resolve({ result, message });
    };
    const onMessage = (m: MessageEvent) => {
      let e: Record<string, unknown>;
      try {
        e = JSON.parse(String(m.data));
      } catch {
        return;
      }
      if (confirms(e)) return done("ok");
      const error = e.error as { event_id?: string; message?: string } | undefined;
      if (e.type === "error" && error?.event_id === event.event_id) done("error", error.message);
    };
    const timer = setTimeout(() => done("timeout"), ACK_MS);
    dc.addEventListener("message", onMessage);
    try {
      dc.send(JSON.stringify(event));
    } catch {
      done("error");
    }
  });
}

function ago(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s} s ago` : `${Math.floor(s / 60)} min ago`;
}

// Lets the interviewer show the persona their screen. While sharing, the persona keeps one current
// frame in context (replaced when the screen changes, no answer triggered); "Show screen to persona"
// additionally asks it to react now. Nothing is stored or sent anywhere else.
export function ScreenShareButton({
  pc,
  ask,
  channel,
  onSharingChange,
}: {
  pc: RefObject<RTCPeerConnection | null>;
  // InterviewRoom's send path: registers the expected answer so "End" waits for it.
  ask: (content: object[]) => boolean;
  // The call's data channel, for the context-only frames; without it only manual frames are sent.
  channel?: RefObject<RTCDataChannel | null>;
  // Lets the call pause its camera frames, so the newest image is the prototype, not a face.
  onSharingChange?: (sharing: boolean) => void;
}) {
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<string | null>(null);
  const [seen, setSeen] = useState<{ thumb: string; at: number } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const current = useRef<MediaStream | null>(null);
  const mounted = useRef(true);
  // One browser picker at a time; a second click while it is open does nothing.
  const picking = useRef(false);
  // The single screen frame the persona holds in context, and the image it shows.
  const item = useRef<string | null>(null);
  const image = useRef<string | null>(null);
  const syncing = useRef(false);
  const paused = useRef(false);
  const seq = useRef(0);
  const prefix = useRef(`scr_${Math.random().toString(36).slice(2, 8)}`);
  const sharingChanged = useRef(onSharingChange);
  sharingChanged.current = onSharingChange;

  // Stop sharing when the interview ends or the card goes away.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      current.current?.getTracks().forEach((t) => t.stop());
      current.current = null;
      sharingChanged.current?.(false);
    };
  }, []);

  function limit() {
    const negotiated = pc.current?.sctp?.maxMessageSize;
    const max = Number.isFinite(negotiated) && negotiated ? negotiated : FALLBACK_MESSAGE_BYTES;
    return Math.min(max, FALLBACK_MESSAGE_BYTES) - ENVELOPE_BYTES;
  }

  // Replace the persona's screen frame with the current one: delete confirmed first, then add,
  // so the context never holds more than one screen image.
  async function sync(shared: MediaStream) {
    const dc = channel?.current;
    if (syncing.current || paused.current || dc?.readyState !== "open") return;
    syncing.current = true;
    const live = () => mounted.current && current.current === shared;
    try {
      const frame = await grab(shared, limit());
      if (!live()) return;
      if (frame === null || frame === image.current) {
        // Unchanged: what the persona holds is still current.
        if (image.current) setSeen((s) => s && { ...s, at: Date.now() });
        return;
      }
      const previous = item.current;
      if (previous) {
        const { result, message } = await request(
          dc,
          { type: "conversation.item.delete", item_id: previous, event_id: `${prefix.current}_del_${++seq.current}` } as { event_id: string },
          (e) => e.type === "conversation.item.deleted" && e.item_id === previous,
        );
        const gone = result === "ok" || (result === "error" && /not found|does not exist|already deleted/i.test(message ?? ""));
        if (!gone) {
          paused.current = true;
          if (live()) setNote("Screen updates paused: the previous frame could not be removed. Show screen to persona still works.");
          return;
        }
        item.current = null;
      }
      if (!live()) return;
      const id = `${prefix.current}_${++seq.current}`;
      // Tracked before the answer: if it was added but unconfirmed, the next round deletes it.
      item.current = id;
      const { result } = await request(
        dc,
        {
          type: "conversation.item.create",
          event_id: `${prefix.current}_add_${seq.current}`,
          item: {
            id,
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: LABEL },
              { type: "input_image", image_url: frame },
            ],
          },
        } as { event_id: string },
        (e) =>
          (e.type === "conversation.item.added" || e.type === "conversation.item.created") &&
          (e.item as { id?: string } | undefined)?.id === id,
      );
      if (!live()) return;
      if (result === "ok") {
        image.current = frame;
        setSeen({ thumb: frame, at: Date.now() });
        setNote(null);
      } else {
        if (result === "error") item.current = null;
        setNote("The persona did not confirm the latest screen frame; retrying.");
      }
    } catch {
      // A missed frame is fine; the next round follows.
    } finally {
      syncing.current = false;
    }
  }

  // While sharing, keep the persona's frame current (share() sends the first one right away).
  useEffect(() => {
    if (!stream) return;
    const loop = setInterval(() => void sync(stream), SYNC_MS);
    const tick = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      clearInterval(loop);
      clearInterval(tick);
    };
    // sync reads refs only; restarting it per render would reset the interval.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [stream]);

  async function share() {
    if (picking.current) return;
    picking.current = true;
    setNote(null);
    try {
      // This tab shows the call itself, so it is left out of the picker: share the prototype instead.
      const options = { video: true, audio: false, selfBrowserSurface: "exclude", surfaceSwitching: "include" };
      const s = await navigator.mediaDevices.getDisplayMedia(options as DisplayMediaStreamOptions);
      // Granted after the interview ended: don't leave the screen captured.
      if (!mounted.current) {
        s.getTracks().forEach((t) => t.stop());
        return;
      }
      // The browser's own "Stop sharing" ends the track; mirror that here.
      s.getVideoTracks()[0]?.addEventListener("ended", () => current.current === s && stop(), { once: true });
      current.current = s;
      paused.current = false;
      setStream(s);
      sharingChanged.current?.(true);
      void sync(s);
    } catch {
      if (mounted.current) setNote("Screen sharing was cancelled or blocked.");
    } finally {
      picking.current = false;
    }
  }

  function stop() {
    current.current?.getTracks().forEach((t) => t.stop());
    current.current = null;
    // The persona should not keep reasoning about a screen that is no longer shown.
    const dc = channel?.current;
    if (item.current && dc?.readyState === "open") {
      try {
        dc.send(JSON.stringify({ type: "conversation.item.delete", item_id: item.current, event_id: `${prefix.current}_del_${++seq.current}` }));
      } catch {}
    }
    item.current = image.current = null;
    if (!mounted.current) return;
    setStream(null);
    setSeen(null);
    sharingChanged.current?.(false);
  }

  async function show() {
    const shared = stream;
    if (!shared) return;
    setBusy(true);
    setNote(null);
    try {
      const frame = await captureFrame(shared, { maxBytes: limit() });
      // Sharing stopped (or the card closed) while capturing: send nothing.
      if (!mounted.current || current.current !== shared) return;
      // The persona reacts to what it now sees, in character.
      const sent = ask([
        { type: "input_text", text: LABEL },
        { type: "input_image", image_url: frame },
      ]);
      setNote(sent ? "Shown to the persona." : "The call is not open.");
    } catch (e) {
      if (mounted.current) setNote(e instanceof Error ? e.message : "Could not capture the screen.");
    } finally {
      if (mounted.current) setBusy(false);
    }
  }

  const btn = "rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-muted";

  return (
    <>
      {!stream ? (
        <button type="button" className={btn} onClick={share} title="Share the prototype's tab or window">
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
          <button type="button" className={btn} onClick={stop}>
            Stop sharing
          </button>
          {channel && (
            <span className="flex items-center gap-2 text-xs text-muted" role="status" data-testid="screen-status">
              {seen ? (
                <>
                  {/* eslint-disable-next-line @next/next/no-img-element -- a local data URL, nothing to optimise */}
                  <img src={seen.thumb} alt="What the persona currently sees" className="h-8 w-auto rounded border border-line" />
                  Persona sees your screen · updated {ago(now - seen.at)}
                </>
              ) : (
                "Sending your screen to the persona…"
              )}
            </span>
          )}
        </>
      )}
      {note && <span className="text-xs text-muted">{note}</span>}
    </>
  );
}
