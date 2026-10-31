import json
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import httpx
import openai
import pytest
from fastapi.testclient import TestClient

from app import avatar, extract, provider_log, realtime
from app.contracts import Persona, PersonaCreate, Session, SessionEvent
from app.extract import ExtractionFailed, ProviderUnavailable
from app.main import REQUEST_ID_HEADER, app
from app.store import Store, get_store
from tests.fakes import FakeRedis

BACKEND = Path(__file__).parents[1]
EXAMPLES = BACKEND.parent / "shared" / "examples"
HTTP_REQ = httpx.Request("POST", "https://api.openai.com/v1/responses")

SOURCE_TEXT = "SENTINEL-SOURCE vertrauliche Aussage"
TRANSCRIPT = "SENTINEL-TRANSCRIPT das hat die Persona gesagt"
API_KEY = "sk-SENTINEL-KEY"
# Provider errors can echo the request, so the error message carries everything secret.
ECHO = f"{SOURCE_TEXT} {TRANSCRIPT} {API_KEY}"


def load(name: str):
    return json.loads((EXAMPLES / name).read_text())


PERSONA = Persona.model_validate(load("persona.json"))
SESSION = Session.model_validate({**load("session.json"), "status": "ended"})
EVENTS = [
    SessionEvent.model_validate(
        {
            "sessionId": SESSION.id,
            "seq": 1,
            "at": "2026-10-31T14:00:00Z",
            "type": "utterance",
            "data": {"speaker": "persona", "text": TRANSCRIPT, "tStart": 1.0, "tEnd": 2.0},
        }
    )
]
REQUEST = PersonaCreate.model_validate(
    {"language": "de", "sources": [{"kind": "note", "text": SOURCE_TEXT}]}
)


class FakeOpenAI:
    """Stands in for the responses and realtime clients; every call does the same thing."""

    def __init__(self, result=None, error=None):
        self.result, self.error = result, error
        self.responses = SimpleNamespace(parse=self._call, create=self._call)
        self.realtime = SimpleNamespace(client_secrets=SimpleNamespace(create=self._call))

    def _call(self, **_kwargs):
        if self.error:
            raise self.error
        return self.result


def use_openai(monkeypatch, **kwargs):
    fake = FakeOpenAI(**kwargs)
    monkeypatch.setattr(extract, "_client", lambda: fake)
    monkeypatch.setattr(realtime, "_client", lambda: fake)


@pytest.fixture
def logged(caplog):
    """The provider log lines. The logger doesn't propagate, so caplog is attached directly."""
    provider_log.logger.addHandler(caplog.handler)
    yield lambda: [json.loads(record.getMessage()) for record in caplog.records]
    provider_log.logger.removeHandler(caplog.handler)


def echoing_bad_request():
    return openai.BadRequestError(
        ECHO, response=httpx.Response(400, request=HTTP_REQ, text=ECHO), body=ECHO
    )


def test_line_is_printed_under_default_logging():
    """Uvicorn leaves the root logger at WARNING, so a plain logger.info would vanish."""
    code = (
        "from app.provider_log import provider_call\n"
        "with provider_call('openai', 'transcribe'):\n"
        "    pass\n"
    )
    done = subprocess.run(
        [sys.executable, "-c", code], cwd=BACKEND, capture_output=True, text=True, check=True
    )
    lines = done.stdout.splitlines()
    assert len(lines) == 1
    assert json.loads(lines[0])["operation"] == "transcribe"


def test_success_line_has_exactly_the_agreed_fields(logged, monkeypatch):
    use_openai(monkeypatch, result=SimpleNamespace(output_parsed="draft"))
    assert extract.extract_persona(REQUEST) == "draft"
    [line] = logged()
    latency = line.pop("latency_ms")
    assert isinstance(latency, int) and latency >= 0
    assert line == {
        "event": "provider_call",
        "provider": "openai",
        "operation": "extract_persona",
        "status": "ok",
        "error": None,
        "http_status": None,
        "session_id": None,
        "request_id": None,
    }


def test_openai_failure_logs_the_real_class_not_the_mapped_one(logged, monkeypatch):
    error = openai.RateLimitError(
        "slow down", response=httpx.Response(429, request=HTTP_REQ), body=None
    )
    use_openai(monkeypatch, error=error)
    with pytest.raises(ProviderUnavailable):
        realtime.mint_client_secret(PERSONA, session_id="s_9")
    [line] = logged()
    assert (line["provider"], line["operation"]) == ("openai", "realtime_token")
    assert (line["status"], line["error"]) == ("error", "RateLimitError")
    assert line["http_status"] == 429
    assert line["session_id"] == "s_9"


def test_missing_openai_key_is_logged(logged, monkeypatch):
    extract._client.cache_clear()
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    with pytest.raises(ProviderUnavailable):
        extract.transcribe(b"png", "image/png")
    assert logged()[0]["error"] == "ProviderUnavailable"


def test_refusal_is_a_failed_call_not_ok(logged, monkeypatch):
    use_openai(monkeypatch, result=SimpleNamespace(output_parsed=None, status="incomplete"))
    with pytest.raises(ExtractionFailed):
        extract.extract_persona(REQUEST)
    [line] = logged()
    assert (line["status"], line["error"]) == ("error", "ExtractionFailed")


