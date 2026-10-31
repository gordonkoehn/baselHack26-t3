import base64
import hashlib
import io

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator
from PIL import Image

from app import rate_limit
from app.contracts import PersonaCreate
from app.extract import ProviderUnavailable
from app.main import app
from app.routers import sources
from app.routers.personas import get_extractor, get_prober
from app.store import get_store
from tests.test_personas import REQUEST, SOURCE, draft, no_probes
from tests.test_sources import fake_transcribe, make_pdf

MCP = "/api/mcp"


@pytest.fixture
def client():
    app.dependency_overrides[get_extractor] = lambda: lambda _req: draft()
    app.dependency_overrides[get_prober] = lambda: no_probes
    yield TestClient(app)
    app.dependency_overrides.pop(get_extractor)
    app.dependency_overrides.pop(get_prober)


def rpc(client, method: str, params: dict | None = None, id_: int = 1):
    return client.post(MCP, json={"jsonrpc": "2.0", "id": id_, "method": method, "params": params})


def call(client, name: str, arguments: dict) -> dict:
    res = rpc(client, "tools/call", {"name": name, "arguments": arguments})
    assert res.status_code == 200
    return res.json()["result"]


def test_handshake_and_tool_list(client):
    res = rpc(client, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {}})
    assert res.json()["result"]["protocolVersion"] == "2025-06-18"
    assert res.json()["result"]["capabilities"] == {"tools": {}}
    # An unknown version gets one we speak, so the client can decide.
    res = rpc(client, "initialize", {"protocolVersion": "1999-01-01"})
    assert res.json()["result"]["protocolVersion"] == "2025-06-18"
    initialized = client.post(MCP, json={"jsonrpc": "2.0", "method": "notifications/initialized"})
    assert initialized.status_code == 202 and initialized.content == b""
    names = [t["name"] for t in rpc(client, "tools/list").json()["result"]["tools"]]
    assert names == ["add_source", "create_persona", "get_persona", "update_persona"]
    assert rpc(client, "ping").json()["result"] == {}


def test_no_event_stream_and_unknown_methods(client):
    assert client.get(MCP).status_code == 405
    assert rpc(client, "resources/list").json()["error"]["code"] == -32601
    res = rpc(client, "tools/call", {"name": "delete_everything", "arguments": {}})
    assert res.json()["error"]["code"] == -32602
    assert client.post(MCP, json=[1, 2]).json()["error"]["code"] == -32600
    res = client.post(MCP, json={"jsonrpc": "2.0", "id": 1, "method": "ping", "params": "x"})
    assert res.json()["error"]["code"] == -32602


def test_create_persona_appears_like_an_uploaded_one(client):
    result = call(client, "create_persona", REQUEST)
    assert result["isError"] is False
    persona = result["structuredContent"]
    assert persona["id"].startswith("p_") and "readiness" in persona
    # Same store and shape as the upload route: the frontend lists and opens it.
    assert client.get(f"/api/personas/{persona['id']}").json() == persona
    assert [p["id"] for p in client.get("/api/personas").json()] == [persona["id"]]
    assert call(client, "get_persona", {"personaId": persona["id"]})["structuredContent"] == persona


def test_create_after_a_delete_builds_a_fresh_persona(client):
    first = call(client, "create_persona", REQUEST)["structuredContent"]
    assert client.delete(f"/api/personas/{first['id']}").status_code == 204

    again = call(client, "create_persona", REQUEST)
    assert again["isError"] is False
    second = again["structuredContent"]
    assert second["id"] != first["id"]
    assert [p["id"] for p in client.get("/api/personas").json()] == [second["id"]]


def test_bad_arguments_are_tool_errors_not_crashes(client):
    result = call(client, "create_persona", {"language": "de", "sources": []})
    assert result["isError"] is True and "invalid arguments" in result["content"][0]["text"]
    result = call(client, "get_persona", {"personaId": "p_missing"})
    assert result == {
        "content": [{"type": "text", "text": "404: persona not found"}],
        "isError": True,
    }


def test_update_persona_relabels_like_the_patch_route(client):
    persona = call(client, "create_persona", REQUEST)["structuredContent"]
    edited = call(
        client,
        "update_persona",
        {"personaId": persona["id"], "changes": {"name": "Anna Test", "pains": []}},
    )["structuredContent"]
    assert edited["name"] == "Anna Test" and edited["pains"] == []
    assert edited["version"] == persona["version"] + 1 and edited["readiness"] is None


def test_add_source_text_pdf_and_image(client, monkeypatch):
    assert call(client, "add_source", {"text": "Notes"})["structuredContent"] == {
        "text": "Notes",
        "pages": 1,
    }
    pdf = base64.b64encode(make_pdf("I want to see the money arrive.")).decode()
    assert "money arrive" in call(client, "add_source", {"data": pdf})["structuredContent"]["text"]

    calls = fake_transcribe(monkeypatch, "Sticky note: too many steps")
    png = base64.b64encode(b"\x89PNG\r\n\x1a\n" + b"\0" * 32).decode()
    assert call(client, "add_source", {"data": png})["structuredContent"]["text"] == (
        "Sticky note: too many steps"
    )
    assert calls == ["image/png"]

    for bad in ({}, {"text": "a", "data": pdf}, {"text": "  "}, {"data": "not base64!"}):
        assert call(client, "add_source", bad)["isError"] is True
    unknown = base64.b64encode(b"hello").decode()
    assert "422" in call(client, "add_source", {"data": unknown})["content"][0]["text"]


