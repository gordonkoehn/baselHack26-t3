import time
import uuid
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Request, Response

from app import avatar, extract
from app.auth import require_passcode
from app.contracts import (
    CoverageCriterion,
    CoverageReport,
    CoverageRequest,
    CustomFace,
    Evidence,
    Face,
    Fact,
    Persona,
    PersonaAnswers,
    PersonaCreate,
    PersonaSource,
    PersonaSummary,
    PersonaUpdate,
)
from app.extract import (
    DEFAULT_CRITERIA,
    AnswersDraft,
    CoverageDraft,
    ExtractionFailed,
    PersonaDraft,
    ProbeAnswer,
    ProviderUnavailable,
)
from app.faces import FACES, VOICES, fitting_face, photo_url
from app.rate_limit import rate_limit
from app.readiness import score_readiness
from app.routers.sources import _image_type
from app.store import Store, get_store

router = APIRouter(prefix="/api/personas", tags=["personas"])
faces_router = APIRouter(prefix="/api/faces", tags=["personas"])


@faces_router.get("", response_model_by_alias=True)
def list_faces() -> list[Face]:
    return [
        Face(id=f[0], name=name, gender=f[1], look=f[2], photo_url=photo_url(name))
        for name, f in FACES.items()
    ]


StoreDep = Annotated[Store, Depends(get_store)]


def get_extractor() -> Callable[[PersonaCreate], PersonaDraft]:
    return extract.extract_persona


ExtractorDep = Annotated[Callable[[PersonaCreate], PersonaDraft], Depends(get_extractor)]

CoverageChecker = Callable[[Persona, CoverageRequest, list[str]], CoverageDraft]


def get_coverage_checker() -> CoverageChecker:
    return extract.check_coverage


CoverageCheckerDep = Annotated[CoverageChecker, Depends(get_coverage_checker)]

Answerer = Callable[[Persona, PersonaAnswers], AnswersDraft]


def get_answerer() -> Answerer:
    return extract.extract_answer_facts


AnswererDep = Annotated[Answerer, Depends(get_answerer)]


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
    "",
    status_code=201,
    response_model_by_alias=True,
    dependencies=[Depends(require_passcode), Depends(rate_limit("personas"))],
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
    # Sources first: saving the persona lists it, and a listed persona can be picked for an interview.
    store.save_persona_sources(persona.id, body)
    store.save_persona(persona)
    return persona


STATUS_VALUE = {"covered": 1.0, "guessed": 0.5, "missing": 0.0}
# One quote is a thin basis for a whole criterion.
THIN_VALUE = 0.75
READY_SCORE = 0.7


def _value(c: CoverageCriterion) -> float:
    if c.status == "covered" and len(c.evidence_ids) == 1:
        return THIN_VALUE
    return STATUS_VALUE[c.status]


def score_coverage(
    persona: Persona,
    request: CoverageRequest,
    names: list[str],
    draft: CoverageDraft,
    previous: CoverageReport | None = None,
) -> CoverageReport:
    """Turn the model's rows into the report; the checks and the score never trust the model.

    Every requested criterion appears once, in order. "covered" needs evidence the persona
    really has and the model's support words found verbatim in one of the cited quotes, so a
    quote about another topic can't cover a criterion; otherwise it becomes "guessed". With a
    previous report for the same test, weights stay and no row drops below its previous value
    while the evidence behind it is still there, so answering gap questions can't make the score
    fall because the model re-rolled other rows.
    """
    quotes = {e.id: _norm(e.quote or "").casefold() for e in persona.evidence}
    known = set(quotes)
    rows = {_norm(r.name).casefold(): r for r in draft.criteria}
    before = {c.name.casefold(): c for c in previous.criteria} if previous else {}
    criteria = []
    for i, name in enumerate(names):
        row = rows.get(_norm(name).casefold())
        custom = i >= len(DEFAULT_CRITERIA)
        if row is None:
            current = CoverageCriterion(
                name=name,
                status="missing",
                weight=2,
                note="Not assessed.",
                evidence_ids=[],
                custom=custom,
            )
        else:
            ids = [x for x in dict.fromkeys(row.evidence_ids) if x in known]
            support = _norm(row.support).casefold()
            backed = len(support.split()) >= 2 and any(support in quotes[x] for x in ids)
            status = row.status
            if status == "covered" and not backed:
                status = "guessed"
            current = CoverageCriterion(
                name=name,
                status=status,
                weight=min(3, max(1, row.weight)),
                note=row.note,
                evidence_ids=ids if status == "covered" else [],
                custom=custom,
            )
        old = before.get(name.casefold())
        if old is not None:
            still_backed = old.status != "covered" or set(old.evidence_ids) <= known
            # shortcut: a guessed row can't fall to missing after a fact is deleted; fine while
            # answers only add facts, revisit if edits should lower the score.
            if still_backed and _value(old) > _value(current):
                current = old.model_copy(update={"custom": custom})
            current = current.model_copy(update={"weight": old.weight})
        criteria.append(current)
    total = sum(c.weight for c in criteria)
    score = round(sum(c.weight * _value(c) for c in criteria) / total, 2)
    blocked = any(c.weight == 3 and c.status == "missing" for c in criteria)
    # Questions only while something that matters is still guessed or missing.
    gaps = any(c.weight >= 2 and c.status != "covered" for c in criteria)
    return CoverageReport(
        persona_id=persona.id,
        persona_version=persona.version,
        test_goal=request.test_goal,
        score=score,
        recommendation="ready" if score >= READY_SCORE and not blocked else "needs_input",
        criteria=criteria,
        questions=[q.strip() for q in draft.questions if q.strip()][:5] if gaps else [],
    )


