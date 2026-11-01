import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app import extract
from app.extract import ExtractionFailed, PersonaDraft, ProviderUnavailable
from app.faces import FACES, VOICES, fitting_face
from app.main import app
from app.routers import personas
from app.routers.personas import get_extractor, get_prober
from app.store import PERSONA_LIST_SIZE, Store, get_store
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


def no_probes(_instructions, _question):
    raise ProviderUnavailable("readiness probes are covered in test_readiness.py")


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
    app.dependency_overrides[get_prober] = lambda: no_probes
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


def test_persona_is_not_listed_if_its_sources_could_not_be_saved(client):
    class SourcesFail(FakeRedis):
        def set(self, key, value, ex=None):
            if key.endswith(":sources"):
                raise TimeoutError("interrupted")
            super().set(key, value, ex=ex)

    store = Store(SourcesFail())
    app.dependency_overrides[get_store] = lambda: store
    assert client.post("/api/personas", json=REQUEST).status_code == 503
    assert client.get("/api/personas").json() == []


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


def test_edited_persona_keeps_its_place_and_date_and_comes_back_edited(client):
    first = client.post("/api/personas", json=REQUEST).json()
    client.post("/api/personas", json=REQUEST)
    listed = client.get("/api/personas").json()
    assert listed[1]["id"] == first["id"]

    fact = {"text": "Edited by hand", "label": "guess", "evidenceId": None}
    assert client.patch(f"/api/personas/{first['id']}", json={"jobs": [fact]}).status_code == 200

    assert client.get("/api/personas").json() == listed
    picked = client.get(f"/api/personas/{first['id']}").json()
    assert picked["jobs"] == [fact]
    assert picked["version"] == first["version"] + 1


def test_editing_a_persona_off_the_list_does_not_bring_it_back(client):
    oldest = client.post("/api/personas", json=REQUEST).json()
    for _ in range(PERSONA_LIST_SIZE):
        client.post("/api/personas", json=REQUEST)
    listed = client.get("/api/personas").json()
    assert oldest["id"] not in [p["id"] for p in listed]

    assert client.patch(f"/api/personas/{oldest['id']}", json={"jobs": []}).status_code == 200

    assert client.get("/api/personas").json() == listed
    assert client.get(f"/api/personas/{oldest['id']}").json()["jobs"] == []


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


def test_patch_removes_edits_and_downgrades_facts(client):
    created = client.post("/api/personas", json=REQUEST).json()
    grounded = [f for f in created["pains"] if f["label"] == "grounded"]
    assert grounded, "example persona needs a grounded pain"
    kept = created["pains"][0]  # the other pains are removed
    edited = {**grounded[0], "text": grounded[0]["text"] + " (edited)"}
    invented = {
        "text": "Claims grounded without evidence",
        "label": "grounded",
        "evidenceId": "nope",
    }
    res = client.patch(
        f"/api/personas/{created['id']}",
        json={"pains": [kept, edited, invented], "speechStyle": {"notes": "Short answers."}},
    )
    assert res.status_code == 200
    body = res.json()
    assert body["version"] == created["version"] + 1
    assert body["pains"][0] == kept
    for fact in body["pains"][1:]:
        assert fact["label"] == "guess" and fact["evidenceId"] is None
    assert body["jobs"] == created["jobs"]
    assert body["speechStyle"]["notes"] == "Short answers."
    assert body["speechStyle"].get("register") == created["speechStyle"].get("register")
    # The next interview reads the stored persona, so removed facts are gone for it.
    assert client.get(f"/api/personas/{created['id']}").json() == body


def test_patch_example_and_unknown_persona(client):
    example = json.loads((EXAMPLES / "persona-update.json").read_text())
    created = client.post("/api/personas", json=REQUEST).json()
    assert client.patch(f"/api/personas/{created['id']}", json=example).status_code == 200
    assert client.patch("/api/personas/p_missing", json=example).status_code == 404


def test_patch_identity_and_face(client):
    created = client.post("/api/personas", json=REQUEST).json()
    url = f"/api/personas/{created['id']}"
    res = client.patch(
        url,
        json={
            "name": "Marco Keller",
            "age": None,
            "summary": "New backstory.",
            "context": {"job": "Baker", "toolsToday": ["TWINT"]},
            "faceId": FACES["Victor"][0],
        },
    )
    assert res.status_code == 200, res.text
    body = res.json()
    assert body["name"] == "Marco Keller" and body["age"] is None
    assert body["summary"] == "New backstory." and body["context"]["job"] == "Baker"
    assert body["location"] == created["location"]  # not sent: kept
    assert body["faceId"] == FACES["Victor"][0] and body["voiceId"] == VOICES["m"]
    assert body["jobs"] == created["jobs"] and body["version"] == created["version"] + 1
    # A null name is ignored, an empty one and an unknown face are rejected.
    assert client.patch(url, json={"name": None}).json()["name"] == "Marco Keller"
    assert client.patch(url, json={"name": ""}).status_code == 422
    assert client.patch(url, json={"faceId": "not-a-face"}).status_code == 422


PNG = b"\x89PNG\r\n\x1a\n" + b"\0" * 32


