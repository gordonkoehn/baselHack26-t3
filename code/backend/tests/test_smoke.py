import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.contracts import InsightReport, Persona, PersonaSummary, Session, SessionEvent
from app.main import app

client = TestClient(app)
EXAMPLES = Path(__file__).parents[2] / "shared" / "examples"


def load(name: str):
    return json.loads((EXAMPLES / name).read_text())


def test_health():
    assert client.get("/api/health").json() == {"status": "ok"}


def test_examples_match_contracts():
    Persona.model_validate(load("persona.json"))
    Session.model_validate(load("session.json"))
    InsightReport.model_validate(load("insight-report.json"))
    for summary in load("persona-summaries.json"):
        PersonaSummary.model_validate(summary)
    for event in load("session-events.json"):
        SessionEvent.model_validate(event)


def test_contracts_dump_camel_case():
    persona = Persona.model_validate(load("persona.json"))
    assert persona.model_dump(by_alias=True, exclude_unset=True) == load("persona.json")


def test_grounded_facts_point_to_evidence():
    persona = Persona.model_validate(load("persona.json"))
    ids = {e.id for e in persona.evidence}
    for fact in persona.jobs + persona.pains + persona.objections:
        assert (fact.label == "grounded") == (fact.evidence_id in ids)
