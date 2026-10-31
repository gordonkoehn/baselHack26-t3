"use client";

import { useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { InsightReport } from "@/lib/contracts";

const SIGNAL = {
  supports: { text: "supports", className: "bg-green-100 text-green-800" },
  contradicts: { text: "contradicts", className: "bg-red-100 text-red-800" },
  unclear: { text: "unclear", className: "bg-gray-100 text-gray-600" },
} as const;

// Debrief of one ended interview: per sprint question, what the persona's answers say about it.
// Quotes come from the synthetic interview, so "grounded" means "said in this interview", not
// "validated with real users".
export function DebriefView({ sessionId, personaName }: { sessionId: string; personaName: string }) {
  const [report, setReport] = useState<InsightReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setLoading(true);
    setError(null);
    try {
      // Repeated POSTs return the saved report, so a retry after a network error is safe.
      setReport(await api.debrief(sessionId));
    } catch (e) {
      if (!(e instanceof ApiError)) setError("Backend not reachable.");
      else if (e.status === 409) setError(`The transcript is not complete yet: ${e.detail}`);
      else if (e.status === 503) setError("The debrief model is unavailable right now. Try again in a moment.");
      else setError(`Debrief failed (${e.status}): ${e.detail}`);
    } finally {
      setLoading(false);
    }
  }

  if (!report) {
    return (
      <div className="mt-4">
        <button
          type="button"
          className="rounded bg-foreground px-3 py-1.5 text-sm text-background disabled:opacity-50"
          onClick={create}
          disabled={loading}
        >
          {loading ? "Writing debrief…" : "Create debrief"}
        </button>
        {error && (
          <p role="alert" className="mt-2 rounded bg-red-50 p-3 text-sm text-red-800">
            {error}
          </p>
        )}
      </div>
    );
  }

  return (
    <div className="mt-6" data-testid="debrief">
      <h3 className="text-sm font-semibold uppercase tracking-wide opacity-60">Debrief</h3>
      <p className="mt-1 text-xs opacity-60">
        Quotes are from the interview with {personaName}, an AI persona: hypotheses to check with real users, not
        findings.
      </p>
      <ol className="mt-3 space-y-5">
        {report.questions.map((q) => (
          <li key={q.question}>
            <p className="text-sm font-medium">
              <span className={`mr-2 inline-block rounded px-1.5 py-0.5 text-xs ${SIGNAL[q.signal].className}`}>
                {SIGNAL[q.signal].text}
              </span>
              {q.question}
            </p>
            <ul className="mt-2 space-y-2">
              {q.insights.map((i) => (
                <li key={i.id} className="text-sm">
                  <span
                    className={`mr-2 inline-block rounded px-1.5 py-0.5 text-xs font-medium ${
                      i.label === "grounded" ? "bg-green-100 text-green-800" : "bg-gray-100 text-gray-600"
                    }`}
                  >
                    {i.label === "grounded" ? "grounded" : "guess"}
                  </span>
                  {i.theme}
                  {i.label === "grounded" && (
                    <blockquote className="mt-1 border-l-2 border-green-300 pl-3 opacity-80">
                      “{i.quote}”
                      <span className="block text-xs opacity-50">
                        {personaName} · interview turn {i.turnSeq}
                      </span>
                    </blockquote>
                  )}
                </li>
              ))}
            </ul>
            {q.followUps && q.followUps.length > 0 && (
              <p className="mt-2 text-xs opacity-70">Ask real users next: {q.followUps.join(" · ")}</p>
            )}
          </li>
        ))}
      </ol>
    </div>
  );
}
