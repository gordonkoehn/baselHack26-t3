"use client";

import { useEffect, useRef, useState } from "react";
import { ApiError, api } from "@/lib/api";
import type { CoverageReport, Persona, PersonaSource, SourceDiversity } from "@/lib/contracts";
import { QUARTIER_BOERSE } from "@/lib/sample";

const STORAGE_KEY = "opentwin.coverage";
const MIN_SOURCES = 2;
// The team's own answers, stored as a note: no extra source, on the server either.
const ANSWERS_TITLE = "Answers to gap questions";

// Matches the bundled Quartier-Börse sample, so the demo works with one click.
export const SAMPLE_GOAL =
  "Quartier-Börse prototype: recycling pickup subscribers split their Kilo-Shares between their own rewards and a neighbourhood project that a local partner doubles.";
// Until someone says what they test: never the sample's goal for someone else's persona.
export const OPEN_GOAL = "The product, prototype or change that the sources describe.";

function errorMessage(e: unknown): string {
  if (!(e instanceof ApiError)) return "Backend not reachable.";
  if (e.status === 401) return "This needs the team link with the passcode.";
  if (e.status === 502) return "The model's answer couldn't be used. Try again.";
  if (e.status === 503) return "The coverage service is temporarily unavailable.";
  return `Could not check (${e.status}): ${e.detail}`;
}

const norm = (text: string) => text.split(/\s+/).filter(Boolean).join(" ").toLowerCase();

/** The goal to start with: what this browser's user wrote, else one that fits the sources. */
export function startingInput(saved: unknown, sources: PersonaSource[]): { goal: string; criteria: string[] } {
  const { goal, criteria } = (saved ?? {}) as { goal?: unknown; criteria?: unknown };
  const own = typeof goal === "string" && goal.trim() && goal !== SAMPLE_GOAL ? goal : null;
  return {
    goal: own ?? (sources.some((s) => s.text === QUARTIER_BOERSE) ? SAMPLE_GOAL : OPEN_GOAL),
    criteria: Array.isArray(criteria) ? criteria.filter((c): c is string => typeof c === "string").slice(0, 8) : [],
  };
}

/** The source count before any check: the server's rule, for the sources this browser holds. */
export function localDiversity(sources: PersonaSource[]): SourceDiversity | null {
  // A persona from the library keeps its sources on the server.
  if (sources.length === 0) return null;
  const real = sources.filter((s) => s.title !== ANSWERS_TITLE);
  const distinct = new Map(real.map((s) => [norm(s.text), s.kind]));
  const count = distinct.size;
  return { count, kinds: [...new Set(distinct.values())], minimum: MIN_SOURCES, met: count >= MIN_SOURCES };
}

/** Is this report about this test? Own criteria as the server keeps them: repeats are dropped. */
export function sameTest(report: CoverageReport, goal: string, criteria: string[]): boolean {
  const defaults = report.criteria.filter((c) => !c.custom).map((c) => norm(c.name));
  const own = new Set(criteria.map(norm).filter((c) => c && !defaults.includes(c)));
  const checked = report.criteria.filter((c) => c.custom).map((c) => norm(c.name));
  return report.testGoal.trim() === goal.trim() && own.size === checked.length && checked.every((c) => own.has(c));
}

export type Coverage = ReturnType<typeof useCoverage>;

/** The one coverage check of a persona, shared by the score screen and the detail on Add more. */
export function useCoverage({
  persona,
  sources,
  initial,
  onReport,
  onAnswered,
}: {
  persona: Persona;
  sources: PersonaSource[];
  /** A check of this persona version the workspace still holds; no need to pay for another. */
  initial: CoverageReport | null;
  onReport: (report: CoverageReport) => void;
  /** The patched persona and the note source the backend stored the answers as. */
  onAnswered: (persona: Persona, source: PersonaSource) => void;
}) {
  const [goal, setGoal] = useState(SAMPLE_GOAL);
  const [criteria, setCriteria] = useState<string[]>([]);
  const [report, setReport] = useState<CoverageReport | null>(initial);
  const [answers, setAnswers] = useState<Record<number, string>>({});
  const [checking, setChecking] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function check(input = { goal, criteria }) {
    // The score screen has no goal field, so it has to say where to fill it in.
    if (!input.goal.trim()) {
      setError("Say what you will test first, on Add more.");
      return;
    }
    setChecking(true);
    setError(null);
    try {
      const next = await api.checkCoverage(persona.id, { testGoal: input.goal, criteria: input.criteria });
      setReport(next);
      onReport(next);
      setAnswers({});
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setChecking(false);
    }
  }

  // The score screen opens on the result, so the check runs by itself, once per persona. The goal
  // and own criteria are remembered per browser, so a reload or a new persona keeps them; loaded
  // after mount, because the server render has no storage. React dev mode runs effects twice, and
  // two parallel POSTs would both call the model.
  const started = useRef(false);
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    let saved: unknown = null;
    try {
      saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null");
    } catch {}
    const input = startingInput(saved, sources);
    setGoal(input.goal);
    setCriteria(input.criteria);
    if (!initial) void check(input);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Written on an edit only: a default that was merely shown is nobody's goal.
  function remember(next: { goal: string; criteria: string[] }) {
    setGoal(next.goal);
    setCriteria(next.criteria);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {}
  }

  // The persona keeps its id and gains facts; then the same test is checked again, so the score
  // change shows without another click (the backend keeps weights and still-backed rows).
  // Gap answers and row edits take the same way: the team's words become facts (or correct them).
  async function submit(list: { question: string; answer: string }[]) {
    setSubmitting(true);
    setError(null);
    try {
      const patched = await api.answerGaps(persona.id, { answers: list });
      // Same layout as the backend's stored source; the card only shows its title.
      const text = list.map((a) => `Q: ${a.question}\nA: ${a.answer}`).join("\n\n");
      onAnswered(patched, { kind: "note", title: ANSWERS_TITLE, text });
    } catch (e) {
      setError(errorMessage(e));
      setSubmitting(false);
      return false;
    }
    setSubmitting(false);
    await check();
    return true;
  }

  // A rebuild makes a new persona; edits and answers bump the version.
  const personaChanged = report !== null && (report.personaId !== persona.id || report.personaVersion !== persona.version);
  // A check answers one test: levels for another goal or other criteria would mislead just the same.
  const testChanged = report !== null && !sameTest(report, goal, criteria);
  const stale = personaChanged || testChanged;

  return {
    goal,
    setGoal: (next: string) => remember({ goal: next, criteria }),
    criteria,
    setCriteria: (next: string[]) => remember({ goal, criteria: next }),
    report,
    /** Only a check of exactly this persona version and this test; never an outdated level. */
    current: stale ? null : report,
    stale,
    personaChanged,
    answers,
    setAnswers,
    checking,
    submitting,
    busy: checking || submitting,
    error,
    check,
    submit,
  };
}
