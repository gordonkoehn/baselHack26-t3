import { describe, expect, it } from "vitest";
import type { InsightReport } from "./contracts";
import { formatReportMarkdown, reportMarkdownFilename } from "./reportMarkdown";

const report = (overrides: Partial<InsightReport> = {}): InsightReport => ({
  sessionId: "s_1",
  generatedAt: "2026-10-31T23:30:00+00:00",
  questions: [],
  ...overrides,
});

const question = (overrides: Partial<InsightReport["questions"][number]> = {}): InsightReport["questions"][number] => ({
  question: "Does matching work?",
  signal: "supports",
  insights: [],
  ...overrides,
});

const insight = (overrides: Partial<InsightReport["questions"][number]["insights"][number]> = {}) => ({
  id: "i1",
  theme: "Matching helps",
  quote: "Ich gebe alles.",
  turnSeq: 3,
  label: "guess" as const,
  evidenceId: null,
  ...overrides,
});

describe("reportMarkdownFilename", () => {
  it("makes a plain ASCII name with the UTC date", () => {
    expect(reportMarkdownFilename(report(), "Märta Müller!")).toBe("debrief-marta-muller-2026-10-31.md");
  });

  it("uses the UTC day, not the offset's local day", () => {
    const late = report({ generatedAt: "2026-10-31T23:30:00-05:00" });
    expect(reportMarkdownFilename(late, "Anna")).toBe("debrief-anna-2026-11-01.md");
  });

  it("falls back when name or date are unusable", () => {
    expect(reportMarkdownFilename(report({ generatedAt: "nonsense" }), "../!!")).toBe("debrief-persona-undated.md");
  });

  it("caps long names without leaving a trailing dash", () => {
    const name = `${"a".repeat(63)} b`;
    expect(reportMarkdownFilename(report(), name)).toBe(`debrief-${"a".repeat(63)}-2026-10-31.md`);
  });
});

describe("formatReportMarkdown", () => {
  it("always carries the synthetic-evidence caveat and the date", () => {
    const markdown = formatReportMarkdown(report(), "Anna");

    expect(markdown).toContain("Simulated AI persona: hypotheses, not customer evidence.");
    expect(markdown).toContain("Date (UTC): 2026-10-31");
    expect(markdown).toContain("Persona: Anna");
  });

  it("says the transcript may have gaps, and stays silent when it has none", () => {
    expect(formatReportMarkdown(report({ transcriptGaps: true }), "Anna")).toContain("This transcript may have gaps");
    expect(formatReportMarkdown(report({ transcriptGaps: false }), "Anna")).not.toContain("gaps");
    expect(formatReportMarkdown(report(), "Anna")).not.toContain("gaps");
  });

  it("says when the date is unavailable", () => {
    expect(formatReportMarkdown(report({ generatedAt: "nonsense" }), "Anna")).toContain("Date (UTC): unavailable");
  });

  it("labels each insight with its turn and whether the sources back it", () => {
    const markdown = formatReportMarkdown(
      report({
        questions: [
          question({
            signal: "contradicts",
            insights: [
              insight({ id: "g", theme: "Backed", turnSeq: 2, label: "grounded", evidenceId: "e1" }),
              insight({ id: "n", theme: "Unbacked", turnSeq: 5 }),
            ],
            followUps: ["Ask them why"],
          }),
        ],
      }),
      "Anna",
    );

    expect(markdown).toContain("## Question 1");
    expect(markdown).toContain("Signal: contradicts");
    expect(markdown).toContain("- **[grounded]** Backed");
    expect(markdown).toContain("Interview turn 2 · also in the persona's sources");
    expect(markdown).toContain("- **[guess]** Unbacked");
    expect(markdown).toContain("Interview turn 5 · not backed by the persona's sources");
    expect(markdown).toContain("- Ask them why");
  });

  it("says when a question has no insights or follow-ups", () => {
    const markdown = formatReportMarkdown(report({ questions: [question()] }), "Anna");

    expect(markdown).toContain("No insights recorded.");
    expect(markdown).toContain("No follow-up questions recorded.");
  });

  it("keeps report text literal, so it cannot inject headings, links or HTML", () => {
    const markdown = formatReportMarkdown(
      report({ questions: [question({ question: "# [x](http://evil) <b>&", insights: [insight({ theme: "1. item" })] })] }),
      "Anna",
    );

    expect(markdown).toContain("\\# \\[x\\]\\(http://evil\\) \\<b\\>&amp;");
    expect(markdown).toContain("- **[guess]** 1\\. item");
  });

  it("keeps every line of a multi-line quote inside the blockquote", () => {
    const markdown = formatReportMarkdown(
      report({ questions: [question({ insights: [insight({ quote: "first\r\nsecond" })] })] }),
      "Anna",
    );

    expect(markdown).toContain("  > first  \n  > second  \n");
  });
});
