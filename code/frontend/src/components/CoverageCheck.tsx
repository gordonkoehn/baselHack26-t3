"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { CoverageCriterion, CoverageReport, Persona, PersonaSource } from "@/lib/contracts";

const STORAGE_KEY = "opentwin.coverage";

// Matches the bundled Quartier-Börse sample, so the demo works with one click.
const SAMPLE_GOAL =
  "Quartier-Börse prototype: recycling pickup subscribers split their Kilo-Shares between their own rewards and a neighbourhood project that a local partner doubles.";

const STATUS: Record<CoverageCriterion["status"], { label: string; className: string }> = {
  covered: { label: "covered", className: "bg-accent-soft text-accent" },
  guessed: { label: "guessed", className: "bg-line text-foreground" },
  missing: { label: "missing", className: "bg-red-50 text-red-800 dark:bg-red-950 dark:text-red-200" },
};

function errorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return "Backend not reachable.";
  if (e.status === 401) return "This needs the team link with the passcode.";
  if (e.status === 502) return "The model's answer couldn't be used. Try again.";
  if (e.status === 503) return "The coverage service is temporarily unavailable.";
  return `Could not check (${e.status}): ${e.detail}`;
}

export function CoverageCheck({
  persona,
  onAnswered,
  onReport,
}: {
  persona: Persona;
  /** The patched persona and the note source the backend stored the answers as. */
  onAnswered: (persona: Persona, source: PersonaSource) => void;
  /** Every new report, so the workspace can show the score outside this panel. */
  onReport: (report: CoverageReport) => void;
}) {
  const [goal, setGoal] = useState(SAMPLE_GOAL);
  const [criteria, setCriteria] = useState<string[]>([]);
  // The goal and own criteria are remembered per browser, so a reload or a new persona keeps them.
  // Loaded after mount: the server render has no storage, and both renders must match.
  const loaded = useRef(false);
  useEffect(() => {
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
      /* eslint-disable react-hooks/set-state-in-effect -- one-time restore from storage */
      if (typeof saved?.goal === "string" && saved.goal.trim()) setGoal(saved.goal);
      if (Array.isArray(saved?.criteria)) setCriteria(saved.criteria.filter((c: unknown) => typeof c === "string").slice(0, 8));
      /* eslint-enable react-hooks/set-state-in-effect */
    } catch {}
    loaded.current = true;
  }, []);
  useEffect(() => {
    if (!loaded.current) return;
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ goal, criteria }));
    } catch {}
  }, [goal, criteria]);
  const [newCriterion, setNewCriterion] = useState("");
  const [report, setReport] = useState<CoverageReport | null>(null);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check() {
    setChecking(true);
    setError(null);
    try {
      const next = await api.checkCoverage(persona.id, { testGoal: goal, criteria });
      setReport(next);
      onReport(next);
      setAnswers({});
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }

  const given = (report?.questions ?? [])
    .map((question, i) => ({ question, answer: answers[i]?.trim() ?? "" }))
    .filter((a) => a.answer);

  // The persona keeps its id and gains facts; then the same test is checked again, so the score
  // change shows without another click (the backend keeps weights and still-backed rows).
  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const patched = await api.answerGaps(persona.id, { answers: given });
      // Same layout as the backend's stored source; the card only shows its title.
      const text = given.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
      onAnswered(patched, { kind: "note", title: "Answers to gap questions", text });
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
      return;
    }
    setSubmitting(false);
    await check();
  }

  // A rebuild makes a new persona; edits and answers bump the version.
  const stale = report !== null && (report.personaId !== persona.id || report.personaVersion !== persona.version);
  const busy = checking || submitting;

  return (
    <section className="rounded-xl border border-line bg-surface p-5 shadow-sm" data-testid="coverage-check">
      <h2 className="text-xl font-semibold tracking-tight">Is this persona good enough for your test?</h2>
      <p className="text-sm text-muted">
        Checks what the persona really knows against what you will test, and asks you for what is missing.
      </p>
      <label className="mt-4 block text-sm font-medium" htmlFor="test-goal">
        What will you test with this persona?
      </label>
      <textarea
        id="test-goal"
        className="mt-1 h-20 w-full rounded-md border border-line bg-surface p-2 text-sm"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
        disabled={busy}
      />

      <div className="mt-2 flex flex-wrap items-center gap-2 text-sm">
        {criteria.map((c) => (
          <span key={c} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface px-2 py-0.5">
            {c}
            <button
              type="button"
              className="text-muted hover:text-foreground"
              aria-label={`Remove criterion: ${c}`}
              onClick={() => setCriteria((cs) => cs.filter((x) => x !== c))}
              disabled={busy}
            >
              ×
            </button>
          </span>
        ))}
        {criteria.length < 8 && (
          <input
            aria-label="Add your own criterion"
            placeholder="+ own criterion, e.g. cares about design"
            className="min-w-56 flex-1 rounded-md border border-line bg-surface px-2 py-1"
            value={newCriterion}
            maxLength={120}
            onChange={(e) => setNewCriterion(e.target.value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter") return;
              const c = newCriterion.trim();
              if (c && !criteria.some((x) => x.toLowerCase() === c.toLowerCase())) setCriteria([...criteria, c]);
              setNewCriterion("");
            }}
            disabled={busy}
          />
        )}
      </div>

      <div className="mt-3 flex flex-wrap items-center gap-3">
        <button
          type="button"
          className="rounded-md bg-accent px-4 py-2 text-sm font-medium text-surface hover:opacity-90 disabled:opacity-40"
          onClick={check}
          disabled={busy || !goal.trim()}
        >
          {checking ? "Checking…" : report ? "Check again" : "Check coverage"}
        </button>
        {stale && <span className="text-sm text-muted">The persona changed since this check.</span>}
      </div>

      {error && (
        <p role="alert" className="mt-3 rounded-md bg-red-50 p-3 text-sm text-red-800 dark:bg-red-950 dark:text-red-200">
          {error}
        </p>
      )}

      {report && (
        <div className="mt-4">
          <p className="flex flex-wrap items-baseline gap-3">
            <span className="text-3xl font-semibold tabular-nums" data-testid="coverage-score">
              {Math.round(report.score * 100)}%
            </span>
            <span
              className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                report.recommendation === "ready" ? "bg-accent-soft text-accent" : STATUS.missing.className
              }`}
            >
              {report.recommendation === "ready" ? "Covers this test" : "Gaps to fill"}
            </span>
          </p>
          <ul className="mt-3 divide-y divide-line text-sm">
            {report.criteria.map((c) => (
              <li key={c.name} className="flex flex-wrap items-baseline gap-x-2 py-1.5">
                <span className={`inline-block w-16 rounded px-1.5 py-0.5 text-center text-xs font-medium ${STATUS[c.status].className}`}>
                  {/* One quote counts less in the score (0.75); say so instead of a plain "covered". */}
                  {c.status === "covered" && c.evidenceIds.length === 1 ? "thin" : STATUS[c.status].label}
                </span>
                <span className="font-medium">
                  {c.name}
                  {c.custom && <span className="ml-1 text-xs font-normal text-muted">(yours)</span>}
                </span>
                <span className="text-xs text-muted" aria-label={`weight ${c.weight} of 3`}>
                  {"●".repeat(c.weight)}
                  {"○".repeat(3 - c.weight)}
                </span>
                <span className="basis-full pl-[4.5rem] text-muted">
                  {c.note}
                  {c.evidenceIds.length > 0 && ` · ${c.evidenceIds.join(", ")}`}
                </span>
              </li>
            ))}
          </ul>

          {report.questions.length > 0 && (
            <div className="mt-4 space-y-3">
              <p className="text-sm font-medium">Fill the gaps: answer what you know about real customers</p>
              {report.questions.map((q, i) => (
                <label key={q} className="block text-sm">
                  {q}
                  <textarea
                    className="mt-1 h-16 w-full rounded-md border border-line bg-surface p-2"
                    value={answers[i] ?? ""}
                    onChange={(e) => setAnswers({ ...answers, [i]: e.target.value })}
                    disabled={busy}
                  />
                </label>
              ))}
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  className="rounded-md border border-line bg-surface px-3 py-1.5 text-sm hover:border-muted disabled:opacity-40"
                  onClick={submit}
                  disabled={busy || given.length === 0}
                >
                  {submitting ? "Adding to persona…" : "Add answers to persona"}
                </button>
                <span className="text-sm text-muted">or interview anyway below.</span>
              </div>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
