"""Finalization and quote validation for synthetic interview debriefs."""

import re
from datetime import UTC, datetime
from difflib import SequenceMatcher

from pydantic import ValidationError

from app.contracts import Insight, InsightReport, Persona, Session, SessionEvent
from app.extract import DebriefDraft, ExtractionFailed

# What the browser saves when an answer is cut off (InterviewRoom.tsx). The persona didn't say it.
INTERRUPTED = "(interrupted)"
# Below this, text similarity says nothing: unrelated questions in one language share letters, up
# to about 0.48 in our samples. Shortened questions that were swapped score from about 0.55.
SAME_QUESTION = 0.5
# Characters that join what comes before and after them into one word or number: "non-binding",
# "1,000", "1'000", "1.50", "wouldn't", including the accents speech and typing use as apostrophes.
JOINS = r"['’ʼ´`.,\-‐‑]"


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
        if speaker == "persona" and text.strip() and text != INTERRUPTED:
            turns[event.seq] = text

    if not session.interview_guide or any(not q.strip() for q in session.interview_guide):
        raise DebriefInputInvalid("interview guide needs nonblank questions")
    if not turns:
        raise DebriefInputInvalid("finalized transcript needs a nonblank persona utterance")
    return turns


def _source_label(insight: Insight, persona: Persona) -> Insight:
    # Narrow source policy: exact restatement + the fact's own source quote only. A synthetic
    # quote matching a turn is a separate check, never evidence of real-customer validation.
    evidence = [e for e in persona.evidence if e.id == insight.evidence_id]
    if (
        insight.label == "grounded"
        and insight.evidence_id is not None
        and len(evidence) == 1
        and evidence[0].quote is not None
        and evidence[0].quote.strip()
        and evidence[0].quote in insight.quote
        and any(
            fact.label == "grounded"
            and fact.text == insight.theme
            and fact.evidence_id == insight.evidence_id
            for fact in persona.jobs + persona.pains + persona.objections
        )
    ):
        return insight
    return insight.model_copy(update={"label": "guess", "evidence_id": None})


def _said(quote: str, text: str) -> bool:
    """Whether text holds the quote as whole words: "I would" of "I wouldn't" reverses it.

    This checks words, not meaning: "I would" of "I would not pay" is still something they said.
    """
    pattern = rf"(?<!\w)(?<!\w{JOINS}){re.escape(quote.strip())}(?!\w|{JOINS}\w)"
    return re.search(pattern, text) is not None


def _place_quote(insight: Insight, turns: dict[int, str]) -> Insight | None:
    """The insight with its quote verified against one persona turn, or None to drop it.

    Models sometimes cite the wrong turn or a sentence from the persona's sources. One such
    insight must not cost the whole report: it is moved to the single persona turn that really
    contains the quote, or dropped. Nothing is ever quoted that the persona didn't say.
    """
    if not insight.quote.strip():
        return None
    if _said(insight.quote, turns.get(insight.turn_seq, "")):
        return insight
    matches = [seq for seq, text in turns.items() if _said(insight.quote, text)]
    return insight.model_copy(update={"turn_seq": matches[0]}) if len(matches) == 1 else None


def _comparable(question: str) -> str:
    return " ".join(re.sub(r"[^\w\s]", "", question).casefold().split())


def _closer_to_another(asked: str, own: str, guide: list[str]) -> bool:
    def closeness(question: str) -> float:
        return SequenceMatcher(
            None, _comparable(asked), _comparable(question), autojunk=False
        ).ratio()

    return any(closeness(q) > max(closeness(own), SAME_QUESTION) for q in guide)


def _check_positions(asked: list[str], guide: list[str]) -> None:
    """Answers belong to the guide question at their position, whatever the model called it.

    That is only safe with one answer per question in guide order, so a missing or extra answer
    fails, and so does text closer to another guide question, whose quotes would land under the
    wrong one. Only the wording can show this, so the check has limits both ways:
    - It still passes a reorder whose wording stays below SAME_QUESTION for the other question, as
      a translation or full paraphrase can, and an unrelated question at the right position. Both
      are then shown under the guide's text.
    - It fails an honest rewording that lands closer to a similar guide question, such as one with
      the same opening words. That is visible and can be retried, and a wrong answer under a
      question is not visible at all, so a close call fails.
    """
    if len(asked) != len(guide) or any(
        _closer_to_another(a, g, guide) for a, g in zip(asked, guide, strict=True)
    ):
        raise ExtractionFailed("debrief questions do not match guide")


def build_report(
    session: Session, persona: Persona, events: list[SessionEvent], draft: DebriefDraft
) -> InsightReport:
    turns = validate_inputs(session, events)
    try:
        draft = DebriefDraft.model_validate(draft.model_dump(by_alias=True), strict=True)
        _check_positions([q.question for q in draft.questions], session.interview_guide)
        seen: set[str] = set()
        questions = []
        for question, guide_text in zip(draft.questions, session.interview_guide, strict=True):
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
                        "question": guide_text,
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
                "transcriptGaps": any(
                    e.type == "session.ended" and e.data.get("transcriptGaps") is True
                    for e in events
                ),
                "questions": questions,
            },
            strict=True,
        )
    except ValidationError:
        raise ExtractionFailed("invalid debrief output") from None
