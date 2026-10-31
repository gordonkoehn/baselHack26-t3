import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.contracts import Persona
from app.main import app
from app.store import SESSION_LIST_SIZE, Store, get_store
from tests.fakes import FakeRedis

client = TestClient(app)

PAID_ROUTES = [
    "/api/personas",
    "/api/sources/pdf",
    "/api/sources/image",
    "/api/guides/review",
    "/api/sessions/s_1/token",
    "/api/sessions/s_1/avatar-token",
    "/api/sessions/s_1/debrief",
]


@pytest.mark.parametrize("route", PAID_ROUTES)
def test_paid_route_refuses_wrong_passcode(route, monkeypatch):
    monkeypatch.setenv("DEMO_PASSCODE", "right")
    assert client.post(route).status_code == 401
    assert client.post(route, headers={"X-Demo-Passcode": "wrong"}).status_code == 401


@pytest.mark.parametrize("route", PAID_ROUTES)
def test_paid_route_fails_closed_on_vercel_without_passcode(route, monkeypatch):
    monkeypatch.delenv("DEMO_PASSCODE", raising=False)
    monkeypatch.setenv("VERCEL", "1")
    assert client.post(route).status_code == 503


def test_non_ascii_passcodes_are_refused_not_crashed(monkeypatch):
    monkeypatch.setenv("DEMO_PASSCODE", "right")
    assert (
        client.post("/api/sources/pdf", headers={"X-Demo-Passcode": b"caf\xe9"}).status_code == 401
    )
    monkeypatch.setenv("DEMO_PASSCODE", "café")
    assert client.post("/api/sources/pdf", headers={"X-Demo-Passcode": "wrong"}).status_code == 401


def test_right_passcode_passes_the_gate(monkeypatch):
    monkeypatch.setenv("DEMO_PASSCODE", "right")
    response = client.post("/api/sources/pdf", headers={"X-Demo-Passcode": "right"})
    assert response.status_code != 401


def test_local_dev_needs_no_passcode(monkeypatch):
    monkeypatch.delenv("DEMO_PASSCODE", raising=False)
    monkeypatch.delenv("VERCEL", raising=False)
    assert client.post("/api/sources/pdf").status_code != 401


@pytest.mark.parametrize(
    "route", ["/api/sessions/s_1", "/api/personas/p_1", "/api/sessions/s_1/insights"]
)
def test_shared_report_reads_need_no_passcode(route, monkeypatch):
    # A shared /report link opens in a browser that has no passcode: 404 here, not 401.
    monkeypatch.setenv("DEMO_PASSCODE", "right")
    app.dependency_overrides[get_store] = lambda: Store(FakeRedis())
    try:
        assert client.get(route).status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_persona_session_list_needs_the_passcode(monkeypatch):
    # A shared report link reveals the persona id; it must not lead to the other interviews.
    monkeypatch.setenv("DEMO_PASSCODE", "right")
    app.dependency_overrides[get_store] = lambda: Store(FakeRedis())
    route = "/api/personas/p_1/sessions"
    try:
        assert client.get(route).status_code == 401
        assert client.get(route, headers={"X-Demo-Passcode": "wrong"}).status_code == 401
        assert client.get(route, headers={"X-Demo-Passcode": "right"}).status_code == 404
    finally:
        app.dependency_overrides.clear()


def test_health_stays_open(monkeypatch):
    monkeypatch.setenv("DEMO_PASSCODE", "right")
    assert client.get("/api/health").status_code == 200


def test_creating_a_session_needs_the_passcode(monkeypatch):
    # The persona's list keeps the newest sessions only. A persona id from a shared report link must
    # not be enough to push the real interviews out of it.
    monkeypatch.setenv("DEMO_PASSCODE", "right")
    example = Path(__file__).parents[2] / "shared/examples/persona.json"
    persona = Persona.model_validate(json.loads(example.read_text()))
    store = Store(FakeRedis())
    store.save_persona(persona)
    app.dependency_overrides[get_store] = lambda: store
    route, body = "/api/sessions", {"personaId": persona.id}
    team = {"X-Demo-Passcode": "right"}
    try:
        real = client.post(route, json=body, headers=team)
        assert real.status_code == 201
        for _ in range(SESSION_LIST_SIZE):
            assert client.post(route, json=body).status_code == 401
        assert (
            client.post(route, json=body, headers={"X-Demo-Passcode": "wrong"}).status_code == 401
        )
        listed = client.get(f"/api/personas/{persona.id}/sessions", headers=team).json()
        assert [s["id"] for s in listed] == [real.json()["id"]]

        monkeypatch.delenv("DEMO_PASSCODE")
        monkeypatch.setenv("VERCEL", "1")
        assert client.post(route, json=body).status_code == 503
    finally:
        app.dependency_overrides.clear()
