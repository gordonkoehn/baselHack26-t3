import pytest
from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)

PAID_ROUTES = [
    "/api/personas",
    "/api/sources/pdf",
    "/api/sources/image",
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


def test_health_stays_open(monkeypatch):
    monkeypatch.setenv("DEMO_PASSCODE", "right")
    assert client.get("/api/health").status_code == 200
