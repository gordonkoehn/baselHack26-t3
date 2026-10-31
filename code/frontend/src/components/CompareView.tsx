"use client";

import { useEffect, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { InsightSummary } from "@/lib/contracts";

type State =
  | { kind: "loading" }
  | { kind: "missing" }
  | { kind: "sample" }
  | { kind: "failed" }
  | { kind: "ready"; summary: InsightSummary };

function Notice({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-5">
      <h2 className="text-sm font-semibold">{title}</h2>
      <p className="mt-1 text-sm text-muted">{children}</p>
    </section>
  );
}

// Per sprint question, how many of these interviews support or contradict it, with the quotes
// behind that. Only reads saved debriefs, so opening this can never spend model credit.
export function CompareView({ sessionIds }: { sessionIds: string[] }) {
  const [state, setState] = useState<State>({ kind: "loading" });
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (sessionIds.length === 0) return;
    let cancelled = false;
    api
      .insightSummary(sessionIds)
      .then((summary) => {
        if (!cancelled) setState({ kind: "ready", summary });
      })
      .catch((e) => {
        if (cancelled) return;
        const status = e instanceof ApiError ? e.status : null;
        setState({ kind: status === 404 ? "missing" : status === 409 ? "sample" : "failed" });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionIds, attempt]);

  if (sessionIds.length === 0) {
    return <Notice title="Nothing to compare">Tick two or more debriefs under a persona&apos;s past interviews.</Notice>;
  }

  if (state.kind === "loading") return <p className="text-sm text-muted">Loading comparison…</p>;

  if (state.kind === "missing") {
    return (
      <Notice title="Debrief not found">
        The link may be wrong or expired, or one of these interviews has no debrief yet. Nothing is counted until all of
        them have one.
      </Notice>
    );
  }

  if (state.kind === "sample") {
    return (
      <Notice title="Sample interview included">
        A sample interview is a scripted demo transcript, so it can&apos;t be counted as somebody&apos;s answer. Compare
        real interviews only.
      </Notice>
    );
  }

  if (state.kind === "failed") {
    return (
      <div>
        <p role="alert" className="rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          Could not load this comparison right now.
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

  return (
    <>
      <p className="mb-4 text-sm text-muted">
        Each count is one interview. Quotes are verbatim from the simulated interviews, and open their source interview.
        &ldquo;grounded&rdquo; means the persona&apos;s real sources say it too.
      </p>
      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm" data-testid="compare-table">
          <thead>
            <tr className="text-xs text-muted">
              <th scope="col" className="p-3 text-left font-medium">
                Sprint question
              </th>
              <th scope="col" className="px-1.5 py-3 text-right font-medium sm:px-3">
                Supports
              </th>
              <th scope="col" className="px-1.5 py-3 text-right font-medium sm:px-3">
                Contradicts
              </th>
              <th scope="col" className="px-1.5 py-3 text-right font-medium sm:px-3">
                Unclear
              </th>
            </tr>
          </thead>
          {state.summary.questions.map((q) => (
            <tbody key={q.question} className="border-t border-line">
              <tr>
                <th scope="row" className="p-3 text-left font-medium wrap-break-word">
                  {q.question}
                </th>
                <td className="px-1.5 py-3 text-right tabular-nums sm:px-3">{q.supports}</td>
                <td className="px-1.5 py-3 text-right tabular-nums sm:px-3">{q.contradicts}</td>
                <td className="px-1.5 py-3 text-right tabular-nums sm:px-3">{q.unclear}</td>
              </tr>
              {q.insights.length > 0 && (
                <tr>
                  <td colSpan={4} className="px-3 pb-3">
                    <ul className="space-y-3">
                      {q.insights.map((i) => (
                        // Insight ids are only unique within one report.
                        <li key={`${i.sessionId}/${i.id}`} className="leading-relaxed">
                          <span className="mr-2 inline-flex items-center gap-1.5 font-mono text-xs font-medium">
                            <span className="evidence-bar !w-6" data-grounded={i.label === "grounded"} aria-hidden />
                            {i.label === "grounded" ? "grounded" : "guess"}
                          </span>
                          {i.theme}
                          <a
                            href={`/report/${encodeURIComponent(i.sessionId)}`}
                            target="_blank"
                            rel="noopener"
                            className="group mt-1.5 block hover:text-accent"
                          >
                            <blockquote
                              className={`border-l-2 pl-3 wrap-anywhere ${
                                i.label === "grounded" ? "border-accent/40" : "border-line"
                              }`}
                            >
                              “{i.quote}”
                              <span className="mt-0.5 block text-xs text-muted group-hover:text-accent">
                                <span className="underline">Interview {sessionIds.indexOf(i.sessionId) + 1}</span>
                                {` · turn ${i.turnSeq}`}
                                {i.label === "grounded" ? " · also in the sources" : " · not backed by the sources"}
                              </span>
                            </blockquote>
                          </a>
                        </li>
                      ))}
                    </ul>
                  </td>
                </tr>
              )}
            </tbody>
          ))}
        </table>
      </div>
    </>
  );
}