def test_simli_http_failure(logged, monkeypatch):
    monkeypatch.setenv("SIMLI_API_KEY", API_KEY)

    def post(url, **_kwargs):
        return httpx.Response(500, text=ECHO, request=httpx.Request("POST", url))

    monkeypatch.setattr(avatar.httpx, "post", post)
    with pytest.raises(ProviderUnavailable):
        avatar.mint_session_token(PERSONA, "s_9")
    [line] = logged()
    assert (line["provider"], line["operation"]) == ("simli", "avatar_token")
    assert (line["error"], line["http_status"]) == ("HTTPStatusError", 500)
    assert line["session_id"] == "s_9"


@pytest.mark.parametrize(
    "body", [None, {"session_token": "FAIL TOKEN"}], ids=["missing key", "no token"]
)
def test_simli_setup_failures_are_logged(logged, monkeypatch, body):
    monkeypatch.delenv("SIMLI_API_KEY", raising=False)
    if body is not None:
        monkeypatch.setenv("SIMLI_API_KEY", API_KEY)
        monkeypatch.setattr(
            avatar.httpx,
            "post",
            lambda url, **_: httpx.Response(200, json=body, request=httpx.Request("POST", url)),
        )
    with pytest.raises(ProviderUnavailable):
        avatar.mint_session_token(PERSONA)
    assert logged()[0]["error"] == "ProviderUnavailable"


@pytest.mark.parametrize(
    ("call", "expected"),
    [
        (lambda: extract.extract_persona(REQUEST), ExtractionFailed),
        (lambda: extract.transcribe(b"png", "image/png"), ExtractionFailed),
        (lambda: extract.extract_debrief(SESSION, PERSONA, EVENTS), ExtractionFailed),
        (lambda: realtime.mint_client_secret(PERSONA, ["Q1"], []), ProviderUnavailable),
    ],
    ids=["persona", "transcribe", "debrief", "realtime"],
)
def test_no_content_or_key_in_the_logs(logged, caplog, monkeypatch, call, expected):
    monkeypatch.setenv("OPENAI_API_KEY", API_KEY)
    use_openai(monkeypatch, error=echoing_bad_request())
    with pytest.raises(expected):
        call()
    # The raw class, not the mapped one: the wrapper must sit inside the error mapping.
    assert [line["error"] for line in logged()] == ["BadRequestError"]
    assert "SENTINEL" not in caplog.text
    assert not any(record.exc_info or record.exc_text for record in caplog.records)


def test_no_simli_body_or_key_in_the_logs(logged, caplog, monkeypatch):
    monkeypatch.setenv("SIMLI_API_KEY", API_KEY)
    monkeypatch.setattr(
        avatar.httpx,
        "post",
        lambda url, **_: httpx.Response(401, text=ECHO, request=httpx.Request("POST", url)),
    )
    with pytest.raises(ProviderUnavailable):
        avatar.mint_session_token(PERSONA)
    assert logged()[0]["http_status"] == 401
    assert "SENTINEL" not in caplog.text


@pytest.fixture
def client():
    store = Store(FakeRedis())
    store.save_persona(PERSONA)
    app.dependency_overrides[get_store] = lambda: store
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_response_header_matches_the_log_line(logged, caplog, client, monkeypatch):
    use_openai(monkeypatch, error=echoing_bad_request())
    res = client.post(
        "/api/personas",
        json={"language": "de", "sources": [{"kind": "note", "text": SOURCE_TEXT}]},
    )
    assert res.status_code == 502
    [line] = logged()
    assert line["request_id"] == res.headers[REQUEST_ID_HEADER]
    assert "SENTINEL" not in caplog.text


def test_session_routes_log_their_session_id(logged, client, monkeypatch):
    monkeypatch.delenv("SIMLI_API_KEY", raising=False)
    use_openai(monkeypatch, error=echoing_bad_request())
    session_id = client.post(
        "/api/sessions", json={"personaId": PERSONA.id, "interviewGuide": ["Q1"]}
    ).json()["id"]
    assert client.post(f"/api/sessions/{session_id}/token").status_code == 503
    assert client.post(f"/api/sessions/{session_id}/avatar-token").status_code == 503
    assert [line["session_id"] for line in logged()] == [session_id, session_id]


@pytest.mark.parametrize(
    ("path", "status"),
    [("/api/health", 200), ("/api/personas/missing", 404)],
    ids=["ok", "http error"],
)
def test_every_response_has_a_fresh_request_id(client, path, status):
    first, second = client.get(path), client.get(path)
    assert first.status_code == status
    assert first.headers[REQUEST_ID_HEADER] != second.headers[REQUEST_ID_HEADER]


def test_client_cannot_choose_the_request_id(client):
    res = client.get("/api/health", headers={REQUEST_ID_HEADER: "forged"})
    assert res.headers[REQUEST_ID_HEADER] != "forged"


def test_crash_keeps_the_default_500_and_still_has_a_request_id():
    def crash():
        raise RuntimeError("boom")

    app.dependency_overrides[get_store] = crash
    try:
        res = TestClient(app, raise_server_exceptions=False).get("/api/sessions/s_1")
    finally:
        app.dependency_overrides.clear()
    assert (res.status_code, res.text) == (500, "Internal Server Error")
    assert res.headers[REQUEST_ID_HEADER]
