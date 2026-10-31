import type { InsightReport } from "./contracts";

export const TRANSCRIPT_GAPS = "This transcript may have gaps: part of the call may not have been captured, so this debrief only covers what was saved. A question with no quotes may just mean its answer was lost.";

// Escape report text so headings, links, HTML and list markers remain literal content.
function textLines(value: string): string[] {
  return value.replace(/\r\n?/g, "\n").split("\n").map((line) =>
    line.replace(/&/g, "&amp;")
      .replace(/[\\`*_{}[\]()<>#+!|~-]/g, "\\$&")
      .replace(/^(\s*\d+)([.)])(?=\s)/, "$1\\$2"),
  );
}

function reportDate(report: InsightReport): string | null {
  const date = new Date(report.generatedAt);
  return Number.isNaN(date.getTime()) ? null : date.toISOString().slice(0, 10);
}

export function reportMarkdownFilename(report: InsightReport, personaName: string): string {
  const name = personaName.normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "")
    .slice(0, 64).replace(/-+$/g, "") || "persona";
  return `debrief-${name}-${reportDate(report) ?? "undated"}.md`;
}

/** Export only the saved report, with a stable UTC date and explicit synthetic-evidence caveats. */
export function formatReportMarkdown(report: InsightReport, personaName: string, sample = false): string {
  const lines = [
    "# Debrief",
    "",
    ...(sample ? ["**SAMPLE INTERVIEW: a scripted demo transcript with no live call. Nobody was interviewed.**", ""] : []),
    ...(report.transcriptGaps ? [`**${TRANSCRIPT_GAPS}**`, ""] : []),
    `Persona: ${textLines(personaName).join("  \n")}`,
    "",
    `Date (UTC): ${reportDate(report) ?? "unavailable"}`,
    "",
    "Simulated AI persona: hypotheses, not customer evidence.",
    "",
    sample
      ? 'Quotes are from the sample script, not from an interview. If the persona uses the prefilled example sources, they contain the same script, so "grounded" proves nothing here. Neither label is validated customer evidence.'
      : 'Quotes are from the simulated interview, never from a real customer. "grounded" means the statement repeats a persona fact that cites a passage in the sources, and nothing checks that passage or the quote against that fact; "guess" means it was not matched to a source. Neither is validated customer evidence.',
  ];

  for (const [index, question] of report.questions.entries()) {
    lines.push("", `## Question ${index + 1}`, "", textLines(question.question).join("  \n"), "",
      `Signal: ${question.signal}`, "", "### Insights", "");
    if (question.insights.length === 0) lines.push("No insights recorded.", "");
    for (const insight of question.insights) {
      lines.push(`- **[${insight.label}]** ${textLines(insight.theme).join("  \n  ")}`, "",
        ...textLines(insight.quote).map((line) => `  > ${line}${line ? "  " : ""}`), "",
        `  ${sample ? "Sample script turn" : "AI persona quote · interview turn"} ${insight.turnSeq} · ${insight.label === "grounded" ? "statement repeats a persona fact that cites a source passage, quote not compared to it" : "not matched to a source"}`, "");
    }
    lines.push("### Follow-up questions for real customers", "");
    if (!question.followUps?.length) lines.push("No follow-up questions recorded.");
    for (const followUp of question.followUps ?? []) {
      lines.push(`- ${textLines(followUp).join("  \n  ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
