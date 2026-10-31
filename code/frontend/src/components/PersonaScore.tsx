"use client";

import type { CoverageCategory, Persona, PersonaSource } from "@/lib/contracts";
import { localDiversity, type Coverage } from "@/lib/useCoverage";

// The word is what counts: colour alone must never carry the level.
const LEVEL: Record<CoverageCategory["level"], { word: string; text: string; chip: string }> = {
  red: { word: "Red", text: "text-on-alert", chip: "bg-alert-tint text-on-alert" },
  yellow: { word: "Yellow", text: "text-on-warn", chip: "bg-warn-tint text-on-warn" },
  green: { word: "Green", text: "text-on-tint", chip: "bg-accent-soft text-on-tint" },
};

const CATEGORIES: { id: CoverageCategory["category"]; title: string; question: string }[] = [
  { id: "persona", title: "Persona", question: "Do we know the person well enough to act authentically?" },
  { id: "challenge", title: "Challenge understanding", question: "How well do we know the problem and its process steps?" },
  { id: "solution", title: "Solution", question: "How well is what we're testing described?" },
];

const BUTTON = "rounded-lg px-5 py-2.5 text-sm font-bold";
const PRIMARY = `${BUTTON} bg-accent text-surface hover:opacity-90`;
const SECONDARY = `${BUTTON} border border-line bg-surface hover:border-muted`;

/**
 * Screen 1: is this persona good enough to test with? Advice only: both buttons always work, so
 * nothing here can stop an interview, not even a check that failed.
 */
export function PersonaScore({
  persona,
  sources,
  coverage,
  onInterview,
  onAddMore,
}: {
  persona: Persona;
  sources: PersonaSource[];
  coverage: Coverage;
  onInterview: () => void;
  onAddMore: () => void;
}) {
  const { current, stale, personaChanged, checking, error, check } = coverage;
  const diversity = current?.sourceDiversity ?? localDiversity(sources);
  const addMore = current?.overall === "add_more";
  const goodEnough = current?.overall === "good_enough";

  return (
    <section aria-labelledby="persona-score" className="space-y-4" data-testid="persona-score">
      <div>
        <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-widest text-accent">
          <span aria-hidden className="size-2 rounded-full bg-signal" />
          Score
        </p>
        <h2 id="persona-score" className="mt-1 text-2xl font-extrabold tracking-tight">
          Your persona: {persona.name}.
        </h2>
        <p className="line-clamp-2 max-w-3xl text-muted">{persona.summary}</p>
      </div>

      <ul className="grid gap-3 sm:grid-cols-3">
        {CATEGORIES.map((c) => (
          <Category key={c.id} {...c} result={current?.categories.find((x) => x.category === c.id) ?? null} />
        ))}
      </ul>

      <p className="text-sm" data-testid="source-diversity">
        <span className="font-bold">Source diversity:</span>{" "}
        {diversity ? (
          <>
            {diversity.count} of at least {diversity.minimum} sources
            {diversity.kinds.length > 0 && ` (${diversity.kinds.join(", ")})`}
            {!diversity.met && ". Too few to rely on."}
          </>
        ) : (
          "not counted yet."
        )}
      </p>

      <div className="flex flex-wrap items-center gap-3 border-t border-line pt-4">
        <div className="mr-auto min-w-0" data-testid="score-overall">
          {addMore || goodEnough ? (
            <p className="text-xl font-extrabold tracking-tight">{addMore ? "Add more first." : "Good enough to test."}</p>
          ) : checking ? (
            <p role="status" className="text-xl font-extrabold tracking-tight">
              Checking {persona.name}. You can go on meanwhile.
            </p>
          ) : (
            <div role={error ? "alert" : undefined} className="text-sm">
              <p className="text-xl font-extrabold tracking-tight">{current || stale ? "Needs a new check." : "No check has run yet."}</p>
              <p className="text-muted">
                {error ??
                  (current
                    ? "The overall result is unavailable. You can still go to the interview."
                    : personaChanged
                      ? `${persona.name} changed since the last check.`
                      : stale
                        ? "The test changed since the last check."
                        : "You can still go to the interview.")}{" "}
                <button type="button" className="font-bold text-accent underline" onClick={() => void check()}>
                  Check now
                </button>
              </p>
            </div>
          )}
        </div>
        <button type="button" className={addMore ? PRIMARY : SECONDARY} onClick={onAddMore}>
          Add more
        </button>
        <button type="button" className={goodEnough ? PRIMARY : SECONDARY} onClick={onInterview}>
          Go to the interview
        </button>
      </div>
    </section>
  );
}

function Category({
  title,
  question,
  result,
}: {
  title: string;
  question: string;
  result: CoverageCategory | null;
}) {
  const level = result && LEVEL[result.level];
  return (
    <li className="flex flex-col rounded-2xl border border-line bg-surface p-4 shadow-sm" data-testid={`score-${title}`}>
      <h3 className="font-bold">{title}</h3>
      <p className="text-xs text-muted">{question}</p>
      <p className="mt-2 flex items-center gap-2">
        <span className={`text-5xl font-extrabold tracking-tight tabular-nums ${level?.text ?? "text-muted"}`}>
          {result ? `${Math.round(result.score * 100)}%` : "–"}
        </span>
        <span className={`rounded-full px-2.5 py-1 text-xs font-bold uppercase tracking-widest ${level?.chip ?? "bg-line text-foreground"}`}>
          {level?.word ?? "Not checked"}
        </span>
      </p>
      {result && (
        <div className="mt-2 space-y-1 text-sm">
          <p className="text-muted">{result.reason}</p>
          {result.recommendation && <p>{result.recommendation}</p>}
        </div>
      )}
    </li>
  );
}