@router.post(
    "/{persona_id}/coverage",
    response_model_by_alias=True,
    dependencies=[Depends(require_passcode), Depends(rate_limit("personas"))],
)
def check_coverage(
    persona_id: str, body: CoverageRequest, store: StoreDep, checker: CoverageCheckerDep
) -> CoverageReport:
    persona = store.get_persona(persona_id)
    if persona is None:
        raise HTTPException(404, "persona not found")
    if not body.test_goal.strip():
        raise HTTPException(422, "say what you will test")
    # Custom criteria come after the defaults; repeats of a default are dropped.
    seen = {n.casefold() for n in DEFAULT_CRITERIA}
    custom = []
    for c in (_norm(c) for c in body.criteria):
        if c and c.casefold() not in seen:
            seen.add(c.casefold())
            custom.append(c)
    names = DEFAULT_CRITERIA + custom
    try:
        draft = checker(persona, body, names)
    except ProviderUnavailable:
        raise HTTPException(503, "coverage provider unavailable") from None
    except ExtractionFailed as exc:
        raise HTTPException(502, f"coverage check unusable: {exc}") from None
    previous = store.get_coverage(persona.id)
    if previous and (previous.test_goal, [c.name for c in previous.criteria]) != (
        body.test_goal,
        names,
    ):
        previous = None
    report = score_coverage(persona, body, names, draft, previous)
    store.save_coverage(report)
    return report


def answers_text(body: PersonaAnswers) -> str:
    # Same layout as pasted interview notes; the frontend shows this source by its title only.
    return "\n\n".join(f"Q: {a.question.strip()}\nA: {a.answer.strip()}" for a in body.answers)


def apply_answers(persona: Persona, n: int, body: PersonaAnswers, draft: AnswersDraft) -> Persona:
    """Add the new facts to the same persona; grounded only if the quote is really in an answer.

    `n` is the 1-based number of the answers source among the persona's stored sources.
    """
    answers = [_norm(a.answer) for a in body.answers]
    ids = {e.id for e in persona.evidence}
    # The team knows the real customers: a fact they contradict goes, wherever it is listed.
    replaced = {_norm(f.replaces).casefold() for f in draft.facts if f.replaces.strip()}
    facts: dict[str, list[Fact]] = {
        k: [f for f in getattr(persona, k) if _norm(f.text).casefold() not in replaced]
        for k in ("jobs", "pains", "objections")
    }
    seen = {f.text.casefold() for fs in facts.values() for f in fs}
    evidence = list(persona.evidence)
    for f in draft.facts[:8]:
        text = f.text.strip()
        if not text or text.casefold() in seen:
            continue
        seen.add(text.casefold())
        q = _norm(f.quote)
        evidence_id = None
        if q and any(q in a for a in answers):
            i = len(evidence) + 1
            while f"e{i}" in ids:
                i += 1
            evidence_id = f"e{i}"
            ids.add(evidence_id)
            evidence.append(
                Evidence(
                    id=evidence_id, kind="note", claim=text, quote=f.quote, source_ref=f"source:{n}"
                )
            )
        facts[f.field].append(
            Fact(text=text, label="grounded" if evidence_id else "guess", evidence_id=evidence_id)
        )
    basics: dict = {}
    if draft.age is not None and 0 <= draft.age <= 120:
        basics["age"] = draft.age
    if draft.location.strip():
        basics["location"] = draft.location.strip()
    context = {
        k: v.strip() for k, v in (("job", draft.job), ("household", draft.household)) if v.strip()
    }
    if context:
        basics["context"] = persona.context.model_copy(update=context)
    return persona.model_copy(
        update={
            "version": persona.version + 1,
            "readiness": None,
            "evidence": evidence,
            **facts,
            **basics,
        }
    )


