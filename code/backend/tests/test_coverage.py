import json
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.contracts import Persona, PersonaCreate, PersonaSource
from app.extract import (
    CATEGORY_CRITERIA,
    DEFAULT_CRITERIA,
    AnswersDraft,
    CoverageDraft,
    ExtractionFailed,
    ProviderUnavailable,
)
from app.main import app
from app.routers.personas import get_answerer, get_coverage_checker, level_for
from app.store import PREFIX, Store, get_store
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

    def checker(_persona, _request, names, _sources):
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
    # 14 covered at weight 1, one missing at weight 3: 14/17 = 0.82, but the must-have blocks.
    # (Two cited quotes each, so none counts as thin.)
    rows = [row(n, weight=1) for n in DEFAULT_CRITERIA[:-1]]
    rows.append(row(DEFAULT_CRITERIA[-1], status="missing", weight=3, ids=()))
    use_checker(lambda *_: draft(rows))
    body = post(client).json()
    assert body["score"] == 0.82 and body["recommendation"] == "needs_input"


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


def bump_version(**changes):
    """The persona as answers leave it: a newer version, the report kept."""
    store = app.dependency_overrides[get_store]()
    persona = store.get_persona(PERSONA.id)
    store.update_persona(persona.model_copy(update={"version": persona.version + 1, **changes}))
    return store


def test_recheck_keeps_weights_and_still_backed_rows(client):
    use_checker(lambda *_: draft([row(n, weight=3) for n in DEFAULT_CRITERIA]))
    assert post(client).json()["score"] == 1.0
    bump_version()
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
    bump_version(evidence=[])
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


def rows_for(category, covered, status="missing"):
    """The first `covered` criteria of a category covered, the rest with `status`."""
    names = CATEGORY_CRITERIA[category]
    return [row(n) if i < covered else row(n, status=status, ids=()) for i, n in enumerate(names)]


def category(body, name):
    return next(c for c in body["categories"] if c["category"] == name)


def with_sources(client, *sources):
    store = app.dependency_overrides[get_store]()
    store.save_persona_sources(
        PERSONA.id,
        PersonaCreate(language="de", sources=[PersonaSource(**s) for s in sources]),
    )


NOTE = {
    "kind": "note",
    "title": "Guide",
    "text": "Schritt eins: der Kunde bucht die Abholung online.",
}
TRANSCRIPT = {"kind": "transcript", "title": "Call", "text": "Ich zahle fast alles mit TWINT."}


@pytest.mark.parametrize(
    ("share", "level"),
    [
        (1.0, "green"),
        (0.7, "green"),
        (0.69, "yellow"),
        (0.4, "yellow"),
        (0.39, "red"),
        (0.0, "red"),
    ],
)
def test_level_thresholds(share, level):
    assert level_for(share) == level


def test_every_default_criterion_has_exactly_one_category():
    mapped = [n for names in CATEGORY_CRITERIA.values() for n in names]
    assert sorted(mapped) == sorted(DEFAULT_CRITERIA)
    assert len(set(mapped)) == len(mapped)
    assert list(CATEGORY_CRITERIA) == ["persona", "challenge", "solution"]
    # A single row would make a category jump from red to green.
    assert all(len(names) >= 4 for names in CATEGORY_CRITERIA.values())


def test_categories_are_computed_from_the_covered_share(client):
    with_sources(client, NOTE, TRANSCRIPT)
    rows = rows_for("persona", 5) + rows_for("challenge", 2, "guessed") + rows_for("solution", 1)
    use_checker(lambda *_: draft(rows))
    body = post(client).json()

    assert [c["category"] for c in body["categories"]] == ["persona", "challenge", "solution"]
    persona, challenge, solution = body["categories"]
    assert (persona["level"], persona["score"], persona["covered"], persona["total"]) == (
        "green",
        0.71,
        5,
        7,
    )
    assert persona["recommendation"] is None
    assert (challenge["level"], challenge["score"]) == ("yellow", 0.5)
    assert challenge["recommendation"].startswith("Add a source that covers: ")
    assert (solution["level"], solution["score"]) == ("red", 0.25)
    assert solution["recommendation"]
    assert body["overall"] == "add_more"


