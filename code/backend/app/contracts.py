"""API contracts. Mirror of code/shared/schema.json — change that file first, then this one and code/frontend/src/lib/contracts.ts."""

from typing import Annotated, Any, Literal

from pydantic import BaseModel, ConfigDict, Field
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
    cloned: bool
    readiness: Readiness | None = None
    evidence: list[Evidence]


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


Provider = Literal["tavus", "anam", "livekit", "openai-realtime", "simli"]


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


class SessionCreate(Model):
    persona_id: str
    interview_guide: list[str] = []


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
    questions: list[InsightQuestion]
