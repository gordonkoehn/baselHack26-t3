import time
import uuid
from collections.abc import Callable
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException

from app import extract
from app.auth import require_passcode
from app.contracts import Evidence, Fact, Persona, PersonaCreate, PersonaUpdate
from app.extract import ExtractionFailed, PersonaDraft, ProbeAnswer, ProviderUnavailable
from app.faces import FACES, VOICES, fitting_face
from app.readiness import score_readiness
from app.store import Store, get_store

router = APIRouter(prefix="/api/personas", tags=["personas"])

StoreDep = Annotated[Store, Depends(get_store)]


def get_extractor() -> Callable[[PersonaCreate], PersonaDraft]:
    return extract.extract_persona


ExtractorDep = Annotated[Callable[[PersonaCreate], PersonaDraft], Depends(get_extractor)]


def get_prober() -> Callable[[str, str], ProbeAnswer]:
    return extract.answer_probe


ProberDep = Annotated[Callable[[str, str], ProbeAnswer], Depends(get_prober)]


def _norm(text: str) -> str:
    return " ".join(text.split())


def ground_draft(draft: PersonaDraft, request: PersonaCreate) -> PersonaDraft:
    """Keep only evidence backed by the pasted sources; facts citing dropped evidence become guesses.

    Models sometimes paraphrase a quote or mark a fact grounded without citing anything.
    Downgrading keeps the persona usable without ever showing an unverified fact as grounded.
    Only ambiguous evidence ids still reject the draft.
    """
    sources = [_norm(s.text) for s in request.sources]
    ids = [e.id for e in draft.evidence]
    if len(ids) != len(set(ids)):
        raise ExtractionFailed("duplicate evidence ids")

    def attribute(e: Evidence) -> Evidence | None:
        """Bind evidence to the first source that really contains its quote; drop it otherwise.

        kind and sourceRef come from that source, never from the model, so the card can't show
        a note as a real interview or link to a source without the quote.
        """
        q = _norm(e.quote or "")
        # An empty quote would match every source, so it counts as missing.
        if not q:
            return None
        for i, (src, text) in enumerate(zip(request.sources, sources, strict=True), start=1):
            if q in text:
                return e.model_copy(update={"kind": src.kind, "source_ref": f"source:{i}"})
        return None

    kept = [a for e in draft.evidence if (a := attribute(e))]
    kept_ids = {e.id for e in kept}

    def relabel(facts: list[Fact]) -> list[Fact]:
        # Grounded only with kept evidence; everything else is a guess without an evidenceId.
        return [
            f
            if f.label == "grounded" and f.evidence_id in kept_ids
            else f.model_copy(update={"label": "guess", "evidence_id": None})
            for f in facts
        ]

    return draft.model_copy(
        update={
            "evidence": kept,
            "jobs": relabel(draft.jobs),
            "pains": relabel(draft.pains),
            "objections": relabel(draft.objections),
        }
    )


@router.post(
    "", status_code=201, response_model_by_alias=True, dependencies=[Depends(require_passcode)]
)
def create_persona(
    body: PersonaCreate, store: StoreDep, extractor: ExtractorDep, prober: ProberDep
) -> Persona:
    started = time.monotonic()
    if any(not s.text.strip() for s in body.sources):
        raise HTTPException(422, "every source needs text")
    try:
        draft = extractor(body)
        draft = ground_draft(draft, body)
    except ProviderUnavailable:
        raise HTTPException(503, "persona provider unavailable") from None
    except ExtractionFailed as exc:
        # The reason names ids and rules only, never source text.
        raise HTTPException(502, f"persona extraction unusable: {exc}") from None

    # The model sometimes picks a face of the other gender; a woman must never get a man's face or voice.
    face_id = FACES[fitting_face(draft.face, draft.gender, draft.age)][0]
    persona = Persona(
        **draft.model_dump(exclude={"face", "gender"}),
        id=f"p_{uuid.uuid4().hex[:12]}",
        sprint_id=body.sprint_id,
        language=body.language,
        voice_id=VOICES[draft.gender],
        face_id=face_id,
        cloned=False,
        readiness=None,
    )
    readiness = score_readiness(persona, body.sources, prober, time.monotonic() - started)
    persona = persona.model_copy(update={"readiness": readiness})
    store.save_persona(persona)
    store.save_persona_sources(persona.id, body)
    return persona


@router.get("/{persona_id}", response_model_by_alias=True)
def read_persona(persona_id: str, store: StoreDep) -> Persona:
    persona = store.get_persona(persona_id)
    if persona is None:
        raise HTTPException(404, "persona not found")
    return persona


@router.patch(
    "/{persona_id}", response_model_by_alias=True, dependencies=[Depends(require_passcode)]
)
def update_persona(persona_id: str, body: PersonaUpdate, store: StoreDep) -> Persona:
    persona = store.get_persona(persona_id)
    if persona is None:
        raise HTTPException(404, "persona not found")

    def relabel(new: list[Fact], old: list[Fact]) -> list[Fact]:
        # Humans may remove facts or downgrade them; only an untouched grounded fact keeps its evidence.
        grounded = {(f.text, f.evidence_id) for f in old if f.label == "grounded"}
        return [
            f
            if f.label == "grounded" and (f.text, f.evidence_id) in grounded
            else f.model_copy(update={"label": "guess", "evidence_id": None})
            for f in new
        ]

    # The score described the persona before this edit. Re-probing every edit would cost ten more
    # provider calls, so the persona simply has no score from here on.
    changes: dict = {"version": persona.version + 1, "readiness": None}
    for name in ("jobs", "pains", "objections"):
        new = getattr(body, name)
        if new is not None:
            changes[name] = relabel(new, getattr(persona, name))
    if body.speech_style is not None:
        changes["speech_style"] = persona.speech_style.model_copy(
            update={"notes": body.speech_style.notes}
        )
    persona = persona.model_copy(update=changes)
    store.save_persona(persona)
    return persona
