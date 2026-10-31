import type { InsightReport } from "@/lib/contracts";

export type SummaryItem = { question: string; theme: string; quote: string; grounded: boolean };
export type DebriefSummary = { heldUp: SummaryItem[]; didNot: SummaryItem[]; open: SummaryItem[] };

// The headline after a call: each question's strongest finding, sorted by its signal.
// Derived from the saved report, so it costs no extra model call and can't disagree with the details.
export function summarizeDebrief(report: InsightReport): DebriefSummary {
  const summary: DebriefSummary = { heldUp: [], didNot: [], open: [] };
  for (const q of report.questions) {
    const [top] = q.insights;
    if (!top) continue;
    const item = {
      question: q.question,
      theme: top.theme,
      quote: top.quote,
      grounded: top.label === "grounded",
    };
    if (q.signal === "supports") summary.heldUp.push(item);
    else if (q.signal === "contradicts") summary.didNot.push(item);
    else summary.open.push(item);
  }
  return summary;
}
