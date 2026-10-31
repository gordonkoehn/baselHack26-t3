from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app import debrief, extract
from app.auth import require_passcode
from app.contracts import InsightReport, Persona, Session, SessionEvent
from app.extract import DebriefDraft, ExtractionFailed, ProviderUnavailable
from app.routers.sessions import StoreDep, _load

router = APIRouter(prefix="/api/sessions", tags=["insights"])

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
    "/{session_id}/debrief", response_model_by_alias=True, dependencies=[Depends(require_passcode)]
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
