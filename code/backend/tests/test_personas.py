import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import extract
from app.extract import ExtractionFailed, PersonaDraft, ProviderUnavailable
from app.faces import FACES, VOICES, fitting_face
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
    return PersonaDraft.model_validate({**data, "gender": "f", "face": "Sophie", **changes})


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
    # Kept so the live interview knows the product, not only the persona facts.
    saved = app.dependency_overrides[get_store]().get_persona_sources(body["id"])
    assert saved.sources[0].text == REQUEST["sources"][0]["text"]


def test_list_shows_created_personas_without_their_facts(client):
    assert client.get("/api/personas").json() == []
    first = client.post("/api/personas", json=REQUEST).json()
    second = client.post("/api/personas", json=REQUEST).json()
    res = client.get("/api/personas")
    assert res.status_code == 200
    assert [p["id"] for p in res.json()] == [second["id"], first["id"]]
    assert set(res.json()[0]) == {"id", "name", "role", "createdAt", "readiness"}
    assert res.json()[0]["role"] == EXAMPLE["context"]["job"]
    # What the library picks: the full persona comes from the id alone, no re-extraction.
    use_extractor(lambda _req: pytest.fail("reuse must not extract"))
    assert client.get(f"/api/personas/{first['id']}").json() == first


def test_list_needs_the_passcode(client, monkeypatch):
    client.post("/api/personas", json=REQUEST)
    monkeypatch.setenv("DEMO_PASSCODE", "right")
    assert client.get("/api/personas").status_code == 401
    assert client.get("/api/personas", headers={"X-Demo-Passcode": "wrong"}).status_code == 401
    res = client.get("/api/personas", headers={"X-Demo-Passcode": "right"})
    assert res.status_code == 200 and len(res.json()) == 1


def test_list_fails_closed_on_vercel_without_passcode(client, monkeypatch):
    monkeypatch.delenv("DEMO_PASSCODE", raising=False)
    monkeypatch.setenv("VERCEL", "1")
    assert client.get("/api/personas").status_code == 503


def test_face_and_voice_follow_the_chosen_face(client):
    use_extractor(lambda _req: draft(name="Marco Keller", gender="m", face="Victor"))
    body = client.post("/api/personas", json=REQUEST).json()
    assert body["faceId"] == "3bad681f-1b4a-4507-bc54-fbc675c191b7"
    assert body["voiceId"] == "cedar"
    assert "face" not in body


def test_face_of_the_wrong_gender_is_replaced(client):
    # Seen live: "Claudia Meier" got Lukas, a man's face and voice.
    use_extractor(lambda _req: draft(name="Claudia Meier", gender="f", age=41, face="Lukas"))
    body = client.post("/api/personas", json=REQUEST).json()
    face = next(n for n, f in FACES.items() if f[0] == body["faceId"])
    assert FACES[face][1] == "f" and face == "Claire"  # the woman closest to 41 (~45)
    assert body["voiceId"] == VOICES["f"]


def test_fitting_face_keeps_a_matching_choice_and_uses_face_age_without_age():
    assert fitting_face("Victor", "m", 30) == "Victor"
    assert fitting_face("Margaret", "m", None) == "Victor"  # ~70 -> oldest man, ~55


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
    """Whitespace may differ in both source and quote; the evidence must still be kept."""
    spaced_source = SOURCE.replace(". Mind.", ".\n\n   Mind.")
    spaced_quote = EXAMPLE["evidence"][0]["quote"].replace(" Mind.", "\n  Mind.")
    use_extractor(lambda _req: draft(evidence=[{**EXAMPLE["evidence"][0], "quote": spaced_quote}]))
    req = {**REQUEST, "sources": [{"kind": "miro", "text": spaced_source}]}
    body = client.post("/api/personas", json=req).json()
    assert [(e["id"], e["kind"], e["sourceRef"]) for e in body["evidence"]] == [
        ("e1", "miro", "source:1")
    ]
    assert len(grounded_texts(body)) == 2


