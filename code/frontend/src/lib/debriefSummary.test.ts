import { describe, expect, it } from "vitest";
import type { InsightReport } from "./contracts";
import { summarizeDebrief } from "./debriefSummary";

const insight = (theme: string, label: "grounded" | "guess") => ({
  id: theme,
  theme,
  quote: `quote ${theme}`,
  turnSeq: 1,
  label,
  evidenceId: label === "grounded" ? "e1" : null,
});

const report: InsightReport = {
  sessionId: "s_1",
  generatedAt: "2026-10-31T15:00:00Z",
  questions: [
    { question: "a", signal: "supports", insights: [insight("first", "grounded"), insight("second", "guess")] },
    { question: "b", signal: "contradicts", insights: [insight("third", "guess")] },
    { question: "c", signal: "unclear", insights: [insight("fourth", "guess")] },
    { question: "d", signal: "supports", insights: [] },
  ],
};

describe("summarizeDebrief", () => {
  it("sorts each question's top finding by its signal", () => {
    const summary = summarizeDebrief(report);

    expect(summary.heldUp.map((i) => i.theme)).toEqual(["first"]);
    expect(summary.didNot.map((i) => i.theme)).toEqual(["third"]);
    expect(summary.open.map((i) => i.theme)).toEqual(["fourth"]);
  });

  it("keeps the evidence label", () => {
    const summary = summarizeDebrief(report);

    expect(summary.heldUp[0].grounded).toBe(true);
    expect(summary.didNot[0].grounded).toBe(false);
  });

  it("skips questions without findings", () => {
    expect(summarizeDebrief(report).heldUp).toHaveLength(1);
  });
});
