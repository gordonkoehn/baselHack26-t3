import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.contracts import Persona, PersonaCreate, PersonaSource
from app.extract import (
    DEFAULT_CRITERIA,
    AnswersDraft,
    CoverageDraft,
    ExtractionFailed,
    ProviderUnavailable,
)
from app.main import app
from app.routers.personas import get_answerer, get_coverage_checker
from app.store import Store, get_store
from tests.fakes import FakeRedis

EXAMPLES = Path(__file__).parents[2] / "shared" / "examples"
_EXAMPLE = json.loads((EXAMPLES / "persona.json").read_text())
# A second quote, so "covered" can rest on two quotes (one alone counts as thin).
PERSONA = Persona.model_validate(
    {
        **_EXAMPLE,
        "evidence": [
            *_EXAMPLE["evidence"],
            {
                "id": "e2",
                "kind": "transcript",
                "claim": "Pays by phone",
                "quote": "Ich zahle fast alles mit TWINT.",
            },
        ],
    }
)
GOAL = "Dashboard to donate recycling points to a neighbourhood project"
SUPPORT = "Punkte- oder Treueprogramme aktiv nutzen"  # verbatim from quote e1


def row(name, status="covered", weight=2, ids=("e1", "e2"), support=SUPPORT):
    return {
        "name": name,
        "status": status,
        "weight": weight,
        "note": "n",
        "evidenceIds": list(ids),
        "support": support if status == "covered" else "",
    }


def draft(rows, questions=()):
    return CoverageDraft.model_validate({"criteria": rows, "questions": list(questions)})


@pytest.fixture
def client():
    store = Store(FakeRedis())
    store.save_persona(PERSONA)
    app.dependency_overrides[get_store] = lambda: store
    yield TestClient(app)
    app.dependency_overrides.clear()


def use_checker(fn):
    app.dependency_overrides[get_coverage_checker] = lambda: fn


def post(client, **body):
    return client.post(f"/api/personas/{PERSONA.id}/coverage", json={"testGoal": GOAL, **body})


def test_all_covered_is_ready_and_custom_criteria_follow_the_defaults(client):
    seen = {}

    def checker(_persona, _request, names):
        seen["names"] = names
        return draft([row(n) for n in names], ["  ", "Q1"])

    use_checker(checker)
    # A repeat of a default criterion and a duplicate custom one are dropped.
    res = post(client, criteria=["Cares about design", "pains in this area", "cares about design"])
    assert res.status_code == 200, res.text
    body = res.json()
    assert seen["names"] == DEFAULT_CRITERIA + ["Cares about design"]
    assert [c["custom"] for c in body["criteria"]] == [False] * len(DEFAULT_CRITERIA) + [True]
    assert body["score"] == 1.0 and body["recommendation"] == "ready"
    assert body["questions"] == []  # nothing left to fill, so the model's questions are dropped
    assert body["personaVersion"] == PERSONA.version


def test_questions_stay_while_something_that_matters_is_open(client):
    rows = [row(n) for n in DEFAULT_CRITERIA[:-1]]
    rows.append(row(DEFAULT_CRITERIA[-1], status="guessed", weight=2))
    use_checker(lambda *_: draft(rows, ["  ", "Q1"]))
    assert post(client).json()["questions"] == ["Q1"]


def test_a_single_quote_is_thin(client):
    use_checker(lambda *_: draft([row(n, ids=("e1",)) for n in DEFAULT_CRITERIA]))
    body = post(client).json()
    assert {c["status"] for c in body["criteria"]} == {"covered"}
    assert body["score"] == 0.75 and body["recommendation"] == "ready"


@pytest.mark.parametrize(
    "support",
    [
        "spricht Deutsch als Muttersprache",  # not in any cited quote: the model made it up
        "fast alles mit TWINT",  # in a quote, but not one cited for this row
        "nutzen",  # a single word proves nothing
        "",
    ],
)
def test_covered_needs_the_support_words_in_a_cited_quote(client, support):
    use_checker(lambda *_: draft([row(n, ids=("e1",), support=support) for n in DEFAULT_CRITERIA]))
    body = post(client).json()
    assert {c["status"] for c in body["criteria"]} == {"guessed"}


def test_covered_without_real_evidence_becomes_guessed(client):
    rows = [row(n, ids=("e99",)) for n in DEFAULT_CRITERIA]
    use_checker(lambda *_: draft(rows))
    body = post(client).json()
    assert {c["status"] for c in body["criteria"]} == {"guessed"}
    assert all(c["evidenceIds"] == [] for c in body["criteria"])
    assert body["score"] == 0.5 and body["recommendation"] == "needs_input"


def test_score_is_weighted_and_a_missing_must_have_blocks_ready(client):
    # 7 covered at weight 1, one missing at weight 3: 7/10 = 0.7, but the must-have blocks.
    # (Two cited quotes each, so none counts as thin.)
    rows = [row(n, weight=1) for n in DEFAULT_CRITERIA[:-1]]
    rows.append(row(DEFAULT_CRITERIA[-1], status="missing", weight=3, ids=()))
    use_checker(lambda *_: draft(rows))
    body = post(client).json()
    assert body["score"] == 0.7 and body["recommendation"] == "needs_input"


def test_rows_the_model_skipped_count_as_missing_and_weights_are_clamped(client):
    use_checker(lambda *_: draft([row(DEFAULT_CRITERIA[0], weight=9), row("Invented row")]))
    body = post(client).json()
    assert [c["name"] for c in body["criteria"]] == DEFAULT_CRITERIA
    assert body["criteria"][0]["weight"] == 3 and body["criteria"][0]["status"] == "covered"
    assert all(c["status"] == "missing" for c in body["criteria"][1:])