def test_a_row_the_quote_check_downgrades_does_not_count_as_covered(client):
    """The model says covered, the quote isn't there: the level follows the check, not the model."""
    rows = [row(n, support="steht so nirgends") for n in CATEGORY_CRITERIA["solution"]]
    use_checker(lambda *_: draft(rows))
    assert category(post(client).json(), "solution")["level"] == "red"


def test_custom_criteria_do_not_move_a_category(client):
    rows = rows_for("solution", 3) + [row("Cares about design", status="missing", ids=())]
    use_checker(lambda *_: draft(rows))
    solution = category(post(client, criteria=["Cares about design"]).json(), "solution")
    assert (solution["covered"], solution["total"], solution["level"]) == (3, 4, "green")


def test_the_reason_stays_one_short_sentence(client):
    use_checker(lambda *_: draft([]))
    reason = category(post(client).json(), "persona")["reason"]
    assert reason.count(".") == 1 and reason.endswith("and 5 more.")


def test_the_recommendation_names_the_gap_that_matters_most(client):
    names = CATEGORY_CRITERIA["challenge"]
    rows = [
        row(names[0], status="guessed", weight=1, ids=()),
        row(names[1], status="missing", weight=3, ids=()),
    ]
    use_checker(lambda *_: draft(rows))
    assert names[1].lower() in category(post(client).json(), "challenge")["recommendation"]


def test_challenge_and_solution_may_cite_a_source_but_the_person_may_not(client):
    with_sources(client, NOTE, TRANSCRIPT)
    support = "der Kunde bucht die Abholung online"
    rows = [
        row(CATEGORY_CRITERIA["solution"][0], ids=("source:1",), support=support),
        row(CATEGORY_CRITERIA["challenge"][1], ids=("source:1",), support=support),
        row(CATEGORY_CRITERIA["persona"][0], ids=("source:1",), support=support),
    ]
    use_checker(lambda *_: draft(rows))
    criteria = {c["name"]: c for c in post(client).json()["criteria"]}
    assert criteria[rows[0]["name"]]["status"] == "covered"
    assert criteria[rows[0]["name"]]["evidenceIds"] == ["source:1"]
    assert criteria[rows[1]["name"]]["status"] == "covered"
    assert criteria[rows[2]["name"]]["status"] == "guessed"


@pytest.mark.parametrize("support", ["of the", "the project of the neighbours"])
def test_a_few_words_of_an_off_topic_source_cover_nothing(client, support):
    passage = "The weather in the city was fine and the project of the neighbours ran late."
    with_sources(client, {"kind": "note", "title": "Other", "text": passage})
    names = CATEGORY_CRITERIA["challenge"] + CATEGORY_CRITERIA["solution"]
    use_checker(lambda *_: draft([row(n, ids=("source:1",), support=support) for n in names]))
    body = post(client).json()
    assert category(body, "challenge")["covered"] == 0
    assert category(body, "solution")["level"] == "red"


def test_the_longer_rule_is_only_for_sources(client):
    rows = [row(n, ids=("e1",), support="Treueprogramme aktiv") for n in DEFAULT_CRITERIA]
    use_checker(lambda *_: draft(rows))
    assert {c["status"] for c in post(client).json()["criteria"]} == {"covered"}


def gap_answers(client, *pairs):
    use_answerer(lambda *_: answer_draft())
    body = {"answers": [{"question": q, "answer": a} for q, a in pairs]}
    assert answer(client, body).status_code == 200


def test_answers_are_not_another_source(client):
    with_sources(client, NOTE)
    gap_answers(client, ("Who is involved and who decides?", "No idea."))
    use_checker(lambda *_: draft([]))
    assert post(client).json()["sourceDiversity"] == {
        "count": 1,
        "kinds": ["note"],
        "minimum": 2,
        "met": False,
    }


