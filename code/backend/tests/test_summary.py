from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.contracts import InsightReport
from app.main import app
from app.routers.insights import get_debriefer
from app.store import Store, StoreUnavailable, get_store
from app.summary import summarize
from tests.fakes import FakeRedis

URL = "/api/insights/summary"
Q1 = "Does the matching raise the share?"
Q2 = "Is sharing added value?"


def insight(id_, label="guess", quote=None):
    return {
        "id": id_,
        "theme": f"theme {id_}",
        "quote": quote or f"quote {id_}",
        "turnSeq": 3,
        "label": label,
        "evidenceId": "e1" if label == "grounded" else None,
    }


def question(text, signal, *insights):
    return {"question": text, "signal": signal, "insights": list(insights), "followUps": []}


def report(session_id, *questions):
    return InsightReport.model_validate(
        {
            "sessionId": session_id,
            "generatedAt": "2026-10-31T14:31:30Z",
            "questions": list(questions),
        }
    )


@pytest.fixture
def store():
    store = Store(FakeRedis())
    app.dependency_overrides[get_store] = lambda: store
    yield store
    app.dependency_overrides.pop(get_store, None)


@pytest.fixture
def client(store):
    with TestClient(app) as client:
        yield client


def test_two_debriefs_for_one_guide_give_one_row_per_question_with_counts():
    summary = summarize(
        [
            report("s_1", question(Q1, "supports", insight("i1")), question(Q2, "unclear")),
            report("s_2", question(Q1, "contradicts", insight("i1")), question(Q2, "unclear")),
        ]
    )
    assert [
        (q.question, q.supports, q.contradicts, q.unclear, [i.session_id for i in q.insights])
        for q in summary.questions
    ] == [(Q1, 1, 1, 0, ["s_1", "s_2"]), (Q2, 0, 0, 2, [])]


def test_questions_group_by_exact_text_only():
    summary = summarize(
        [
            report("s_1", question(Q1, "supports")),
            report("s_2", question(f"{Q1} ", "supports"), question(Q1.lower(), "supports")),
        ]
    )
    assert [(q.question, q.supports) for q in summary.questions] == [
        (Q1, 1),
        (f"{Q1} ", 1),
        (Q1.lower(), 1),
    ]


def test_a_question_only_one_guide_has_counts_only_that_interview():
    summary = summarize(
        [
            report("s_1", question(Q1, "supports")),
            report("s_2", question(Q1, "supports"), question(Q2, "contradicts")),
        ]
    )
    assert [(q.question, q.supports, q.contradicts) for q in summary.questions] == [
        (Q1, 2, 0),
        (Q2, 0, 1),
    ]


def test_a_guide_listing_a_question_twice_still_counts_one_interview():
    summary = summarize(
        [report("s_1", question(Q1, "supports", insight("i1")), question(Q1, "contradicts"))]
    )
    assert [(q.supports, q.contradicts) for q in summary.questions] == [(1, 0)]


def test_quotes_are_verbatim_and_carry_their_interview():
    quote = "Da steht sechs und sechs."
    [row] = summarize(
        [report("s_1", question(Q1, "unclear", insight("i1", quote=quote)))]
    ).questions
    assert row.insights[0].model_dump(by_alias=True) == {
        **insight("i1", quote=quote),
        "sessionId": "s_1",
    }


def test_grounded_quotes_come_first_and_interview_order_breaks_ties():
    [row] = summarize(
        [
            report("s_1", question(Q1, "supports", insight("a"))),
            report("s_2", question(Q1, "supports", insight("b", "grounded"), insight("c"))),
            report("s_3", question(Q1, "supports", insight("d"))),
        ]
    ).questions
    assert [i.id for i in row.insights] == ["b", "a", "c", "d"]


def test_every_interview_keeps_its_two_strongest_quotes():
    many = [insight("a"), insight("b", "grounded"), insight("c"), insight("d", "grounded")]
    [row] = summarize(
        [
            report("s_1", question(Q1, "supports", *many)),
            # A lone dissenting interview must not be crowded out by the talkative one.
            report("s_2", question(Q1, "contradicts", insight("e"))),
        ]
    ).questions
    assert [(i.session_id, i.id) for i in row.insights] == [
        ("s_1", "b"),
        ("s_1", "d"),
        ("s_2", "e"),
    ]


def test_route_summarises_saved_debriefs_without_a_model(client, store):
    store.save_report(report("s_1", question(Q1, "supports", insight("i1"))))
    store.save_report(report("s_2", question(Q1, "supports", insight("i1"))))
    provider = Mock(side_effect=AssertionError("a summary must not call a model"))
    app.dependency_overrides[get_debriefer] = lambda: provider
    try:
        body = client.post(URL, json={"sessionIds": ["s_2", "s_1"]})
    finally:
        app.dependency_overrides.pop(get_debriefer, None)
    assert body.status_code == 200, body.text
    [row] = body.json()["questions"]
    assert (row["question"], row["supports"], row["contradicts"], row["unclear"]) == (Q1, 2, 0, 0)
    assert [i["sessionId"] for i in row["insights"]] == ["s_2", "s_1"]
    provider.assert_not_called()


def test_route_counts_a_repeated_id_once(client, store):
    store.save_report(report("s_1", question(Q1, "supports", insight("i1"))))
    body = client.post(URL, json={"sessionIds": ["s_1", "s_1"]}).json()
    assert body["questions"][0]["supports"] == 1
    assert len(body["questions"][0]["insights"]) == 1


def test_route_refuses_a_partial_count_when_a_debrief_is_missing(client, store):
    store.save_report(report("s_1", question(Q1, "supports")))
    response = client.post(URL, json={"sessionIds": ["s_1", "s_gone"]})
    assert response.status_code == 404
    assert "s_gone" in response.json()["detail"]
    assert "s_1" not in response.json()["detail"]


@pytest.mark.parametrize("session_ids", [[], [f"s_{i}" for i in range(51)]])
def test_route_rejects_no_ids_or_too_many(client, session_ids):
    assert client.post(URL, json={"sessionIds": session_ids}).status_code == 422


def test_route_accepts_as_many_ids_as_a_persona_can_list(client, store):
    session_ids = [f"s_{i}" for i in range(50)]
    for session_id in session_ids:
        store.save_report(report(session_id, question(Q1, "supports")))
    body = client.post(URL, json={"sessionIds": session_ids})
    assert body.status_code == 200, body.text
    assert body.json()["questions"][0]["supports"] == 50


def test_route_needs_no_passcode_like_reading_one_report(client, store, monkeypatch):
    monkeypatch.setenv("DEMO_PASSCODE", "team-pass")
    store.save_report(report("s_1", question(Q1, "supports")))
    assert client.post(URL, json={"sessionIds": ["s_1"]}).status_code == 200


def test_route_answers_503_when_the_store_is_down(client, store, monkeypatch):
    monkeypatch.setattr(store, "get_reports", Mock(side_effect=StoreUnavailable("store down")))
    assert client.post(URL, json={"sessionIds": ["s_1"]}).status_code == 503