@router.post(
    "/{persona_id}/answers",
    response_model_by_alias=True,
    dependencies=[Depends(require_passcode), Depends(rate_limit("personas"))],
)
def add_answers(
    persona_id: str, body: PersonaAnswers, store: StoreDep, answerer: AnswererDep
) -> Persona:
    persona = store.get_persona(persona_id)
    if persona is None:
        raise HTTPException(404, "persona not found")
    if any(not a.answer.strip() or not a.question.strip() for a in body.answers):
        raise HTTPException(422, "every answer needs text")
    try:
        draft = answerer(persona, body)
    except ProviderUnavailable:
        raise HTTPException(503, "persona provider unavailable") from None
    except ExtractionFailed as exc:
        raise HTTPException(502, f"answers unusable: {exc}") from None
    source = PersonaSource(kind="note", title="Answers to gap questions", text=answers_text(body))
    stored = store.get_persona_sources(persona.id)
    if stored is None:
        stored = PersonaCreate(
            sprint_id=persona.sprint_id, language=persona.language, sources=[source]
        )
    else:
        stored = stored.model_copy(update={"sources": [*stored.sources, source]})
    # Sources first: the live interview reads them, and the facts cite source:N.
    store.save_persona_sources(persona.id, stored)
    persona = apply_answers(persona, len(stored.sources), body, draft)
    store.save_persona(persona)
    return persona


MAX_PHOTO_BYTES = 2 * 1024 * 1024


@router.put(
    "/{persona_id}/photo", response_model_by_alias=True, dependencies=[Depends(require_passcode)]
)
async def upload_photo(persona_id: str, request: Request, store: StoreDep) -> Persona:
    """The body is the raw image. Only shown in the app; the call keeps the persona's face."""
    persona = store.get_persona(persona_id)
    if persona is None:
        raise HTTPException(404, "persona not found")
    body = await request.body()
    if len(body) > MAX_PHOTO_BYTES:
        raise HTTPException(413, "photo is larger than 2 MB")
    mime = _image_type(body)
    if mime not in ("image/png", "image/jpeg", "image/webp"):
        raise HTTPException(422, "use a PNG, JPEG or WebP photo")
    store.save_photo(persona.id, mime, body)
    # No version bump: a picture changes nothing the persona knows, so checks stay valid.
    # The token busts the browser cache when the photo is replaced.
    token = uuid.uuid4().hex[:8]
    persona = persona.model_copy(
        update={"photo_url": f"/api/personas/{persona.id}/photo?v={token}"}
    )
    store.save_persona(persona)
    return persona


@router.delete(
    "/{persona_id}/photo", response_model_by_alias=True, dependencies=[Depends(require_passcode)]
)
def remove_photo(persona_id: str, store: StoreDep) -> Persona:
    persona = store.get_persona(persona_id)
    if persona is None:
        raise HTTPException(404, "persona not found")
    # The stored bytes expire with the usual TTL; without photoUrl nothing serves them.
    persona = persona.model_copy(update={"photo_url": None})
    store.save_persona(persona)
    return persona