def test_the_question_in_the_answers_note_is_not_a_passage(client):
    with_sources(client, NOTE)
    question = "Who is involved and who decides in this household every week?"
    gap_answers(client, (question, "No idea."))
    name = "Who is involved and who decides"
    use_checker(lambda *_: draft([row(name, ids=("source:2",), support=question)]))
    criteria = {c["name"]: c for c in post(client).json()["criteria"]}
    assert criteria[name]["status"] == "guessed"


def test_an_answer_in_the_answers_note_is_a_passage(client):
    with_sources(client, NOTE)
    said = "the landlord signs off every change to the pickup"
    gap_answers(client, ("Who?", f"First line.\n\nThen {said}."), ("Other?", "Nothing else."))
    name = "Who is involved and who decides"
    use_checker(lambda *_: draft([row(name, ids=("source:2",), support=said)]))
    criteria = {c["name"]: c for c in post(client).json()["criteria"]}
    assert criteria[name]["status"] == "covered"


def test_an_edit_lets_a_recheck_lower_the_levels(client):
    with_sources(client, NOTE, TRANSCRIPT)
    use_checker(lambda *_: draft([row(n) for n in DEFAULT_CRITERIA]))
    assert post(client).json()["overall"] == "good_enough"
    edit = {"jobs": [], "pains": [], "objections": []}
    assert client.patch(f"/api/personas/{PERSONA.id}", json=edit).status_code == 200
    use_checker(lambda *_: draft([row(n, status="missing", ids=()) for n in DEFAULT_CRITERIA]))
    body = post(client).json()
    assert {c["level"] for c in body["categories"]} == {"red"}
    assert body["overall"] == "add_more" and body["recommendation"] == "needs_input"


def test_a_new_face_keeps_the_floor(client):
    use_checker(lambda *_: draft([row(n) for n in DEFAULT_CRITERIA]))
    post(client)
    face = client.get("/api/faces").json()[0]["id"]
    assert client.patch(f"/api/personas/{PERSONA.id}", json={"faceId": face}).status_code == 200
    use_checker(lambda *_: draft([row(n, status="missing", ids=()) for n in DEFAULT_CRITERIA]))
    assert post(client).json()["score"] == 1.0


def test_the_checker_gets_the_stored_sources(client):
    with_sources(client, NOTE)
    seen = {}

    def checker(_persona, _request, _names, sources):
        seen["sources"] = sources
        return draft([])

    use_checker(checker)
    post(client)
    assert [s.title for s in seen["sources"]] == ["Guide"]


def test_source_diversity_counts_distinct_sources_and_kinds(client):
    with_sources(client, NOTE, {**NOTE, "text": "  " + NOTE["text"].upper()}, TRANSCRIPT)
    use_checker(lambda *_: draft([]))
    assert post(client).json()["sourceDiversity"] == {
        "count": 2,
        "kinds": ["note", "transcript"],
        "minimum": 2,
        "met": True,
    }


def test_too_few_sources_is_add_more_even_when_all_is_green(client):
    with_sources(client, NOTE)
    use_checker(lambda *_: draft([row(n) for n in DEFAULT_CRITERIA]))
    body = post(client).json()
    assert {c["level"] for c in body["categories"]} == {"green"}
    assert body["sourceDiversity"]["met"] is False
    assert body["overall"] == "add_more"


def test_ready_no_red_and_enough_sources_is_good_enough(client):
    with_sources(client, NOTE, TRANSCRIPT)
    rows = rows_for("persona", 5) + rows_for("challenge", 3) + rows_for("solution", 3)
    rows = [{**r, "weight": 1} if r["status"] == "missing" else r for r in rows]
    use_checker(lambda *_: draft(rows))
    body = post(client).json()
    assert body["recommendation"] == "ready" and body["overall"] == "good_enough"


