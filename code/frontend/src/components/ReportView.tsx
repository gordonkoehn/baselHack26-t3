"use client";

import { useEffect, useState } from "react";
import { DebriefView } from "@/components/DebriefView";
import { ApiError, api } from "@/lib/api";
import type { InsightReport } from "@/lib/contracts";

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "failed" }
  | { kind: "ready"; report: InsightReport; personaName: string };

// One saved debrief for whoever has the link. It only reads, so a browser without the team passcode
// works, and opening a link can never spend model credit.
export function ReportView({ sessionId }: { sessionId: string }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const session = await api.getSession(sessionId);
        const [persona, report] = await Promise.all([api.getPersona(session.personaId), api.getInsights(sessionId)]);
        if (!cancelled) setState({ kind: "ready", report, personaName: persona.name });
      } catch (e) {
        if (!cancelled) setState({ kind: e instanceof ApiError && e.status === 404 ? "missing" : "failed" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [sessionId, attempt]);

  if (state.kind === "loading") return <p className="text-sm text-muted">Loading debrief…</p>;

  if (state.kind === "missing") {
    return (
      <section className="rounded-xl border border-line bg-surface p-5">
        <h2 className="text-sm font-semibold">Debrief not found</h2>
        <p className="mt-1 text-sm text-muted">
          The link may be wrong or expired, or the debrief for this interview has not been written yet.
        </p>
      </section>
    );
  }

  if (state.kind === "failed") {
    return (
      <div>
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          Could not load this debrief right now.
        </p>
        <button
          type="button"
          className="mt-3 rounded-md border border-line bg-surface px-3 py-2 text-sm font-medium hover:bg-line"
          onClick={() => {
            setState({ kind: "loading" });
            setAttempt((n) => n + 1);
          }}
        >
          Try again
        </button>
      </div>
    );
  }

  return <DebriefView sessionId={sessionId} personaName={state.personaName} savedReport={state.report} />;
}
