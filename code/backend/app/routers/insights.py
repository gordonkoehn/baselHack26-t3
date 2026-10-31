from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app import debrief, extract, summary
from app.auth import require_passcode
from app.contracts import (
    InsightReport,
    InsightSummary,
    InsightSummaryRequest,
    Persona,
    Session,
    SessionEvent,
)
from app.extract import DebriefDraft, ExtractionFailed, ProviderUnavailable
from app.rate_limit import rate_limit
from app.routers.sessions import StoreDep, _load

router = APIRouter(prefix="/api/sessions", tags=["insights"])
summary_router = APIRouter(prefix="/api/insights", tags=["insights"])

Debriefer = Callable[[Session, Persona, list[SessionEvent]], DebriefDraft]


def get_debriefer() -> Debriefer:
    return extract.extract_debrief


DebrieferDep = Annotated[Debriefer, Depends(get_debriefer)]


@router.get("/{session_id}/insights", response_model_by_alias=True)
def read_insights(session_id: str, store: StoreDep) -> InsightReport:
    _load(store, session_id)
    report = store.get_report(session_id)
    if report is None:
        raise HTTPException(404, "report not found")
    return report


@router.post(
    "/{session_id}/debrief",
    response_model_by_alias=True,
    dependencies=[Depends(require_passcode), Depends(rate_limit("debrief"))],
)
def create_debrief(session_id: str, store: StoreDep, debriefer: DebrieferDep) -> InsightReport:
    session = _load(store, session_id)
    saved = store.get_report(session_id)
    if saved is not None:
        return saved
    persona = store.get_persona(session.persona_id)
    if persona is None:
        raise HTTPException(404, "persona not found")
    events = store.get_events(session_id)
    snapshot = [event.model_dump_json(by_alias=True) for event in events]
    try:
        debrief.validate_inputs(session, events)
        draft = debriefer(session, persona, events)
        report = debrief.build_report(session, persona, events, draft)
    except debrief.TranscriptIncomplete:
        raise HTTPException(409, "transcript is not finalized") from None
    except debrief.DebriefInputInvalid as exc:
        raise HTTPException(422, str(exc)) from None
    except ProviderUnavailable:
        raise HTTPException(503, "debrief provider unavailable") from None
    except ExtractionFailed:
        raise HTTPException(502, "debrief output unusable") from None

    if [event.model_dump_json(by_alias=True) for event in store.get_events(session_id)] != snapshot:
        raise HTTPException(409, "transcript changed during debrief")
    # Detect changes during generation; this read and save are not a multi-writer transaction.
    store.save_report(report)
    return report


# No passcode, like read_insights: no model call, and only what these ids can already read.
@summary_router.post("/summary", response_model_by_alias=True)
def summarize_interviews(body: InsightSummaryRequest, store: StoreDep) -> InsightSummary:
    session_ids = list(dict.fromkeys(body.session_ids))
    rows = store.get_debriefs(session_ids)
    # A partial table would look like a complete count, so a missing debrief fails the whole request.
    missing = [id_ for id_, row in zip(session_ids, rows, strict=True) if row is None]
    if missing:
        raise HTTPException(404, f"report not found: {', '.join(missing)}")
    debriefs = [row for row in rows if row is not None]
    # A scripted transcript is nobody's answer, and a count can't carry a sample label.
    samples = [session.id for session, _ in debriefs if session.sample]
    if samples:
        raise HTTPException(409, f"sample interview: {', '.join(samples)}")
    return summary.summarize([report for _, report in debriefs])
