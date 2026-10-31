"""API contracts. Mirror of code/shared/schema.json — change that file first, then this one and code/frontend/src/lib/contracts.ts."""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field, StringConstraints
from pydantic.alias_generators import to_camel


class Model(BaseModel):
    # JSON is camelCase (schema.json), Python stays snake_case.
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True)


Label = Literal["grounded", "guess"]
SourceKind = Literal["transcript", "miro", "note", "real_interview"]
Language = Literal["de", "en"]
Scale5 = Annotated[int, Field(ge=1, le=5)]
Unit = Annotated[float, Field(ge=0, le=1)]


class Evidence(Model):
    id: str
    kind: SourceKind
    claim: str
    quote: str | None = None
    source_ref: str | None = None


class Fact(Model):
    text: str
    label: Label
    evidence_id: str | None


class PersonaContext(Model):
    job: str | None = None
    household: str | None = None
    tools_today: list[str] = []


# schema.json allows these to be absent but not null, so None is left out of the JSON.
def _omit_none():
    return Field(default=None, exclude_if=lambda v: v is None)


class Attitudes(Model):
    tech_affinity: Scale5 | None = _omit_none()
    price_sensitivity: Scale5 | None = _omit_none()
    trust_in_new_brands: Scale5 | None = _omit_none()


class SpeechStyle(Model):
    register_: Literal["formal", "informal"] | None = Field(
        default=None, alias="register", exclude_if=lambda v: v is None
    )
    verbosity: Literal["short", "medium", "long"] | None = _omit_none()
    fillers: bool | None = _omit_none()
    notes: str | None = None


class Readiness(Model):
    score: Unit
    consistency: Unit
    grounding: Unit


class CustomFace(Model):
    """A Simli face generated from the uploaded photo; becomes faceId once completed."""

    face_id: str
    status: Literal["pending", "processing", "completed", "failed"]
    # Unix seconds: Simli holds generations at least 10 minutes apart per account.
    dispatch_after: int | None = None
    requested_at: str


class Persona(Model):
    id: str
    sprint_id: str | None = None
    version: int = Field(default=1, ge=1)
    name: str
    age: int | None = None
    location: str | None = None
    language: Language
    summary: str
    context: PersonaContext = PersonaContext()
    jobs: list[Fact]
    pains: list[Fact]
    objections: list[Fact]
    attitudes: Attitudes = Attitudes()
    speech_style: SpeechStyle = SpeechStyle()
    voice_id: str
    face_id: str
    # Uploaded profile picture (GET /api/personas/{id}/photo); the call still uses face_id.
    photo_url: str | None = None
    custom_face: CustomFace | None = None
    cloned: bool
    readiness: Readiness | None = None
    evidence: list[Evidence]


class PersonaSummary(Model):
    id: str
    name: str
    role: str | None
    created_at: str
    readiness: Readiness | None


class SpeechNotes(Model):
    # Only fields sent are changed.
    register_: Literal["formal", "informal"] | None = Field(default=None, alias="register")
    verbosity: Literal["short", "medium", "long"] | None = None
    fillers: bool | None = None
    notes: str | None = None


class PersonaUpdate(Model):
    # Identity: absent keeps the stored value; age and location may be set to null ("unknown").
    name: str | None = Field(default=None, min_length=1, max_length=80)
    age: int | None = Field(default=None, ge=0, le=120)
    location: str | None = Field(default=None, max_length=120)
    summary: str | None = Field(default=None, min_length=1, max_length=4000)
    context: PersonaContext | None = None
    face_id: str | None = None
    # A preset face picks its voice; a face made from a photo needs one chosen.
    voice_id: str | None = None
    jobs: list[Fact] | None = None
    pains: list[Fact] | None = None
    objections: list[Fact] | None = None
    speech_style: SpeechNotes | None = None
    attitudes: Attitudes | None = None


class PersonaSource(Model):
    kind: SourceKind
    title: str | None = None
    text: str


class ExtractedText(Model):
    text: str
    pages: int = Field(ge=1)


