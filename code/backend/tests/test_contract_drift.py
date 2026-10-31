"""Check the public wire format against the source-of-truth Draft 2020-12 schema."""

import json
from copy import deepcopy
from pathlib import Path

import pytest
from fastapi.testclient import TestClient
from jsonschema import Draft202012Validator, ValidationError
from pydantic import Field, create_model

from app import avatar, realtime
from app.contracts import (
    CoverageReport,
    InsightReport,
    Persona,
    PersonaUpdate,
    Session,
    SessionEvent,
    SessionToken,
)
from app.extract import DebriefDraft, PersonaDraft
from app.main import app
from app.routers.insights import get_debriefer
from app.routers.personas import get_extractor
from app.store import Store, get_store
from tests.fakes import FakeRedis

SHARED = Path(__file__).parents[2] / "shared"
SCHEMA = json.loads((SHARED / "schema.json").read_text())
# Explicit coverage: adding or renaming a file requires choosing its contract here.
EXAMPLES = {
    "persona.json": ("Persona", Persona, False),
    "persona-update.json": ("PersonaUpdate", PersonaUpdate, False),
    "session.json": ("Session", Session, False),
    "session-events.json": ("SessionEvent", SessionEvent, True),
    "insight-report.json": ("InsightReport", InsightReport, False),
    "coverage-report.json": ("CoverageReport", CoverageReport, False),
}


def load(name):
    return json.loads((SHARED / "examples" / name).read_text())


def validator(definition, *, array=False, schema=SCHEMA):
    target = {"$ref": f"#/$defs/{definition}"}
    if array:
        target = {"type": "array", "items": target}
    return Draft202012Validator(
        {"$schema": schema["$schema"], "$defs": schema["$defs"], **target},
    )


def test_schema_and_example_coverage():
    assert SCHEMA["$schema"] == "https://json-schema.org/draft/2020-12/schema"
    Draft202012Validator.check_schema(SCHEMA)
    files = {
        p.relative_to(SHARED / "examples").as_posix()
        for p in (SHARED / "examples").rglob("*")
        if p.is_file()
    }
    assert files == EXAMPLES.keys(), "Every example needs an explicit definition mapping"


@pytest.mark.parametrize("filename", EXAMPLES)
def test_examples_and_pydantic_serialization_match_schema(filename):
    definition, model, array = EXAMPLES[filename]
    body = load(filename)
    check = validator(definition, array=array)
    check.validate(body)
    # Validate the serialized models too: a Pydantic-only alias/field rename must fail.
    if array:
        serialized = [
            model.model_validate(item).model_dump(mode="json", by_alias=True, exclude_unset=True)
            for item in body
        ]
    else:
        serialized = model.model_validate(body).model_dump(
            mode="json", by_alias=True, exclude_unset=True
        )
    check.validate(serialized)
    assert serialized == body, "Pydantic must preserve even optional fields present in examples"


@pytest.fixture
def client(monkeypatch):
    store = Store(FakeRedis())
    monkeypatch.setitem(app.dependency_overrides, get_store, lambda: store)
    with TestClient(app) as client:
        yield client


def response(response, definition, *, status=200, array=False):
    assert response.status_code == status, response.text
    body = response.json()
    validator(definition, array=array).validate(body)
    return body


@pytest.mark.parametrize("sparse", [False, True])
def test_persona_session_event_and_insight_responses(client, monkeypatch, sparse):
    persona = load("persona.json")
    draft = PersonaDraft.model_validate({**persona, "gender": "f", "face": "Sophie"})
    if sparse:
        draft = draft.model_copy(
            update={
                "attitudes": draft.attitudes.__class__(),
                "speech_style": draft.speech_style.__class__(),
            }
        )
    monkeypatch.setitem(app.dependency_overrides, get_extractor, lambda: lambda _request: draft)
    created = response(
        client.post(
            "/api/personas",
            json={
                "language": persona["language"],
                "sources": [{"kind": "note", "text": persona["evidence"][0]["quote"]}],
            },
        ),
        "Persona",
        status=201,
    )
    response(client.get(f"/api/personas/{created['id']}"), "Persona")
    guide = load("session.json")["interviewGuide"]
    session = response(
        client.post(
            "/api/sessions",
            json={
                "personaId": created["id"],
                "interviewGuide": guide,
            },
        ),
        "Session",
        status=201,
    )
    url = f"/api/sessions/{session['id']}"
    response(client.get(url), "Session")
    response(client.patch(url, json={"status": "live"}), "Session")

    # Mock the provider boundary; the router and FastAPI serialization remain real.
    for suffix, provider, module, method in [
        ("token", "openai-realtime", realtime, "mint_client_secret"),
        ("avatar-token", "simli", avatar, "mint_session_token"),
    ]:
        token = SessionToken(
            provider=provider, token="test-only", expires_at="2026-10-31T15:00:00Z"
        )
        monkeypatch.setattr(module, method, lambda *_args, token=token: token)
        response(client.post(f"{url}/{suffix}"), "SessionToken")

    events = [{**event, "sessionId": session["id"]} for event in load("session-events.json")]
    accepted = client.post(f"{url}/events", json=events)
    assert accepted.status_code == 200
    # This inline response has no $defs entry in schema.json.
    assert SCHEMA["endpoints"]["POST /api/sessions/{id}/events"]["response"] == {
        "accepted": "integer"
    }
    assert accepted.json() == {"accepted": len(events)}
    polled = response(client.get(f"{url}/events"), "SessionEvent", array=True)
    assert polled == events
    assert response(client.get(f"{url}/events?after=5"), "SessionEvent", array=True) == events[5:]
    response(client.patch(url, json={"status": "ended"}), "Session")

    questions = load("insight-report.json")["questions"]
    questions.reverse()
    questions.append({"question": guide[2], "signal": "unclear", "insights": [], "followUps": []})
    debrief = DebriefDraft.model_validate({"questions": questions})
    monkeypatch.setitem(app.dependency_overrides, get_debriefer, lambda: lambda *_args: debrief)
    report = response(client.post(f"{url}/debrief"), "InsightReport")
    assert any(q["insights"] for q in report["questions"]), "Exercise nested insight contracts"
    assert response(client.get(f"{url}/insights"), "InsightReport") == report


@pytest.mark.parametrize("change", ["required", "type"])
def test_schema_only_drift_is_rejected(change):
    schema = deepcopy(SCHEMA)
    if change == "required":
        schema["$defs"]["Persona"]["required"].append("newRequiredField")
    else:
        schema["$defs"]["Persona"]["properties"]["name"] = {"type": "integer"}
    with pytest.raises(ValidationError):
        validator("Persona", schema=schema).validate(load("persona.json"))


def test_pydantic_only_serialization_rename_is_rejected():
    renamed = create_model(
        "RenamedPersona",
        __base__=Persona,
        summary=(str, Field(serialization_alias="biography")),
    )
    body = renamed.model_validate(load("persona.json")).model_dump(mode="json", by_alias=True)
    with pytest.raises(ValidationError, match="summary"):
        validator("Persona").validate(body)


@pytest.mark.parametrize("change", ["required", "type", "conditional"])
def test_response_field_drift_is_rejected(change):
    body = SessionEvent.model_validate(load("session-events.json")[1]).model_dump(by_alias=True)
    if change == "required":
        body["session_id"] = body.pop("sessionId")
    elif change == "type":
        body["seq"] = "2"
    else:
        body["data"].pop("speaker")
    with pytest.raises(ValidationError):
        validator("SessionEvent").validate(body)