def test_photo_upload_read_replace_and_remove(client):
    created = client.post("/api/personas", json=REQUEST).json()
    url = f"/api/personas/{created['id']}/photo"
    assert client.get(url).status_code == 404
    body = client.put(url, content=PNG).json()
    assert body["photoUrl"].startswith(f"{url}?v=")
    # A picture isn't persona content: no version bump, so coverage checks stay valid.
    assert body["version"] == created["version"]
    assert body["faceId"] == created["faceId"]  # the call keeps its face
    res = client.get(url)
    assert res.status_code == 200 and res.content == PNG
    assert res.headers["content-type"] == "image/png"
    jpeg = b"\xff\xd8\xff" + b"\0" * 32
    replaced = client.put(url, content=jpeg).json()["photoUrl"]
    assert replaced != body["photoUrl"]  # new URL, so the browser doesn't show the cached one
    assert client.get(url).content == jpeg
    removed = client.delete(url).json()
    assert removed["photoUrl"] is None and removed["version"] == created["version"]
    assert client.get(url).status_code == 404


def test_delete_removes_the_persona_from_the_library_with_its_data(client):
    kept = client.post("/api/personas", json=REQUEST).json()
    gone = client.post("/api/personas", json=REQUEST).json()
    client.put(f"/api/personas/{gone['id']}/photo", content=PNG)

    assert client.delete(f"/api/personas/{gone['id']}").status_code == 204

    assert [p["id"] for p in client.get("/api/personas").json()] == [kept["id"]]
    assert client.get(f"/api/personas/{gone['id']}").status_code == 404
    assert client.get(f"/api/personas/{gone['id']}/photo").status_code == 404
    assert client.get(f"/api/personas/{kept['id']}").status_code == 200
    # Twice, or an id that never existed: a plain 404, nothing else changes.
    assert client.delete(f"/api/personas/{gone['id']}").status_code == 404
    assert client.delete("/api/personas/p_unknown").status_code == 404


def test_delete_leaves_no_key_of_the_persona_behind(client):
    redis = app.dependency_overrides[get_store]().redis
    kept = client.post("/api/personas", json=REQUEST).json()
    gone = client.post("/api/personas", json=REQUEST).json()
    client.put(f"/api/personas/{gone['id']}/photo", content=PNG)
    redis.set(f"ot:coverage:{gone['id']}", "{}")  # stands in for a saved coverage check
    assert any(gone["id"] in key for key in redis.data if key != "ot:personas")

    client.delete(f"/api/personas/{gone['id']}")

    assert set(redis.data["ot:personas"]) == {kept["id"]}
    assert [key for key in redis.data if gone["id"] in key] == []
    assert (
        f"ot:persona:{kept['id']}" in redis.data
        and f"ot:persona:{kept['id']}:sources" in redis.data
    )


def test_delete_refuses_ids_that_could_reach_other_keys(client):
    created = client.post("/api/personas", json=REQUEST).json()
    assert client.delete(f"/api/personas/{created['id']}:sources").status_code == 404
    assert client.get(f"/api/personas/{created['id']}").status_code == 200


def test_a_late_save_does_not_bring_a_deleted_persona_back(client):
    """A photo, answers or a Simli face can finish after the persona was deleted; it stays gone."""
    store = app.dependency_overrides[get_store]()
    created = client.post("/api/personas", json=REQUEST).json()
    persona = store.get_persona(created["id"])
    client.delete(f"/api/personas/{created['id']}")

    with pytest.raises(personas.HTTPException) as gone:
        personas._save_edit(store, persona.model_copy(update={"photo_url": "/x"}))

    assert gone.value.status_code == 404
    assert client.get("/api/personas").json() == []
    assert [key for key in store.redis.data if created["id"] in key] == []


def test_delete_needs_the_passcode(client, monkeypatch):
    created = client.post("/api/personas", json=REQUEST).json()
    monkeypatch.setenv("DEMO_PASSCODE", "right")
    assert client.delete(f"/api/personas/{created['id']}").status_code == 401
    assert (
        client.delete(
            f"/api/personas/{created['id']}", headers={"X-Demo-Passcode": "right"}
        ).status_code
        == 204
    )


def test_photo_rejects_other_files(client, monkeypatch):
    created = client.post("/api/personas", json=REQUEST).json()
    url = f"/api/personas/{created['id']}/photo"
    assert client.put(url, content=b"%PDF-1.7").status_code == 422
    assert client.put(url, content=b"GIF89a" + b"\0" * 32).status_code == 422
    monkeypatch.setattr(personas, "MAX_PHOTO_BYTES", 10)
    assert client.put(url, content=PNG).status_code == 413
    assert client.put("/api/personas/p_missing/photo", content=PNG).status_code == 404
    assert client.delete("/api/personas/p_missing/photo").status_code == 404


def test_patch_attitudes_and_speech_style_change_only_what_is_sent(client):
    created = client.post("/api/personas", json=REQUEST).json()
    url = f"/api/personas/{created['id']}"
    body = client.patch(
        url,
        json={
            "attitudes": {"techAffinity": 5},
            "speechStyle": {"register": "formal", "fillers": False},
        },
    ).json()
    assert body["attitudes"] == {**created["attitudes"], "techAffinity": 5}
    assert body["speechStyle"]["register"] == "formal"
    assert body["speechStyle"]["fillers"] is False
    assert body["speechStyle"]["notes"] == created["speechStyle"]["notes"]
    assert body["speechStyle"]["verbosity"] == created["speechStyle"]["verbosity"]
    assert client.patch(url, json={"attitudes": {"techAffinity": 9}}).status_code == 422


def test_faces_have_photos(client):
    faces = client.get("/api/faces").json()
    assert {f["id"] for f in faces} == {f[0] for f in FACES.values()}
    assert all(f["photoUrl"].endswith(f"/{f['id']}.jpg") for f in faces)
    assert {f["gender"] for f in faces} == {"f", "m"}
