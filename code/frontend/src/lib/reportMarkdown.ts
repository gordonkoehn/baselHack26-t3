import type { InsightReport } from "./contracts";

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
    `Persona: ${textLines(personaName).join("  \n")}`,
    "",
    `Date (UTC): ${reportDate(report) ?? "unavailable"}`,
    "",
    "Simulated AI persona: hypotheses, not customer evidence.",
    "",
    sample
      ? 'Quotes are from the sample script, not from an interview. The example sources contain the same script, so "grounded" proves nothing here. Neither label is validated customer evidence.'
      : 'Quotes are from the simulated interview. "grounded" means the persona\'s sources also support the statement; "guess" means they do not. Neither is validated customer evidence.',
  ];

  for (const [index, question] of report.questions.entries()) {
    lines.push("", `## Question ${index + 1}`, "", textLines(question.question).join("  \n"), "",
      `Signal: ${question.signal}`, "", "### Insights", "");
    if (question.insights.length === 0) lines.push("No insights recorded.", "");
    for (const insight of question.insights) {
      lines.push(`- **[${insight.label}]** ${textLines(insight.theme).join("  \n  ")}`, "",
        ...textLines(insight.quote).map((line) => `  > ${line}${line ? "  " : ""}`), "",
        `  ${sample ? "Sample script turn" : "Interview turn"} ${insight.turnSeq} · ${insight.label === "grounded" ? "also in the persona's sources" : "not backed by the persona's sources"}`, "");
    }
    lines.push("### Follow-up questions for real customers", "");
    if (!question.followUps?.length) lines.push("No follow-up questions recorded.");
    for (const followUp of question.followUps ?? []) {
      lines.push(`- ${textLines(followUp).join("  \n  ")}`);
    }
  }
  return `${lines.join("\n")}\n`;
}
