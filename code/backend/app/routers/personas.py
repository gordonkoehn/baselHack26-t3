import os
import uuid
from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app import extract
from app.contracts import Persona, PersonaCreate
from app.extract import ExtractionFailed, PersonaDraft, ProviderUnavailable
from app.store import Store, get_store

router = APIRouter(prefix="/api/personas", tags=["personas"])

StoreDep = Annotated[Store, Depends(get_store)]


def get_extractor() -> Callable[[PersonaCreate], PersonaDraft]:
    return extract.extract_persona


ExtractorDep = Annotated[Callable[[PersonaCreate], PersonaDraft], Depends(get_extractor)]


def _norm(text: str) -> str:
    return " ".join(text.split())


def check_draft(draft: PersonaDraft, request: PersonaCreate) -> None:
    """Reject provider output whose evidence isn't backed by the pasted sources."""
    sources = [_norm(s.text) for s in request.sources]
    ids = [e.id for e in draft.evidence]
    if len(ids) != len(set(ids)):
        raise ExtractionFailed("duplicate evidence ids")
    for e in draft.evidence:
        quote = _norm(e.quote or "")
        # An empty quote would match every source, so it counts as missing.
        if not quote or not any(quote in s for s in sources):
            raise ExtractionFailed(f"evidence {e.id}: quote not found verbatim in the sources")
    for fact in draft.jobs + draft.pains + draft.objections:
        if fact.label == "grounded" and fact.evidence_id not in ids:
            raise ExtractionFailed("grounded fact without existing evidence")
        if fact.label == "guess" and fact.evidence_id is not None:
            raise ExtractionFailed("guess must not cite evidence")


@router.post("", status_code=201, response_model_by_alias=True)
def create_persona(body: PersonaCreate, store: StoreDep, extractor: ExtractorDep) -> Persona:
    if any(not s.text.strip() for s in body.sources):
        raise HTTPException(422, "every source needs text")
    try:
        draft = extractor(body)
        check_draft(draft, body)
    except ProviderUnavailable:
        raise HTTPException(503, "persona provider unavailable") from None
    except ExtractionFailed as exc:
        # The reason names ids and rules only, never source text.
        raise HTTPException(502, f"persona extraction unusable: {exc}") from None

    persona = Persona(
        **draft.model_dump(),
        id=f"p_{uuid.uuid4().hex[:12]}",
        sprint_id=body.sprint_id,
        language=body.language,
        voice_id=os.environ.get("PERSONA_VOICE_ID", "stock_f_01"),
        face_id=os.environ.get("PERSONA_FACE_ID", "stock_f_01"),
        cloned=False,
        readiness=None,
    )
    store.save_persona(persona)
    return persona


@router.get("/{persona_id}", response_model_by_alias=True)
def read_persona(persona_id: str, store: StoreDep) -> Persona:
    persona = store.get_persona(persona_id)
    if persona is None:
        raise HTTPException(404, "persona not found")
    return persona