@router.post(
    "/{persona_id}/face",
    response_model_by_alias=True,
    dependencies=[Depends(require_passcode), Depends(rate_limit("personas"))],
)
def start_custom_face(persona_id: str, store: StoreDep) -> Persona:
    """Turn the uploaded photo into a Simli face, so the call shows the person in the photo."""
    persona = store.get_persona(persona_id)
    if persona is None:
        raise HTTPException(404, "persona not found")
    photo = store.get_photo(persona.id) if persona.photo_url else None
    if photo is None:
        raise HTTPException(409, "upload a photo first")
    mime, data = photo
    try:
        face_id, after = avatar.generate_face(data, mime, persona.id)
    except avatar.FaceQuotaExceeded:
        raise HTTPException(409, "the Simli account has no avatar generations left") from None
    except avatar.FaceRejected:
        raise HTTPException(
            422, "Simli could not use this photo; try a clear, front-facing portrait"
        ) from None
    except ProviderUnavailable:
        raise HTTPException(503, "Simli unavailable") from None
    custom = CustomFace(
        face_id=face_id,
        status="pending",
        dispatch_after=after,
        requested_at=datetime.now(UTC).isoformat().replace("+00:00", "Z"),
    )
    persona = persona.model_copy(update={"custom_face": custom})
    store.save_persona(persona)
    return persona


@router.post(
    "/{persona_id}/face/refresh",
    response_model_by_alias=True,
    dependencies=[Depends(require_passcode)],
)
def refresh_custom_face(persona_id: str, store: StoreDep) -> Persona:
    persona = store.get_persona(persona_id)
    if persona is None or persona.custom_face is None:
        raise HTTPException(404, "no face generation for this persona")
    custom = persona.custom_face
    if custom.status in ("completed", "failed"):
        return persona
    try:
        status, after = avatar.face_status(custom.face_id)
    except ProviderUnavailable:
        raise HTTPException(503, "Simli unavailable") from None
    changes: dict = {
        "custom_face": custom.model_copy(update={"status": status, "dispatch_after": after})
    }
    if status == "completed":
        # The call now shows the person in the photo; the voice stays as chosen.
        changes["face_id"] = custom.face_id
        changes["version"] = persona.version + 1
    persona = persona.model_copy(update=changes)
    store.save_persona(persona)
    return persona


@router.get("/{persona_id}/photo")
def read_photo(persona_id: str, store: StoreDep) -> Response:
    persona = store.get_persona(persona_id)
    photo = store.get_photo(persona_id) if persona and persona.photo_url else None
    if photo is None:
        raise HTTPException(404, "no photo")
    mime, data = photo
    return Response(data, media_type=mime, headers={"Cache-Control": "private, max-age=3600"})


# Costs no credit, but needs the passcode anyway: a persona's random id is what keeps its facts and
# quotes from the sources private, and this list would hand every id to anyone on the public URL.
@router.get("", response_model_by_alias=True, dependencies=[Depends(require_passcode)])
def list_personas(store: StoreDep) -> list[PersonaSummary]:
    return store.list_personas()


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
    # Identity is the team's call; only fields sent are changed, and age/location may be cleared.
    for name in ("name", "age", "location", "summary", "context"):
        if name in body.model_fields_set and (
            getattr(body, name) is not None or name in ("age", "location")
        ):
            changes[name] = getattr(body, name)
    if body.face_id is not None:
        face = next((n for n, f in FACES.items() if f[0] == body.face_id), None)
        custom = persona.custom_face
        if face is not None:
            # The voice follows a preset face, so it never speaks with the other gender's voice.
            changes["face_id"] = body.face_id
            changes["voice_id"] = VOICES[FACES[face][1]]
        elif custom and custom.status == "completed" and custom.face_id == body.face_id:
            changes["face_id"] = body.face_id
        else:
            raise HTTPException(422, "unknown face")
    if body.voice_id is not None:
        if body.voice_id not in VOICES.values():
            raise HTTPException(422, "unknown voice")
        changes["voice_id"] = body.voice_id
    for name in ("jobs", "pains", "objections"):
        new = getattr(body, name)
        if new is not None:
            changes[name] = relabel(new, getattr(persona, name))
    if body.speech_style is not None:
        changes["speech_style"] = persona.speech_style.model_copy(
            update={k: getattr(body.speech_style, k) for k in body.speech_style.model_fields_set}
        )
    if body.attitudes is not None:
        changes["attitudes"] = persona.attitudes.model_copy(
            update={k: getattr(body.attitudes, k) for k in body.attitudes.model_fields_set}
        )
    persona = persona.model_copy(update=changes)
    store.update_persona(persona)
    return persona
