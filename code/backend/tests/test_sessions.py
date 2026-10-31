import json
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import openai
import pytest
from fastapi.testclient import TestClient

from app import realtime
from app.contracts import Persona
from app.main import app
from app.store import Store, get_store
from tests.fakes import FakeRedis

PERSONA = json.loads(
    (Path(__file__).parents[2] / "shared" / "examples" / "persona.json").read_text()
)


class FakeSecrets:
    def __init__(self, error=None):
        self.calls, self.error = [], error

    def create(self, **kwargs):
        self.calls.append(kwargs)
        if self.error:
            raise self.error
        return SimpleNamespace(value="ek_test_123", expires_at=int(time.time()) + 600)


@pytest.fixture
def secrets(monkeypatch):
    fake = FakeSecrets()
    client = SimpleNamespace(realtime=SimpleNamespace(client_secrets=fake))
    monkeypatch.setattr(realtime, "_client", lambda: client)
    return fake


@pytest.fixture
def client(secrets):
    store = Store(FakeRedis())
    store.save_persona(Persona.model_validate(PERSONA))
    app.dependency_overrides[get_store] = lambda: store
    yield TestClient(app)
    app.dependency_overrides.clear()


def new_session(client) -> dict:
    res = client.post("/api/sessions", json={"personaId": PERSONA["id"], "interviewGuide": ["Q1"]})
    assert res.status_code == 201
    return res.json()


def test_create_then_read(client):
    s = new_session(client)
    assert s["id"].startswith("s_") and s["status"] == "created"
    assert s["provider"] == "openai-realtime" and s["interviewGuide"] == ["Q1"]
    assert client.get(f"/api/sessions/{s['id']}").json() == s


def test_unknown_persona_and_session_404(client):
    assert client.post("/api/sessions", json={"personaId": "p_nope"}).status_code == 404
    assert client.get("/api/sessions/s_nope").status_code == 404
    assert client.patch("/api/sessions/s_nope", json={"status": "live"}).status_code == 404
    assert client.post("/api/sessions/s_nope/token").status_code == 404


def test_status_transitions(client):
    sid = new_session(client)["id"]
    live = client.patch(f"/api/sessions/{sid}", json={"status": "live"}).json()
    assert live["status"] == "live" and live["startedAt"] and live["endedAt"] is None
    again = client.patch(f"/api/sessions/{sid}", json={"status": "live"}).json()
    assert again["startedAt"] == live["startedAt"]

    ended = client.patch(f"/api/sessions/{sid}", json={"status": "ended"}).json()
    assert (
        ended["status"] == "ended" and ended["startedAt"] == live["startedAt"] and ended["endedAt"]
    )
    # Repeated end is a no-op with a stable endedAt; going back is a conflict.
    assert client.patch(f"/api/sessions/{sid}", json={"status": "ended"}).json() == ended
    assert client.patch(f"/api/sessions/{sid}", json={"status": "live"}).status_code == 409


def test_created_can_end_directly(client):
    sid = new_session(client)["id"]
    ended = client.patch(f"/api/sessions/{sid}", json={"status": "ended"}).json()
    assert ended["status"] == "ended" and ended["startedAt"] is None


def test_invalid_status_is_422(client):
    sid = new_session(client)["id"]
    assert client.patch(f"/api/sessions/{sid}", json={"status": "created"}).status_code == 422


def test_token_is_short_lived_client_secret_with_persona_session(client, secrets, monkeypatch):
    monkeypatch.delenv("OPENAI_REALTIME_MODEL", raising=False)
    sid = new_session(client)["id"]
    res = client.post(f"/api/sessions/{sid}/token")
    assert res.status_code == 200
    assert res.headers["cache-control"] == "no-store"
    body = res.json()
    assert body["provider"] == "openai-realtime" and body["token"] == "ek_test_123"
    assert body["url"] == realtime.CALLS_URL and body["expiresAt"].endswith("Z")

    call = secrets.calls[0]
    assert call["expires_after"] == {"anchor": "created_at", "seconds": 600}
    session = call["session"]
    assert session["type"] == "realtime" and session["model"] == realtime.DEFAULT_MODEL
    # The persona is fixed server-side: name, facts and the no-design-advice rule are in it.
    assert PERSONA["name"] in session["instructions"]
    assert PERSONA["pains"][0]["text"] in session["instructions"]
    assert "design advice" in session["instructions"]
    assert session["audio"]["input"]["transcription"]["language"] == "de"


def test_guesses_are_marked_in_instructions():
    text = realtime.persona_instructions(Persona.model_validate(PERSONA))
    guess = next(f["text"] for f in PERSONA["objections"] if f["label"] == "guess")
    assert f"- {guess} (your guess)" in text


def test_model_and_voice_configurable(client, secrets, monkeypatch):
    monkeypatch.setenv("OPENAI_REALTIME_MODEL", "gpt-realtime-test")
    monkeypatch.setenv("OPENAI_REALTIME_VOICE", "cedar")
    client.post(f"/api/sessions/{new_session(client)['id']}/token")
    session = secrets.calls[0]["session"]
    assert (
        session["model"] == "gpt-realtime-test" and session["audio"]["output"]["voice"] == "cedar"
    )


def test_no_token_after_end(client, secrets):
    sid = new_session(client)["id"]
    client.patch(f"/api/sessions/{sid}", json={"status": "ended"})
    assert client.post(f"/api/sessions/{sid}/token").status_code == 409
    assert secrets.calls == []


def test_provider_failure_is_503_without_details(client, secrets):
    req = httpx.Request("POST", "https://api.openai.com/v1/realtime/client_secrets")
    secrets.error = openai.AuthenticationError(
        "bad key sk-secret", response=httpx.Response(401, request=req), body=None
    )
    res = client.post(f"/api/sessions/{new_session(client)['id']}/token")
    assert res.status_code == 503 and "sk-secret" not in res.text
