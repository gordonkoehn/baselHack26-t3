import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import extract
from app.extract import ExtractionFailed, PersonaDraft, ProviderUnavailable
from app.main import app
from app.routers.personas import get_extractor
from app.store import Store, get_store
from tests.fakes import FakeRedis

EXAMPLES = Path(__file__).parents[2] / "shared" / "examples"
EXAMPLE = json.loads((EXAMPLES / "persona.json").read_text())
SOURCE = (
    "Leitfaden Quartier-Börse. Zielgruppe: Doppelverdiener-Haushalte. "
    "Mind. 2 Personen, die heute Punkte- oder Treueprogramme aktiv nutzen."
)
REQUEST = {
    "language": "de",
    "sprintId": "sprint_quartier_boerse",
    "sources": [{"kind": "miro", "title": "Leitfaden", "text": SOURCE}],
}


def draft(**changes) -> PersonaDraft:
    data = {
        k: v for k, v in EXAMPLE.items() if k in PersonaDraft.model_fields or k == "speechStyle"
    }
    return PersonaDraft.model_validate({**data, **changes})


@pytest.fixture
def client():
    store = Store(FakeRedis())
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_extractor] = lambda: lambda _req: draft()
    yield TestClient(app)
    app.dependency_overrides.clear()


def use_extractor(fn):
    app.dependency_overrides[get_extractor] = lambda: fn


def test_create_then_read(client):
    res = client.post("/api/personas", json=REQUEST)
    assert res.status_code == 201
    body = res.json()
    assert body["id"].startswith("p_") and body["version"] == 1
    assert body["cloned"] is False and body["readiness"] is None
    assert body["voiceId"] and body["faceId"]
    assert body["sprintId"] == "sprint_quartier_boerse"
    assert client.get(f"/api/personas/{body['id']}").json() == body


def test_unknown_persona_404(client):
    assert client.get("/api/personas/p_nope").status_code == 404


@pytest.mark.parametrize(
    "payload",
    [
        {"language": "de", "sources": []},
        {"language": "de", "sources": [{"kind": "note", "text": "   "}]},
        {"language": "fr", "sources": [{"kind": "note", "text": "x"}]},
    ],
)
def test_invalid_input_422(client, payload):
    assert client.post("/api/personas", json=payload).status_code == 422


def grounded_texts(body):
    return [
        f["text"]
        for f in body["jobs"] + body["pains"] + body["objections"]
        if f["label"] == "grounded"
    ]


def test_unverified_quote_drops_evidence_and_downgrades_facts(client):
    bad = [{**EXAMPLE["evidence"][0], "quote": "Something nobody said."}]
    use_extractor(lambda _req: draft(evidence=bad))
    res = client.post("/api/personas", json=REQUEST)
    assert res.status_code == 201
    body = res.json()
    assert body["evidence"] == [] and grounded_texts(body) == []
    assert "Something" not in res.text


def test_verified_quote_keeps_grounding(client):
    body = client.post("/api/personas", json=REQUEST).json()
    assert [e["id"] for e in body["evidence"]] == ["e1"]
    assert len(grounded_texts(body)) == 2


def test_quote_match_ignores_whitespace(client):
    spaced = SOURCE.replace(". Mind.", ".\n\n   Mind.")
    req = {**REQUEST, "sources": [{"kind": "miro", "text": spaced}]}
    assert client.post("/api/personas", json=req).status_code == 201


def test_grounded_fact_needs_existing_evidence(client):
    jobs = [{"text": "x", "label": "grounded", "evidenceId": "e404"}]
    use_extractor(lambda _req: draft(jobs=jobs))
    assert client.post("/api/personas", json=REQUEST).status_code == 502


def test_guess_must_not_cite_evidence(client):
    pains = [{"text": "x", "label": "guess", "evidenceId": "e1"}]
    use_extractor(lambda _req: draft(pains=pains))
    assert client.post("/api/personas", json=REQUEST).status_code == 502


def test_duplicate_evidence_ids_rejected(client):
    use_extractor(lambda _req: draft(evidence=EXAMPLE["evidence"] * 2))
    assert client.post("/api/personas", json=REQUEST).status_code == 502


@pytest.mark.parametrize(
    ("error", "status"),
    [(ProviderUnavailable("timeout"), 503), (ExtractionFailed("refused"), 502)],
)
def test_provider_failures(client, error, status):
    def fail(_req):
        raise error

    use_extractor(fail)
    assert client.post("/api/personas", json=REQUEST).status_code == status


def test_real_extractor_without_key_is_503(client, monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    extract._client.cache_clear()
    app.dependency_overrides.pop(get_extractor)
    assert client.post("/api/personas", json=REQUEST).status_code == 503


def test_store_down_503(client, monkeypatch):
    monkeypatch.delenv("UPSTASH_REDIS_REST_URL", raising=False)
    monkeypatch.delenv("UPSTASH_REDIS_REST_TOKEN", raising=False)
    app.dependency_overrides.pop(get_store)
    get_store.cache_clear()
    assert client.get("/api/personas/p_x").status_code == 503


@pytest.mark.parametrize("quote", [None, "", "  \n\t "])
def test_blank_quote_is_never_grounding(client, quote):
    bad = [{**EXAMPLE["evidence"][0], "quote": quote}]
    use_extractor(lambda _req: draft(evidence=bad))
    body = client.post("/api/personas", json=REQUEST).json()
    assert body["evidence"] == [] and grounded_texts(body) == []