def test_unknown_persona_and_blank_goal(client):
    use_checker(lambda *_: pytest.fail("no provider call expected"))
    assert client.post("/api/personas/nope/coverage", json={"testGoal": GOAL}).status_code == 404
    assert post(client, testGoal="   ").status_code == 422
    assert post(client, testGoal="").status_code == 422


@pytest.mark.parametrize(
    "exc, status", [(ProviderUnavailable("x"), 503), (ExtractionFailed("x"), 502)]
)
def test_provider_failures(client, exc, status):
    def checker(*_):
        raise exc

    use_checker(checker)
    assert post(client).status_code == status


def test_recheck_keeps_weights_and_still_backed_rows(client):
    use_checker(lambda *_: draft([row(n, weight=3) for n in DEFAULT_CRITERIA]))
    assert post(client).json()["score"] == 1.0
    # The model re-rolls: everything "missing" at weight 1. Nothing behind the old rows changed.
    rerolled = [row(n, status="missing", weight=1, ids=()) for n in DEFAULT_CRITERIA]
    use_checker(lambda *_: draft(rerolled))
    body = post(client).json()
    assert body["score"] == 1.0
    assert {c["weight"] for c in body["criteria"]} == {3}
    # A different test goal starts fresh.
    assert post(client, testGoal="Something else").json()["score"] == 0.0


def test_recheck_drops_covered_when_its_evidence_is_gone(client):
    use_checker(lambda *_: draft([row(n) for n in DEFAULT_CRITERIA]))
    post(client)
    store = app.dependency_overrides[get_store]()
    store.save_persona(PERSONA.model_copy(update={"evidence": []}))
    use_checker(lambda *_: draft([row(n, status="missing", ids=()) for n in DEFAULT_CRITERIA]))
    assert post(client).json()["score"] == 0.0


ANSWERS = {
    "answers": [
        {
            "question": "Do they trust donations?",
            "answer": "Only if they see a photo of the finished project.",
        },
        {"question": "Apps?", "answer": "They use TWINT daily."},
    ]
}


def use_answerer(fn):
    app.dependency_overrides[get_answerer] = lambda: fn


def answer_draft(*facts, replaces="", **basics):
    return AnswersDraft.model_validate(
        {
            "facts": [
                {"field": f, "text": t, "quote": q, "replaces": replaces} for f, t, q in facts
            ],
            "age": None,
            "location": "",
            "job": "",
            "household": "",
            **basics,
        }
    )


def test_a_correction_replaces_the_fact_and_updates_the_basics(client):
    old = PERSONA.objections[0]
    use_answerer(
        lambda *_: answer_draft(
            (
                "objections",
                "Gives shares gladly if she sees the project",
                "photo of the finished project",
            ),
            replaces=f"  {old.text} ",  # whitespace from the model is tolerated
            age=55,
            location="Kriens",
            job="",
        )
    )
    body = Persona.model_validate(answer(client).json())
    assert old.text not in [f.text for f in body.objections]
    assert body.objections[-1].label == "grounded"
    assert body.age == 55 and body.location == "Kriens"
    assert body.context.job == PERSONA.context.job  # empty means unchanged
    assert body.pains == PERSONA.pains


def answer(client, body=ANSWERS, persona_id=PERSONA.id):
    return client.post(f"/api/personas/{persona_id}/answers", json=body)


def test_answers_patch_the_same_persona(client):
    store = app.dependency_overrides[get_store]()
    store.save_persona_sources(
        PERSONA.id,
        PersonaCreate(language="de", sources=[PersonaSource(kind="miro", text="guide")]),
    )
    use_answerer(
        lambda *_: answer_draft(
            ("objections", "Needs proof it gets built", "see a photo of the finished project"),
            ("jobs", "Pays with TWINT", "TWINT every day"),  # not verbatim: becomes a guess
            ("pains", PERSONA.pains[0].text, ""),  # already known: skipped
            ("pains", "  ", ""),
        )
    )
    res = answer(client)
    assert res.status_code == 200, res.text
    body = Persona.model_validate(res.json())
    assert body.id == PERSONA.id and body.version == PERSONA.version + 1
    assert body.name == PERSONA.name and body.summary == PERSONA.summary
    new_objection = body.objections[-1]
    assert new_objection.label == "grounded"
    evidence = next(e for e in body.evidence if e.id == new_objection.evidence_id)
    assert evidence.id not in {e.id for e in PERSONA.evidence}
    assert evidence.kind == "note" and evidence.source_ref == "source:2"
    assert body.jobs[-1].text == "Pays with TWINT" and body.jobs[-1].label == "guess"
    assert body.pains == PERSONA.pains
    sources = store.get_persona_sources(PERSONA.id).sources
    assert [s.title for s in sources] == [None, "Answers to gap questions"]
    assert "A: Only if they see a photo" in sources[1].text
    assert store.get_persona(PERSONA.id) == body


def test_quote_from_the_question_is_not_evidence(client):
    use_answerer(lambda *_: answer_draft(("pains", "Distrusts donations", "trust donations")))
    body = answer(client).json()
    assert body["pains"][-1]["label"] == "guess"
    # Without stored sources the answers become source 1.
    sources = app.dependency_overrides[get_store]().get_persona_sources(PERSONA.id).sources
    assert len(sources) == 1


def test_answers_errors(client):
    use_answerer(lambda *_: pytest.fail("no provider call expected"))
    assert answer(client, persona_id="nope").status_code == 404
    assert answer(client, {"answers": [{"question": "Q", "answer": "   "}]}).status_code == 422
    assert answer(client, {"answers": []}).status_code == 422

    def down(*_):
        raise ProviderUnavailable("x")

    use_answerer(down)
    assert answer(client).status_code == 503
