"""Finalization and quote validation for synthetic interview debriefs."""

from datetime import UTC, datetime

from pydantic import ValidationError

from app.contracts import Insight, InsightReport, Persona, Session, SessionEvent
from app.extract import DebriefDraft, ExtractionFailed


class TranscriptIncomplete(Exception):
    """The browser has not saved a complete, terminal event prefix yet."""


class DebriefInputInvalid(Exception):
    """A finalized session lacks interview questions or persona speech."""


def validate_inputs(session: Session, events: list[SessionEvent]) -> dict[int, str]:
    events = sorted(events, key=lambda event: event.seq)
    if (
        session.status != "ended"
        or not events
        or any(e.session_id != session.id or e.seq != i for i, e in enumerate(events, 1))
        or sum(e.type == "session.ended" for e in events) != 1
        or events[-1].type != "session.ended"
    ):
        raise TranscriptIncomplete

    # The canonical stream has no partial-turn field: its terminal marker finalizes the prefix.
    turns: dict[int, str] = {}
    for event in events:
        if event.type != "utterance":
            continue
        speaker, text = event.data.get("speaker"), event.data.get("text")
        if speaker not in ("persona", "interviewer") or not isinstance(text, str):
            raise TranscriptIncomplete
        if speaker == "persona" and text.strip():
            turns[event.seq] = text

    if not session.interview_guide or any(not q.strip() for q in session.interview_guide):
        raise DebriefInputInvalid("interview guide needs nonblank questions")
    if not turns:
        raise DebriefInputInvalid("finalized transcript needs a nonblank persona utterance")
    return turns


def _comparable(text: str) -> str:
    # Only differences that can't change the meaning: a symbol like "¬" or "-5" still counts.
    return " ".join(text.casefold().split()).rstrip(".!,;")


def _source_label(insight: Insight, persona: Persona) -> Insight:
    # Grounded means the theme IS a fact that cites the sources, so the label only ever sits on that
    # fact's text. Whether the passage supports the fact is the extraction model's word, not checked.
    # Comparing a reworded theme can't work: word overlap sees neither negation nor which fact is
    # meant, and facts on one evidence id share vocabulary. A miss only costs a guess label.
    # The quote is the persona's synthetic speech, so it may reword the source and is never
    # evidence of real-customer validation; _place_quote verifies it against the saved turns.
    evidence = [e for e in persona.evidence if e.id == insight.evidence_id]
    theme = _comparable(insight.theme)
    fact = next(
        (
            f
            for f in persona.jobs + persona.pains + persona.objections
            if f.label == "grounded"
            and f.evidence_id == insight.evidence_id
            and _comparable(f.text) == theme
        ),
        None,
    )
    if (
        insight.label == "grounded"
        and insight.evidence_id is not None
        and len(evidence) == 1
        and evidence[0].quote is not None
        and evidence[0].quote.strip()
        and theme
        and fact is not None
    ):
        return insight.model_copy(update={"theme": fact.text})
    return insight.model_copy(update={"label": "guess", "evidence_id": None})


def _place_quote(insight: Insight, turns: dict[int, str]) -> Insight | None:
    """The insight with its quote verified against one persona turn, or None to drop it.

    Models sometimes cite the wrong turn or a sentence from the persona's sources. One such
    insight must not cost the whole report: it is moved to the single persona turn that really
    contains the quote, or dropped. Nothing is ever quoted that the persona didn't say.
    """
    if not insight.quote.strip():
        return None
    if insight.quote in turns.get(insight.turn_seq, ""):
        return insight
    matches = [seq for seq, text in turns.items() if insight.quote in text]
    return insight.model_copy(update={"turn_seq": matches[0]}) if len(matches) == 1 else None


def build_report(
    session: Session, persona: Persona, events: list[SessionEvent], draft: DebriefDraft
) -> InsightReport:
    turns = validate_inputs(session, events)
    try:
        draft = DebriefDraft.model_validate(draft.model_dump(by_alias=True), strict=True)
        if [q.question for q in draft.questions] != session.interview_guide:
            raise ExtractionFailed("debrief questions do not match guide")
        seen: set[str] = set()
        questions = []
        for question in draft.questions:
            insights = []
            for insight in question.insights:
                if insight.id in seen:
                    raise ExtractionFailed("duplicate insight ids")
                seen.add(insight.id)
                placed = _place_quote(insight, turns)
                if placed is not None:
                    insights.append(_source_label(placed, persona))
            questions.append(
                question.model_copy(
                    update={
                        "insights": insights,
                        "signal": question.signal if insights else "unclear",
                    }
                ).model_dump(by_alias=True)
            )
        # Validate the canonical shape again after server metadata and source labels are set.
        return InsightReport.model_validate(
            {
                "sessionId": session.id,
                "generatedAt": datetime.now(UTC).isoformat().replace("+00:00", "Z"),
                "questions": questions,
            },
            strict=True,
        )
    except ValidationError:
        raise ExtractionFailed("invalid debrief output") from None
