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

  // Not interviews: a session that never went live (mic refused, connection failed), the scripted
  // sample, and a test call from the persona tab, which is the only start without questions.
  const interviews = sessions.filter((s) => s.startedAt && !s.sample && s.interviewGuide?.length);
  if (interviews.length === 0) return null;

  return (
    <section aria-labelledby="past-interviews" className="mt-6 rounded-xl border border-line bg-surface p-5 shadow-sm">
      <h2 id="past-interviews" className="text-sm font-semibold">
        Past interviews
      </h2>
      <ul className="mt-2 divide-y divide-line">
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
            <li key={s.id}>
              {s.debriefReady ? (
                <a
                  href={`/report/${encodeURIComponent(s.id)}`}
                  target="_blank"
                  rel="noopener"
                  className={`${layout} hover:text-accent`}
                >
                  {row}
                </a>
              ) : (
                <div className={layout}>{row}</div>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
