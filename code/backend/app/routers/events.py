from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query
from pydantic import BeforeValidator

from app.contracts import SessionEvent
from app.event_validation import EventInput
from app.store import EventConflict, Store, get_store

router = APIRouter(prefix="/api/sessions", tags=["events"])

StoreDep = Annotated[Store, Depends(get_store)]


def _require_session(store: Store, session_id: str) -> None:
    if store.get_session(session_id) is None:
        raise HTTPException(404, "session not found")


def _cursor(value: object) -> int:
    if type(value) is int:
        return value
    if isinstance(value, str) and value.isascii() and value.isdecimal():
        return int(value)
    raise ValueError("after must be a non-negative integer")


def _batch(value: object) -> list[object]:
    if not isinstance(value, list):
        # Do not echo non-finite input in FastAPI's default validation response.
        raise HTTPException(422, "expected a list of session events")
    return value


EventBatch = Annotated[list[EventInput], BeforeValidator(_batch)]


@router.post("/{session_id}/events")
def append_events(session_id: str, body: EventBatch, store: StoreDep) -> dict[str, int]:
    _require_session(store, session_id)
    if any(event.session_id != session_id for event in body):
        raise HTTPException(422, "event belongs to another session")

    seen: dict[int, SessionEvent] = {}
    for event in body:
        if event.seq in seen and seen[event.seq] != event:
            raise HTTPException(409, f"seq {event.seq} has conflicting content")
        seen[event.seq] = event

    try:
        accepted = store.append_events(session_id, body)
    except EventConflict as exc:
        raise HTTPException(409, str(exc)) from None
    return {"accepted": accepted}


@router.get("/{session_id}/events", response_model_by_alias=True)
def read_events(
    session_id: str,
    store: StoreDep,
    after: Annotated[int, Query(ge=0), BeforeValidator(_cursor)] = 0,
) -> list[SessionEvent]:
    _require_session(store, session_id)
    return [event for event in store.get_events(session_id) if event.seq > after]
