import uuid
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Response

from app import avatar, realtime
from app.auth import require_passcode
from app.contracts import Session, SessionCreate, SessionToken, SessionUpdate
from app.extract import ProviderUnavailable
from app.store import SessionConflict, Store, get_store

router = APIRouter(prefix="/api/sessions", tags=["sessions"])

StoreDep = Annotated[Store, Depends(get_store)]


def _now() -> str:
    return datetime.now(UTC).isoformat().replace("+00:00", "Z")


def _load(store: Store, session_id: str) -> Session:
    session = store.get_session(session_id)
    if session is None:
        raise HTTPException(404, "session not found")
    return session


@router.post("", status_code=201, response_model_by_alias=True)
def create_session(body: SessionCreate, store: StoreDep) -> Session:
    if store.get_persona(body.persona_id) is None:
        raise HTTPException(404, "persona not found")
    session = Session(
        id=f"s_{uuid.uuid4().hex[:12]}",
        persona_id=body.persona_id,
        status="created",
        provider="openai-realtime",
        # The browser connects to realtime.CALLS_URL with the token; there's no room to join.
        join_url=None,
        interview_guide=body.interview_guide,
        sample=body.sample,
    )
    store.save_session(session)
    return session


@router.get("/{session_id}", response_model_by_alias=True)
def read_session(session_id: str, store: StoreDep) -> Session:
    return _load(store, session_id)


@router.patch("/{session_id}", response_model_by_alias=True)
def update_session(session_id: str, body: SessionUpdate, store: StoreDep) -> Session:
    try:
        session = store.transition_session(session_id, body.status, _now())
    except SessionConflict as exc:
        raise HTTPException(409, str(exc)) from None
    if session is None:
        raise HTTPException(404, "session not found")
    return session


@router.post(
    "/{session_id}/token", response_model_by_alias=True, dependencies=[Depends(require_passcode)]
)
def session_token(session_id: str, response: Response, store: StoreDep) -> SessionToken:
    session = _load(store, session_id)
    if session.status == "ended":
        raise HTTPException(409, "session has ended")
    persona = store.get_persona(session.persona_id)
    if persona is None:
        raise HTTPException(404, "persona not found")
    request = store.get_persona_sources(persona.id)
    try:
        token = realtime.mint_client_secret(
            persona, session.interview_guide, request.sources if request else [], session.id
        )
    except ProviderUnavailable:
        raise HTTPException(503, "voice provider unavailable") from None
    # A bearer token: never cache it anywhere between the backend and the browser.
    response.headers["Cache-Control"] = "no-store"
    return token


@router.post(
    "/{session_id}/avatar-token",
    response_model_by_alias=True,
    dependencies=[Depends(require_passcode)],
)
def avatar_token(session_id: str, response: Response, store: StoreDep) -> SessionToken:
    """Short-lived Simli token for the persona's face; the browser opens the avatar stream itself."""
    session = _load(store, session_id)
    if session.status == "ended":
        raise HTTPException(409, "session has ended")
    persona = store.get_persona(session.persona_id)
    if persona is None:
        raise HTTPException(404, "persona not found")
    try:
        token = avatar.mint_session_token(persona, session.id)
    except ProviderUnavailable:
        raise HTTPException(503, "avatar provider unavailable") from None
    response.headers["Cache-Control"] = "no-store"
    return token
