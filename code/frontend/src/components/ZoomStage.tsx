"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

// Wraps call media (shared screen or avatar + camera) so the interviewer can expand it to the
// browser's full screen for demos. Esc exits; the rest of the call keeps running underneath.
export function ZoomStage({
  label,
  children,
  className = "",
}: {
  label: string;
  children: ReactNode;
  className?: string;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [zoomed, setZoomed] = useState(false);

  useEffect(() => {
    const onChange = () => setZoomed(document.fullscreenElement === root.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  async function toggle() {
    const el = root.current;
    if (!el) return;
    try {
      if (document.fullscreenElement === el) await document.exitFullscreen();
      else await el.requestFullscreen();
    } catch {
      // Denied or unsupported: stay in the normal layout.
    }
  }

  return (
    <div
      ref={root}
      data-testid="zoom-stage"
      data-zoomed={zoomed ? "true" : "false"}
      className={`relative rounded-2xl border border-line bg-room p-3 text-room-text ${
        zoomed ? "flex h-full w-full flex-col" : ""
      } ${className}`}
    >
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-room-muted">
          <span aria-hidden className="size-1.5 rounded-full bg-signal" />
          {label}
        </p>
        <button
          type="button"
          className="rounded-md border border-line bg-room-raised px-3 py-1.5 text-sm font-bold text-room-text hover:border-room-muted"
          onClick={toggle}
          aria-pressed={zoomed}
        >
          {zoomed ? "Exit full screen" : "Full screen"}
        </button>
      </div>
      <div className={zoomed ? "flex min-h-0 flex-1 items-center justify-center" : ""}>{children}</div>
    </div>
  );
}