def test_tools_share_the_routes_rate_limits(client, monkeypatch):
    monkeypatch.setitem(rate_limit.LIMITS, "personas", (1, 100))
    assert call(client, "create_persona", REQUEST)["isError"] is False
    other = {**REQUEST, "sprintId": "sprint_other"}  # the same arguments would return the first
    res = rpc(client, "tools/call", {"name": "create_persona", "arguments": other})
    assert res.status_code == 429 and res.headers["retry-after"]
    # The route and the tool count in the same bucket.
    assert client.post("/api/personas", json=REQUEST).status_code == 429


def test_passcode_is_the_same_header(client, monkeypatch):
    monkeypatch.setenv("DEMO_PASSCODE", "right")
    assert rpc(client, "tools/list").status_code == 401
    res = client.post(
        MCP,
        json={"jsonrpc": "2.0", "id": 1, "method": "tools/list"},
        headers={"X-Demo-Passcode": "right"},
    )
    assert res.status_code == 200


def test_crafted_ids_never_reach_the_stored_sources(client):
    persona = call(client, "create_persona", REQUEST)["structuredContent"]
    secret = SOURCE[:40]
    for name, args in (
        ("get_persona", {"personaId": f"{persona['id']}:sources"}),
        ("update_persona", {"personaId": f"{persona['id']}:sources", "changes": {"name": "X"}}),
    ):
        result = call(client, name, args)
        assert result["isError"] is True and "personaId" in result["content"][0]["text"]
        assert secret not in str(result)
    # Validation errors name the reason, never echo the input back.
    result = call(client, "create_persona", {"language": "xx", "sources": [{"text": secret}]})
    assert result["isError"] is True and secret not in str(result)


def test_update_needs_changes_and_leaves_the_persona_alone_otherwise(client):
    persona = call(client, "create_persona", REQUEST)["structuredContent"]
    pid = persona["id"]
    for bad in (
        {"personaId": pid, "name": "Misplaced"},
        {"personaId": pid, "changes": {}},
        {"personaId": pid, "changes": {"nmae": "Typo"}},
    ):
        assert call(client, "update_persona", bad)["isError"] is True
    assert call(client, "get_persona", {"personaId": pid})["structuredContent"] == persona


def test_tool_schemas_compile_and_check_nested_facts(client):
    tools = {t["name"]: t for t in rpc(client, "tools/list").json()["result"]["tools"]}
    for tool in tools.values():
        Draft202012Validator.check_schema(tool["inputSchema"])
    update = Draft202012Validator(tools["update_persona"]["inputSchema"])
    fact = {"text": "Wants to see the money arrive", "label": "guess", "evidenceId": None}
    assert update.is_valid({"personaId": "p_1a2b3c", "changes": {"pains": [fact]}})
    assert not update.is_valid({"personaId": "p_1a2b3c", "changes": {"pains": [{"label": 1}]}})
    assert not update.is_valid({"personaId": "p_1:sources", "changes": {"name": "X"}})
    assert not update.is_valid({"personaId": "p_1a2b3c", "changes": {}})


def test_files_count_against_the_sources_limit_and_text_does_not(client, monkeypatch):
    monkeypatch.setitem(rate_limit.LIMITS, "sources", (1, 100))
    pdf = base64.b64encode(make_pdf("I want to see the money arrive.")).decode()
    assert call(client, "add_source", {"text": "Notes"})["isError"] is False
    assert call(client, "add_source", {"data": pdf})["isError"] is False
    res = rpc(client, "tools/call", {"name": "add_source", "arguments": {"data": pdf}})
    assert res.status_code == 429


def test_transparent_images_are_put_on_white_like_the_upload_page(client, monkeypatch):
    sent = []
    monkeypatch.setattr(
        sources.extract, "transcribe", lambda data, mime: sent.append((data, mime)) or "ok"
    )
    png = io.BytesIO()
    Image.new("RGBA", (4096, 64), (0, 0, 0, 0)).save(png, "PNG")
    assert (
        call(client, "add_source", {"data": base64.b64encode(png.getvalue()).decode()})[
            "structuredContent"
        ]["text"]
        == "ok"
    )
    [(data, mime)] = sent
    image = Image.open(io.BytesIO(data))
    assert mime == "image/jpeg" and image.size == (2048, 32)
    assert image.getpixel((0, 0)) == (255, 255, 255)


def test_a_retried_create_returns_the_first_persona(client):
    built = []
    app.dependency_overrides[get_extractor] = lambda: lambda _req: built.append(1) or draft()
    first = call(client, "create_persona", REQUEST)["structuredContent"]
    again = call(client, "create_persona", REQUEST)["structuredContent"]
    assert again == first and len(built) == 1
    assert [p["id"] for p in client.get("/api/personas").json()] == [first["id"]]


def test_a_create_still_running_is_not_started_twice(client):
    store = app.dependency_overrides[get_store]()
    body = PersonaCreate.model_validate(REQUEST).model_dump_json(by_alias=True)
    assert store.claim_creation(hashlib.sha256(body.encode()).hexdigest()) is None
    result = call(client, "create_persona", REQUEST)
    assert result["isError"] is True and "still being built" in result["content"][0]["text"]
    assert client.get("/api/personas").json() == []


def test_a_failed_create_can_be_retried(client):
    def down(_req):
        raise ProviderUnavailable("down")

    app.dependency_overrides[get_extractor] = lambda: down
    assert call(client, "create_persona", REQUEST)["isError"] is True
    app.dependency_overrides[get_extractor] = lambda: lambda _req: draft()
    assert call(client, "create_persona", REQUEST)["isError"] is False
