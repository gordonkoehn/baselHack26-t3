import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import openai
import pytest

from app import extract
from app.contracts import PersonaCreate
from app.extract import ExtractionFailed, PersonaDraft, ProviderUnavailable

EXAMPLE = json.loads(
    (Path(__file__).parents[2] / "shared" / "examples" / "persona.json").read_text()
)
DRAFT = PersonaDraft.model_validate(
    {k: v for k, v in EXAMPLE.items() if k in PersonaDraft.model_fields or k == "speechStyle"}
)
REQUEST = PersonaCreate.model_validate(
    {"language": "de", "sources": [{"kind": "miro", "title": "Leitfaden", "text": "Quelle eins."}]}
)
HTTP_REQ = httpx.Request("POST", "https://api.openai.com/v1/responses")


def status_error(cls, code):
    return cls("boom", response=httpx.Response(code, request=HTTP_REQ), body=None)


class FakeResponses:
    def __init__(self, result=None, error=None):
        self.result, self.error, self.calls = result, error, []

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return self.result

    create = parse


def use_client(monkeypatch, responses):
    monkeypatch.setattr(extract, "_client", lambda: SimpleNamespace(responses=responses))
    return responses


def test_returns_parsed_draft_and_sends_sources(monkeypatch):
    monkeypatch.setenv("OPENAI_MODEL", "gpt-test")
    fake = use_client(monkeypatch, FakeResponses(SimpleNamespace(output_parsed=DRAFT)))
    assert extract.extract_persona(REQUEST) == DRAFT
    call = fake.calls[0]
    assert call["model"] == "gpt-test"
    assert call["text_format"] is PersonaDraft
    assert "<source n=1 kind=miro — Leitfaden>" in call["input"] and "Quelle eins." in call["input"]
    assert "German" in call["instructions"] and "VERBATIM" in call["instructions"]


def test_default_model_when_unset(monkeypatch):
    monkeypatch.delenv("OPENAI_MODEL", raising=False)
    fake = use_client(monkeypatch, FakeResponses(SimpleNamespace(output_parsed=DRAFT)))
    extract.extract_persona(REQUEST)
    assert fake.calls[0]["model"] == extract.DEFAULT_MODEL


def test_refusal_or_incomplete_fails(monkeypatch):
    use_client(monkeypatch, FakeResponses(SimpleNamespace(output_parsed=None, status="incomplete")))
    with pytest.raises(ExtractionFailed):
        extract.extract_persona(REQUEST)


@pytest.mark.parametrize(
    ("error", "expected"),
    [
        (openai.APITimeoutError(request=HTTP_REQ), ProviderUnavailable),
        (openai.APIConnectionError(request=HTTP_REQ), ProviderUnavailable),
        (
            openai.RateLimitError(
                "slow down", response=httpx.Response(429, request=HTTP_REQ), body=None
            ),
            ProviderUnavailable,
        ),
        (
            openai.BadRequestError(
                "bad schema", response=httpx.Response(400, request=HTTP_REQ), body=None
            ),
            ExtractionFailed,
        ),
        (status_error(openai.NotFoundError, 404), ProviderUnavailable),
        (status_error(openai.UnprocessableEntityError, 422), ExtractionFailed),
        (status_error(openai.APIStatusError, 418), ProviderUnavailable),
    ],
)
def test_provider_errors_are_mapped(monkeypatch, error, expected):
    use_client(monkeypatch, FakeResponses(error=error))
    with pytest.raises(expected) as err:
        extract.extract_persona(REQUEST)
    assert "Quelle" not in str(err.value)


def test_missing_key_is_unavailable(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    extract._client.cache_clear()
    with pytest.raises(ProviderUnavailable):
        extract.extract_persona(REQUEST)


def test_transcribe_image_sends_data_url_and_strips(monkeypatch):
    fake = use_client(
        monkeypatch,
        FakeResponses(
            SimpleNamespace(output_text="  Zettel 1\n", status="completed", error=None, output=[])
        ),
    )
    assert extract.transcribe(b"\x89PNG", "image/png") == "Zettel 1"
    image = fake.calls[0]["input"][0]["content"][0]
    assert image == {"type": "input_image", "image_url": "data:image/png;base64,iVBORw=="}


def test_transcribe_image_maps_errors(monkeypatch):
    use_client(monkeypatch, FakeResponses(error=status_error(openai.RateLimitError, 429)))
    with pytest.raises(ProviderUnavailable):
        extract.transcribe(b"x", "image/png")


def test_transcribe_pdf_sends_input_file(monkeypatch):
    fake = use_client(
        monkeypatch,
        FakeResponses(
            SimpleNamespace(output_text="Seite 1", status="completed", error=None, output=[])
        ),
    )
    assert extract.transcribe(b"%PDF", "application/pdf") == "Seite 1"
    part = fake.calls[0]["input"][0]["content"][0]
    assert part["type"] == "input_file" and part["file_data"].startswith("data:application/pdf;")