@pytest.mark.parametrize("evidence_id", ["e404", None])
def test_grounded_fact_without_evidence_becomes_guess(client, evidence_id):
    jobs = [{"text": "x", "label": "grounded", "evidenceId": evidence_id}]
    use_extractor(lambda _req: draft(jobs=jobs))
    body = client.post("/api/personas", json=REQUEST).json()
    assert body["jobs"] == [{"text": "x", "label": "guess", "evidenceId": None}]


def test_guess_never_carries_evidence(client):
    pains = [{"text": "x", "label": "guess", "evidenceId": "e1"}]
    use_extractor(lambda _req: draft(pains=pains))
    body = client.post("/api/personas", json=REQUEST).json()
    assert body["pains"] == [{"text": "x", "label": "guess", "evidenceId": None}]


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


def test_downgrade_reaches_every_fact_list(client):
    """No grounded fact may keep an evidenceId whose evidence was dropped, in any list."""
    fact = {"text": "x", "label": "grounded", "evidenceId": "e1"}
    bad = [{**EXAMPLE["evidence"][0], "quote": "Paraphrased, not in the source."}]
    use_extractor(lambda _req: draft(evidence=bad, jobs=[fact], pains=[fact], objections=[fact]))
    body = client.post("/api/personas", json=REQUEST).json()
    for name in ("jobs", "pains", "objections"):
        assert body[name] == [{"text": "x", "label": "guess", "evidenceId": None}]


TWO_SOURCES = {
    "language": "en",
    "sources": [
        {"kind": "note", "text": "Unrelated sprint note."},
        {"kind": "miro", "text": "Board. The neighbourhood project matters to me. End."},
    ],
}


def test_evidence_attribution_comes_from_matching_source(client):
    """The model claims real_interview / source:1; the quote is really in source 2 (miro)."""
    lie = {
        "id": "e1",
        "kind": "real_interview",
        "claim": "c",
        "quote": "The neighbourhood project matters to me.",
        "sourceRef": "source:1",
    }
    use_extractor(lambda _req: draft(evidence=[lie]))
    body = client.post("/api/personas", json=TWO_SOURCES).json()
    assert body["evidence"][0]["kind"] == "miro"
    assert body["evidence"][0]["sourceRef"] == "source:2"
    assert len(grounded_texts(body)) == 2


def test_matching_attribution_is_kept(client):
    body = client.post("/api/personas", json=REQUEST).json()
    assert body["evidence"][0]["kind"] == "miro"
    assert body["evidence"][0]["sourceRef"] == "source:1"


@pytest.mark.parametrize(("code", "status"), [(404, 503), (422, 502)])
def test_openai_status_errors_reach_endpoint_controlled(client, monkeypatch, code, status):
    import httpx
    import openai

    cls = {404: openai.NotFoundError, 422: openai.UnprocessableEntityError}[code]
    req = httpx.Request("POST", "https://api.openai.com/v1/responses")

    class Failing:
        def parse(self, **_kwargs):
            raise cls("boom", response=httpx.Response(code, request=req), body=None)

    monkeypatch.setattr(extract, "_client", lambda: type("C", (), {"responses": Failing()})())
    app.dependency_overrides.pop(get_extractor)
    assert client.post("/api/personas", json=REQUEST).status_code == status


def test_sparse_draft_omits_null_optional_fields(client):
    """schema.json allows attitudes/speechStyle fields to be absent, not null."""
    sparse = draft(attitudes={}, speechStyle={"notes": None})
    use_extractor(lambda _req: sparse)
    created = client.post("/api/personas", json=REQUEST).json()
    for body in (created, client.get(f"/api/personas/{created['id']}").json()):
        assert body["attitudes"] == {}
        assert body["speechStyle"] == {"notes": None}
        assert all("evidenceId" in f for f in body["jobs"])
