"""Summary across interviews: pure aggregation of saved debriefs, no model call."""

from app.contracts import (
    Insight,
    InsightReport,
    InsightSummary,
    SummaryInsight,
    SummaryQuestion,
)

# Per interview rather than per question, so a lone contradicting interview can't be crowded out.
QUOTES_PER_INTERVIEW = 2


def _is_guess(insight: Insight) -> bool:
    return insight.label != "grounded"


def summarize(reports: list[InsightReport]) -> InsightSummary:
    rows: dict[str, SummaryQuestion] = {}
    for report in reports:
        seen: set[str] = set()
        for question in report.questions:
            # The counts are interviews: a guide listing a question twice still counts once.
            if question.question in seen:
                continue
            seen.add(question.question)
            row = rows.setdefault(question.question, SummaryQuestion(question=question.question))
            setattr(row, question.signal, getattr(row, question.signal) + 1)
            strongest = sorted(question.insights, key=_is_guess)[:QUOTES_PER_INTERVIEW]
            row.insights.extend(
                SummaryInsight(**insight.model_dump(), session_id=report.session_id)
                for insight in strongest
            )
    # Stable: within grounded and within guesses, quotes keep their interview order.
    for row in rows.values():
        row.insights.sort(key=_is_guess)
    return InsightSummary(
        transcript_gap_session_ids=[r.session_id for r in reports if r.transcript_gaps],
        questions=list(rows.values()),
    )
