import json
import time
from pathlib import Path

import jwt
import pytest
from fastapi.testclient import TestClient

from app.contracts import Persona
from app.main import app
from app.store import Store, get_store
from tests.fakes import FakeRedis

PERSONA = json.loads(
    (Path(__file__).parents[2] / "shared" / "examples" / "persona.json").read_text()
)
SECRET = "test-secret-at-least-32-characters-long"


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("LIVEKIT_URL", "wss://example.livekit.cloud")
    monkeypatch.setenv("LIVEKIT_API_KEY", "APItest")
    monkeypatch.setenv("LIVEKIT_API_SECRET", SECRET)
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
    assert s["id"].startswith("s_") and s["status"] == "created" and s["provider"] == "livekit"
    assert s["joinUrl"] == "wss://example.livekit.cloud" and s["interviewGuide"] == ["Q1"]
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


def test_token_is_room_scoped_short_lived_and_dispatches_worker(client):
    sid = new_session(client)["id"]
    res = client.post(f"/api/sessions/{sid}/token")
    assert res.status_code == 200
    assert res.headers["cache-control"] == "no-store"
    body = res.json()
    assert body["provider"] == "livekit" and body["url"] == "wss://example.livekit.cloud"
    assert SECRET not in res.text

    claims = jwt.decode(body["token"], SECRET, algorithms=["HS256"])
    assert claims["iss"] == "APItest" and claims["sub"] == f"interviewer-{sid}"
    assert claims["video"]["room"] == f"opentwin-{sid}" and claims["video"]["roomJoin"] is True
    assert not claims["video"].get("roomAdmin") and not claims["video"].get("roomCreate")
    assert 0 < claims["exp"] - time.time() <= 2 * 3600 + 5
    agents = claims["roomConfig"]["agents"]
    assert len(agents) == 1 and agents[0]["agentName"] == "opentwin-persona"
    assert json.loads(agents[0]["metadata"]) == {"sessionId": sid, "personaId": PERSONA["id"]}


def test_token_refresh_targets_same_room(client):
    sid = new_session(client)["id"]
    rooms = {
        jwt.decode(client.post(f"/api/sessions/{sid}/token").json()["token"], SECRET, ["HS256"])[
            "video"
        ]["room"]
        for _ in range(3)
    }
    assert rooms == {f"opentwin-{sid}"}


def test_no_token_after_end(client):
    sid = new_session(client)["id"]
    client.patch(f"/api/sessions/{sid}", json={"status": "ended"})
    assert client.post(f"/api/sessions/{sid}/token").status_code == 409


def test_missing_livekit_config_is_503(client, monkeypatch):
    sid = new_session(client)["id"]
    monkeypatch.delenv("LIVEKIT_API_SECRET")
    assert client.post(f"/api/sessions/{sid}/token").status_code == 503
