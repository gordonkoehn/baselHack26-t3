"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";
import type { Session } from "@/lib/contracts";

function duration(startedAt: string, endedAt: string): string {
  const seconds = Math.round((Date.parse(endedAt) - Date.parse(startedAt)) / 1000);
  return seconds < 60 ? `${seconds} s` : `${Math.round(seconds / 60)} min`;
}

// A persona's earlier interviews, so a debrief survives a reload. Debriefs open in a new tab: this
// page may hold a call that is still saving, and leaving it would lose that.
// `version` changes when an interview here ended or got its debrief, which refetches the list.
export function PastInterviews({ personaId, version }: { personaId: string; version: number }) {
  const [sessions, setSessions] = useState<Session[]>([]);
  const [picked, setPicked] = useState<string[]>([]);

  // Optional, like the persona list: without the passcode or a store it just stays away.
  useEffect(() => {
    let current = true;
    api
      .listPersonaSessions(personaId)
      .then((list) => {
        if (current) setSessions(list);
      })
      .catch(() => {});
    return () => {
      current = false;
    };
  }, [personaId, version]);

  // A session that never went live (mic refused, connection failed) was no interview, and neither
  // was a test call from the persona tab, which has no questions.
  const interviews = sessions.filter((s) => s.startedAt && s.interviewGuide?.length);
  if (interviews.length === 0) return null;
  const ready = interviews.filter((s) => s.debriefReady);
  // Oldest first, so "Interview 1" in the comparison is the earliest one.
  const compared = ready.filter((s) => picked.includes(s.id)).reverse();

  return (
    <section aria-labelledby="past-interviews" className="mt-6">
      <h3 id="past-interviews" className="mb-2 text-xs font-semibold uppercase tracking-widest text-muted">
        Past interviews
      </h3>
      <ul className="divide-y divide-line">
        {interviews.map((s) => {
          const row = (
            <>
              <span className="tabular-nums">
                {new Date(s.startedAt!).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}
              </span>
              {s.endedAt && <span className="tabular-nums text-muted">{duration(s.startedAt!, s.endedAt)}</span>}
              {/* Still "live" afterwards means the call was left without ending it, for example by a reload. */}
              <span className="text-muted">{s.status === "ended" ? "Ended" : "Not ended"}</span>
              {s.debriefReady && <span className="ml-auto font-medium text-accent">Debrief ready</span>}
            </>
          );
          const layout = "flex flex-wrap items-baseline gap-x-3 py-2 text-sm";
          return (
            <li key={s.id} className="flex items-baseline gap-3">
              {ready.length >= 2 &&
                (s.debriefReady ? (
                  <input
                    type="checkbox"
                    className="size-4 shrink-0 self-center accent-accent"
                    aria-label={`Compare interview of ${new Date(s.startedAt!).toLocaleString([], { dateStyle: "short", timeStyle: "short" })}`}
                    checked={picked.includes(s.id)}
                    onChange={(e) =>
                      setPicked((ids) => (e.target.checked ? [...ids, s.id] : ids.filter((id) => id !== s.id)))
                    }
                  />
                ) : (
                  <span className="w-4 shrink-0" aria-hidden />
                ))}
              {s.debriefReady ? (
                <a
                  href={`/report/${encodeURIComponent(s.id)}`}
                  target="_blank"
                  rel="noopener"
                  className={`${layout} min-w-0 flex-1 hover:text-accent`}
                >
                  {row}
                </a>
              ) : (
                <div className={`${layout} min-w-0 flex-1`}>{row}</div>
              )}
            </li>
          );
        })}
      </ul>
      {ready.length >= 2 && (
        <p className="mt-2 text-sm text-muted">
          {compared.length >= 2 ? (
            <a
              href={`/compare?${new URLSearchParams(compared.map((s) => ["id", s.id]))}`}
              target="_blank"
              rel="noopener"
              className="inline-block rounded-md border border-line bg-surface px-3 py-1.5 font-medium text-foreground hover:border-muted"
            >
              Compare {compared.length} interviews
            </a>
          ) : (
            "Tick two or more debriefs to compare them."
          )}
        </p>
      )}
    </section>
  );
}
