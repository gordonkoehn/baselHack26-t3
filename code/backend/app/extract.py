"""Persona extraction: pasted sources -> PersonaDraft. The provider call lands here in #28."""

from app.contracts import (
    Attitudes,
    Evidence,
    Fact,
    Model,
    PersonaContext,
    PersonaCreate,
    SpeechStyle,
)


class PersonaDraft(Model):
    """What the provider must produce: a Persona without the server-assigned fields."""

    name: str
    age: int | None = None
    location: str | None = None
    summary: str
    context: PersonaContext = PersonaContext()
    jobs: list[Fact]
    pains: list[Fact]
    objections: list[Fact]
    attitudes: Attitudes = Attitudes()
    speech_style: SpeechStyle = SpeechStyle()
    evidence: list[Evidence]


class ProviderUnavailable(Exception):
    """Provider not configured, unreachable or timed out. Endpoints map this to 503."""


class ExtractionFailed(Exception):
    """Provider answered, but with a refusal or output we can't use. Endpoints map this to 502."""


def extract_persona(request: PersonaCreate) -> PersonaDraft:
    raise ProviderUnavailable("persona extraction provider not configured yet (#28)")
