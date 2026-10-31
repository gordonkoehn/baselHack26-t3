"""Persona extraction: pasted sources -> PersonaDraft, via OpenAI Structured Outputs.

The single place that talks to OpenAI. Tests replace `_client()`; nothing here logs source text.
"""

import os
from functools import lru_cache

import openai
from pydantic import ValidationError

from app.contracts import (
    Attitudes,
    Evidence,
    Fact,
    Model,
    PersonaContext,
    PersonaCreate,
    SpeechStyle,
)

DEFAULT_MODEL = "gpt-5.4-mini"
TIMEOUT_SECONDS = 90


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


INSTRUCTIONS = """\
You build one realistic interview persona for a design sprint from the sources the user pastes.
The persona must be someone the team could interview: a single person with a name, context, jobs,
pains and objections, consistent with the sources.

Evidence rules (they are checked by code, violations reject the whole persona):
- Every evidence item quotes the sources VERBATIM: copy an exact contiguous passage, no edits,
  no translation, no ellipsis. Keep quotes short (one or two sentences).
- evidence.kind is the kind of the source the quote comes from; evidence.sourceRef is "source:N".
- Evidence ids are unique: e1, e2, ...
- Only quote what end users said or did: interview answers, observed behaviour, research
  findings about users. NEVER quote interviewer questions, interview-guide instructions, task
  descriptions, prototype descriptions or the team's assumptions/hypotheses as evidence: they
  describe what the team wants to test, not the user. In a transcript, quote the participant's
  lines, not the interviewer's.
- A fact is "grounded" only if a quoted passage directly supports it; then evidenceId is that id.
- If the sources contain no user statements (only a guide or hypotheses), every fact is a guess.
- Everything else (plausible but not stated) is "guess" with evidenceId null. Prefer honest
  guesses over stretching a quote. Synthetic details are always guesses.

Write all persona text in {language_name}. Do not give design advice; describe the person.
"""

LANGUAGES = {"de": "German (Swiss Standard German where natural)", "en": "English"}


def _format_sources(request: PersonaCreate) -> str:
    parts = []
    for i, s in enumerate(request.sources, start=1):
        title = f" — {s.title}" if s.title else ""
        parts.append(f"<source n={i} kind={s.kind}{title}>\n{s.text}\n</source>")
    return "\n\n".join(parts)


@lru_cache
def _client() -> openai.OpenAI:
    if not os.environ.get("OPENAI_API_KEY"):
        raise ProviderUnavailable("OPENAI_API_KEY not configured")
    return openai.OpenAI(timeout=TIMEOUT_SECONDS, max_retries=1)


def extract_persona(request: PersonaCreate) -> PersonaDraft:
    try:
        response = _client().responses.parse(
            model=os.environ.get("OPENAI_MODEL") or DEFAULT_MODEL,
            instructions=INSTRUCTIONS.format(language_name=LANGUAGES[request.language]),
            input=_format_sources(request),
            text_format=PersonaDraft,
        )
    except (
        openai.APITimeoutError,
        openai.APIConnectionError,
        openai.RateLimitError,
        openai.AuthenticationError,
        openai.PermissionDeniedError,
        openai.InternalServerError,
    ) as exc:
        raise ProviderUnavailable(type(exc).__name__) from None
    except (
        openai.LengthFinishReasonError,
        openai.ContentFilterFinishReasonError,
        openai.BadRequestError,
        openai.UnprocessableEntityError,
        ValidationError,
    ) as exc:
        raise ExtractionFailed(type(exc).__name__) from None
    except openai.APIStatusError as exc:
        # Anything else from the API (e.g. 404 for an unknown OPENAI_MODEL) is a setup or
        # service problem, not bad persona output.
        raise ProviderUnavailable(f"{type(exc).__name__} {exc.status_code}") from None
    except openai.OpenAIError as exc:
        raise ProviderUnavailable(type(exc).__name__) from None

    draft = response.output_parsed
    if draft is None:
        # No parsed output means a refusal or an incomplete answer.
        raise ExtractionFailed(f"no persona in response (status {response.status})")
    return draft