@pytest.mark.parametrize(
    "missing",
    [
        ["What the solution is"],  # a weight-3 gap blocks "ready" even in a green category
        ["What the solution is", "Current process steps"],
    ],
)
def test_good_enough_never_contradicts_the_recommendation(client, missing):
    with_sources(client, NOTE, TRANSCRIPT)
    rows = [
        row(n, status="missing", weight=3, ids=()) if n in missing else row(n)
        for n in DEFAULT_CRITERIA
    ]
    use_checker(lambda *_: draft(rows))
    body = post(client).json()
    assert category(body, "solution")["level"] == "yellow"
    assert body["recommendation"] == "needs_input" and body["overall"] == "add_more"


def test_a_low_score_without_red_is_not_good_enough(client):
    with_sources(client, NOTE, TRANSCRIPT)
    rows = rows_for("persona", 3) + rows_for("challenge", 2) + rows_for("solution", 2)
    use_checker(lambda *_: draft(rows))
    body = post(client).json()
    assert {c["level"] for c in body["categories"]} == {"yellow"}
    assert body["recommendation"] == "needs_input" and body["overall"] == "add_more"


def test_a_report_saved_before_the_categories_is_ignored(client):
    store = app.dependency_overrides[get_store]()
    old = json.dumps({"personaId": PERSONA.id, "personaVersion": 1, "testGoal": GOAL, "score": 1})
    store._call("set", f"{PREFIX}:coverage:{PERSONA.id}", old)
    use_checker(lambda *_: draft([row(n) for n in DEFAULT_CRITERIA]))
    assert post(client).status_code == 200


def test_a_guessed_must_have_blocks_good_enough_and_green(client):
    # xwsam's repro: a weight-3 row whose support is not in its quote is only guessed.
    with_sources(client, NOTE, TRANSCRIPT)
    unbacked = "What the solution is"
    rows = [
        row(n, weight=3, support="words nobody said") if n == unbacked else row(n)
        for n in DEFAULT_CRITERIA
    ]
    use_checker(lambda *_: draft(rows))
    body = post(client).json()
    assert next(c for c in body["criteria"] if c["name"] == unbacked)["status"] == "guessed"
    assert category(body, "solution")["level"] == "yellow"
    assert body["recommendation"] == "needs_input" and body["overall"] == "add_more"


def test_rechecks_of_the_same_version_do_not_pile_up(client):
    # xwsam's repro: run 2 is all green, run 3 reports every row missing on the unchanged persona.
    with_sources(client, NOTE, TRANSCRIPT)
    use_checker(lambda *_: draft([row(n) for n in DEFAULT_CRITERIA]))
    assert post(client).json()["overall"] == "good_enough"
    use_checker(lambda *_: draft([row(n, status="missing", ids=()) for n in DEFAULT_CRITERIA]))
    body = post(client).json()
    assert body["score"] == 0.0 and {c["level"] for c in body["categories"]} == {"red"}
    assert body["overall"] == "add_more"


def test_a_check_running_during_an_edit_is_not_saved(client):
    # 4rifi's and Copilot's case: a PATCH lands while the model is still answering.
    with_sources(client, NOTE, TRANSCRIPT)
    edit = {"jobs": [], "pains": [], "objections": []}

    def checker(*_):
        assert client.patch(f"/api/personas/{PERSONA.id}", json=edit).status_code == 200
        return draft([row(n) for n in DEFAULT_CRITERIA])

    use_checker(checker)
    stale = post(client).json()
    assert stale["personaVersion"] == PERSONA.version
    store = app.dependency_overrides[get_store]()
    assert store.get_coverage(PERSONA.id) is None
    # So it can't become the floor of the next check either.
    use_checker(lambda *_: draft([row(n, status="missing", ids=()) for n in DEFAULT_CRITERIA]))
    body = post(client).json()
    assert body["personaVersion"] == PERSONA.version + 1
    assert body["score"] == 0.0 and body["overall"] == "add_more"
