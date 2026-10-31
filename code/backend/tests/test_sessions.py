import json
import time
from pathlib import Path
from types import SimpleNamespace

import httpx
import openai
import pytest
from fastapi.testclient import TestClient

from app import avatar, realtime
from app.contracts import Persona, PersonaCreate
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
    # Screen frames carry this exact label (ScreenShareButton, #101); the persona must read them.
    assert "(Interviewer's shared screen, the prototype, right now.)" in session["instructions"]
    assert session["audio"]["input"]["transcription"]["language"] == "de"
    assert session["audio"]["input"]["turn_detection"] == {
        "type": "semantic_vad",
        "eagerness": "low",
    }
    assert session["audio"]["input"]["noise_reduction"] == {"type": "near_field"}


def test_token_instructions_carry_product_material_and_guide(client, secrets):
    store = app.dependency_overrides[get_store]()
    store.save_persona_sources(
        PERSONA["id"],
        PersonaCreate(
            language="de",
            sources=[
                {"kind": "note", "text": "Prototype: Kilo-Shares slider screen"},
                {"kind": "transcript", "text": "P1: secret interview words"},
            ],
        ),
    )
    client.post(f"/api/sessions/{new_session(client)['id']}/token")
    text = secrets.calls[0]["session"]["instructions"]
    assert "Kilo-Shares slider screen" in text and "- Q1" in text
    # Transcripts are already distilled into the facts, so they stay out of the prompt.
    assert "secret interview words" not in text


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


def test_noise_reduction_configurable(client, secrets, monkeypatch):
    monkeypatch.setenv("OPENAI_REALTIME_NOISE_REDUCTION", "far_field")
    client.post(f"/api/sessions/{new_session(client)['id']}/token")
    assert secrets.calls[0]["session"]["audio"]["input"]["noise_reduction"] == {"type": "far_field"}


def test_voice_comes_from_persona():
    p = Persona.model_validate(PERSONA)
    p.voice_id = "cedar"
    assert realtime.voice_for(p) == "cedar"
    p.voice_id = "stock_f_01"
    assert realtime.voice_for(p) == realtime.DEFAULT_VOICE


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


class FakeSimli:
    def __init__(self, status=200, body=None):
        self.calls, self.status = [], status
        self.body = {"session_token": "simli_tok", "warnings": []} if body is None else body

    def post(self, url, headers, json, timeout):
        self.calls.append({"url": url, "headers": headers, "json": json})
        return httpx.Response(self.status, json=self.body, request=httpx.Request("POST", url))


@pytest.fixture
def simli(monkeypatch):
    monkeypatch.setenv("SIMLI_API_KEY", "simli_secret")
    monkeypatch.delenv("SIMLI_FACE_ID", raising=False)
    fake = FakeSimli()
    monkeypatch.setattr(avatar.httpx, "post", fake.post)
    return fake


def test_avatar_token_is_short_lived_simli_token(client, simli):
    res = client.post(f"/api/sessions/{new_session(client)['id']}/avatar-token")
    assert res.status_code == 200 and res.headers["cache-control"] == "no-store"
    body = res.json()
    assert body["provider"] == "simli" and body["token"] == "simli_tok" and body["url"] is None
    assert body["expiresAt"].endswith("Z") and "simli_secret" not in res.text
    call = simli.calls[0]
    assert call["url"] == avatar.TOKEN_URL and call["headers"] == {
        "x-simli-api-key": "simli_secret"
    }
    # The example persona has a stock face id, so the default Simli preset is used.
    assert call["json"]["faceId"] == avatar.DEFAULT_FACE
    assert call["json"]["maxSessionLength"] == avatar.MAX_SESSION_SECONDS


def test_avatar_face_from_persona_uuid_or_env(monkeypatch):
    p = Persona.model_validate(PERSONA)
    monkeypatch.setenv("SIMLI_FACE_ID", "env-face")
    assert avatar.face_for(p) == "env-face"
    p.face_id = "f735e62c-dce7-4c0b-8e85-1c7e21774c45"
    assert avatar.face_for(p) == p.face_id


def test_avatar_token_without_key_or_on_simli_error_is_503(client, simli, monkeypatch):
    sid = new_session(client)["id"]
    monkeypatch.delenv("SIMLI_API_KEY")
    assert client.post(f"/api/sessions/{sid}/avatar-token").status_code == 503
    assert simli.calls == []
    monkeypatch.setenv("SIMLI_API_KEY", "simli_secret")
    cases = [(401, {"detail": "bad key simli_secret"}), (400, {"session_token": "FAIL TOKEN"})]
    # Malformed 200 answers must also be a controlled 503, never a 500.
    cases += [(200, b) for b in ([], "tok", 3, {}, {"session_token": None}, {"session_token": ""})]
    for status, body in cases:
        simli.status, simli.body = status, body
        res = client.post(f"/api/sessions/{sid}/avatar-token")
        assert res.status_code == 503 and "simli_secret" not in res.text


def test_avatar_token_404_and_409(client, simli):
    assert client.post("/api/sessions/s_missing/avatar-token").status_code == 404
    sid = new_session(client)["id"]
    client.patch(f"/api/sessions/{sid}", json={"status": "ended"})
    assert client.post(f"/api/sessions/{sid}/avatar-token").status_code == 409
    assert simli.calls == []