class PersonaCreate(Model):
    sprint_id: str | None = None
    language: Language
    sources: list[PersonaSource] = Field(min_length=1)


Provider = Literal["openai-realtime", "simli"]


class Session(Model):
    id: str
    persona_id: str
    status: Literal["created", "live", "ended"]
    provider: Provider
    join_url: str | None = None
    interview_guide: list[str] = []
    ready_seconds: float | None = None
    started_at: str | None = None
    ended_at: str | None = None
    sample: bool = False


class SessionCreate(Model):
    persona_id: str
    interview_guide: list[str] = []
    sample: bool = False


class SessionUpdate(Model):
    status: Literal["live", "ended"]


class SessionToken(Model):
    provider: Provider
    token: str | None = None
    url: str | None = None
    expires_at: str


SessionEventType = Literal[
    "utterance", "screen.caption", "twin.reaction", "copilot.suggestion", "session.ended"
]


class SessionEvent(Model):
    session_id: str
    seq: int = Field(ge=1)
    at: str
    type: SessionEventType
    # shortcut: data is untyped per event type here (see schema.json allOf), type it when a consumer needs it.
    data: dict[str, Any]


class Insight(Model):
    id: str
    theme: str
    quote: str
    turn_seq: int
    label: Label
    evidence_id: str | None


class InsightQuestion(Model):
    question: str
    signal: Literal["supports", "contradicts", "unclear"]
    insights: list[Insight]
    follow_ups: list[str] = []


class InsightReport(Model):
    session_id: str
    generated_at: str
    # From the session.ended marker, never from the model. Reports saved before this field read False.
    transcript_gaps: bool = False
    questions: list[InsightQuestion]


class CoverageRequest(Model):
    test_goal: str = Field(min_length=1, max_length=2000)
    criteria: list[Annotated[str, Field(min_length=1, max_length=120)]] = Field(
        default=[], max_length=8
    )


class Face(Model):
    id: str
    name: str
    gender: Literal["f", "m"]
    look: str
    photo_url: str


class GapAnswer(Model):
    question: str = Field(min_length=1, max_length=500)
    answer: str = Field(min_length=1, max_length=4000)


class PersonaAnswers(Model):
    answers: list[GapAnswer] = Field(min_length=1, max_length=5)


CoverageStatus = Literal["covered", "guessed", "missing"]


class CoverageCriterion(Model):
    name: str
    status: CoverageStatus
    weight: Annotated[int, Field(ge=1, le=3)]
    note: str
    evidence_ids: list[str]
    custom: bool


CoverageCategoryName = Literal["persona", "challenge", "solution"]
CoverageLevel = Literal["red", "yellow", "green"]


class CoverageCategory(Model):
    category: CoverageCategoryName
    level: CoverageLevel
    score: Unit
    covered: int = Field(ge=0)
    total: int = Field(ge=1)
    reason: str
    recommendation: str | None


class SourceDiversity(Model):
    count: int = Field(ge=0)
    kinds: list[SourceKind]
    minimum: int = Field(ge=1)
    met: bool


class CoverageReport(Model):
    persona_id: str
    persona_version: int = Field(ge=1)
    test_goal: str
    score: Unit
    recommendation: Literal["ready", "needs_input"]
    overall: Literal["good_enough", "add_more"]
    categories: list[CoverageCategory]
    source_diversity: SourceDiversity
    criteria: list[CoverageCriterion]
    questions: list[str] = Field(max_length=5)


GuideIssue = Literal["leading", "hypothetical", "closed", "pitch"]
GuideQuestion = Annotated[
    str, StringConstraints(strip_whitespace=True, min_length=1, max_length=500)
]


class GuideReviewRequest(Model):
    questions: list[GuideQuestion] = Field(min_length=1, max_length=50)
    language: Language


class GuideReviewItem(Model):
    question: str
    issues: list[GuideIssue]
    rewrite: str | None


class GuideReview(Model):
    items: list[GuideReviewItem]
