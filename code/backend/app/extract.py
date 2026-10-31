"""Persona extraction: pasted sources -> PersonaDraft, via OpenAI Structured Outputs.

The single place that talks to OpenAI. Tests replace `_client()`; nothing here logs source text.
"""

import base64
import os
from collections.abc import Iterator
from contextlib import contextmanager
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

Make it one specific, believable human, not a segment or a participant code:
- Give a real first and last name typical for the region in the sources (e.g. Swiss for Luzern).
  Never use a participant code (P1, Teilnehmer A, User 3) or a role as the name.
- Decide one gender and use it consistently; never write "sie oder er", "they/he" or similar.
- Write the summary as a short personal story in the third person (4-6 sentences) that goes
  beyond the sources: where they work, their kids' or partner's names and ages, a concrete weekly
  routine, one specific memory that explains their attitude to the topic, a small quirk. It must
  not contradict the sources; invented details belong here, because the summary is the
  persona's backstory, not evidence.
- Add at least two of these invented personal details as facts labelled "guess" (a routine or a
  past experience behind a pain or objection), so the card shows which parts are invented.

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


@contextmanager
def _provider_errors() -> Iterator[None]:
    """Map OpenAI errors to ProviderUnavailable (503) or ExtractionFailed (502)."""
    try:
        yield
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


def extract_persona(request: PersonaCreate) -> PersonaDraft:
    with _provider_errors():
        response = _client().responses.parse(
            model=os.environ.get("OPENAI_MODEL") or DEFAULT_MODEL,
            instructions=INSTRUCTIONS.format(language_name=LANGUAGES[request.language]),
            input=_format_sources(request),
            text_format=PersonaDraft,
        )

    draft = response.output_parsed
    if draft is None:
        # No parsed output means a refusal or an incomplete answer.
        raise ExtractionFailed(f"no persona in response (status {response.status})")
    return draft


TRANSCRIBE = """\
Transcribe all text visible in this image or scanned document verbatim, in reading order, in its original language.
One sticky note, card or speech bubble per line. Keep the exact wording and spelling; do not
translate, summarize, correct or describe the image. Output only the transcribed text, or nothing
if the image contains no readable text.
"""


def transcribe(data: bytes, mime: str) -> str:
    """Return the text visible in an image or scanned PDF, so it can be quoted like any source."""
    url = f"data:{mime};base64,{base64.b64encode(data).decode()}"
    part = (
        {"type": "input_file", "filename": "scan.pdf", "file_data": url}
        if mime == "application/pdf"
        else {"type": "input_image", "image_url": url}
    )
    with _provider_errors():
        response = _client().responses.create(
            model=os.environ.get("OPENAI_MODEL") or DEFAULT_MODEL,
            instructions=TRANSCRIBE,
            input=[{"role": "user", "content": [part]}],
        )
    return response.output_text.strip()
