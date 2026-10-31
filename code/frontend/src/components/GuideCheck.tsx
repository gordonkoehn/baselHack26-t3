"use client";

import { useState } from "react";
import { ApiError, api } from "@/lib/api";
import { NETWORK_ERROR } from "@/lib/errorMessage";
import type { GuideIssue, GuideReviewItem, Language } from "@/lib/contracts";

const ISSUE_LABEL: Record<GuideIssue, string> = {
  leading: "Leading",
  hypothetical: "Hypothetical",
  closed: "Yes/no",
  pitch: "Pitch",
};

function errorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return NETWORK_ERROR;
  if (e.status === 401) return "This needs the team link with the passcode. Ask in Discord.";
  if (e.status === 422) return "Keep it to 50 questions of at most 500 characters each.";
  // The backend's detail says how long to wait.
  if (e.status === 429) return e.detail;
  return "Could not check the questions right now. Try again.";
}

// Mom Test check of the interview guide before the interview starts. `guide` is the textarea's
// text: one question per line, the same way InterviewRoom turns it into the session's guide.
export function GuideCheck({
  guide,
  language,
  onGuideChange,
}: {
  guide: string;
  language: Language;
  onGuideChange: (guide: string) => void;
}) {
  const [result, setResult] = useState<{ guide: string; items: GuideReviewItem[] } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const lines = guide.split("\n").map((line) => line.trim());
  const questions = lines.filter(Boolean);
  // The answer describes the text that was sent: a line edited or rewritten since then drops out.
  const flagged = result?.items.filter((i) => i.issues.length > 0 && lines.includes(i.question)) ?? [];
  const allClear = result?.guide === guide && result.items.every((i) => i.issues.length === 0);

  async function check() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const { items } = await api.reviewGuide({ questions, language });
      setResult({ guide, items });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setBusy(false);
    }
  }

  function applyRewrite(question: string, rewrite: string) {
    const next = guide.split("\n");
    next[lines.indexOf(question)] = rewrite;
    onGuideChange(next.join("\n"));
  }

  return (
    <div className="mt-2" data-testid="guide-check">
      <button
        type="button"
        className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-muted disabled:opacity-50"
        disabled={busy || questions.length === 0}
        onClick={check}
      >
        {busy ? "Checking…" : "Check questions"}
      </button>
      {error && (
        <p role="alert" className="mt-2 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}
      {allClear && <p className="mt-2 text-sm text-muted">No leading, hypothetical, yes/no or pitch questions found.</p>}
      {flagged.length > 0 && (
        <ul className="mt-2 space-y-2">
          {flagged.map((item, i) => (
            <li key={`${i}:${item.question}`} className="rounded-md border border-line bg-surface p-3 text-sm">
              <p>{item.question}</p>
              <p className="mt-1 flex flex-wrap gap-1">
                {item.issues.map((issue) => (
                  <span key={issue} className="rounded-full bg-accent-soft px-2 py-0.5 text-xs font-medium text-accent">
                    {ISSUE_LABEL[issue]}
                  </span>
                ))}
              </p>
              {item.rewrite !== null && (
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="min-w-0 flex-1 text-muted">{item.rewrite}</span>
                  <button
                    type="button"
                    className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-muted"
                    onClick={() => applyRewrite(item.question, item.rewrite!)}
                  >
                    Use rewrite
                  </button>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
