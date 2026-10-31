from dataclasses import dataclass
from datetime import UTC, datetime
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.contracts import Persona, Session, SessionEvent
from app.extract import DebriefDraft, ExtractionFailed, ProviderUnavailable
from app.main import app
from app.routers.insights import get_debriefer
from app.store import Store, StoreUnavailable, get_store
from tests.fakes import FakeRedis
from tests.test_debrief import load, mock_provider, response_body

SID = "s_1"
DEBRIEF = f"/api/sessions/{SID}/debrief"
INSIGHTS = f"/api/sessions/{SID}/insights"


@dataclass
class Context:
    client: TestClient
    store: Store
    provider: Mock
    save: Mock


@pytest.fixture
def context(monkeypatch):
    store = Store(FakeRedis())
    store.save_persona(Persona.model_validate(load("persona.json")))
    session = Session.model_validate({**load("session.json"), "status": "ended"})
    store.save_session(session)
    store.append_events(SID, [SessionEvent.model_validate(e) for e in load("session-events.json")])
    questions = load("insight-report.json")["questions"]
    questions.reverse()
    questions.append(
        {
            "question": session.interview_guide[2],
            "signal": "unclear",
            "insights": [],
            "followUps": ["Ask real customers what made them renew their last subscription."],
        }
    )
    provider = Mock(return_value=DebriefDraft.model_validate({"questions": questions}))
    save = Mock(wraps=store.save_report)
    monkeypatch.setattr(store, "save_report", save)
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_debriefer] = lambda: provider
    with TestClient(app) as client:
        yield Context(client, store, provider, save)
    app.dependency_overrides.clear()


def replace_events(context: Context, events: list[SessionEvent]) -> None:
    # Bypass append-only writes to simulate incomplete/corrupt snapshots and concurrent changes.
    context.store.redis.data[f"ot:session:{SID}:events"] = {
        str(i): event.model_dump_json(by_alias=True) for i, event in enumerate(events)
    }


def assert_not_generated(context: Context) -> None:
    context.provider.assert_not_called()
    context.save.assert_not_called()
    assert context.store.get_report(SID) is None


def test_generate_save_read_and_reuse_one_report(context, monkeypatch):
    start = datetime.now(UTC)
    response = context.client.post(DEBRIEF)
    assert response.status_code == 200
    report = response.json()
    assert report["sessionId"] == SID
    assert start <= datetime.fromisoformat(report["generatedAt"]) <= datetime.now(UTC)
    assert report == context.store.get_report(SID).model_dump(by_alias=True)
    assert report == context.client.get(INSIGHTS).json()
    assert [q["question"] for q in report["questions"]] == load("session.json")["interviewGuide"]
    assert report["questions"][2]["insights"] == []
    context.save.assert_called_once()
    context.provider.assert_called_once()
    monkeypatch.setattr(context.store, "get_events", Mock(side_effect=AssertionError("cached")))
    assert context.client.post(DEBRIEF).json() == report
    context.provider.assert_called_once()
    context.save.assert_called_once()


def test_saved_report_is_reused_after_persona_expires(context, monkeypatch):
    response = context.client.post(DEBRIEF)
    assert response.status_code == 200
    report = response.json()
    context.store.redis.data.pop("ot:persona:p_1")
    persona_lookup = Mock(wraps=context.store.get_persona)
    monkeypatch.setattr(context.store, "get_persona", persona_lookup)

    for response in (context.client.get(INSIGHTS), context.client.post(DEBRIEF)):
        assert response.status_code == 200
        assert response.json() == report
    persona_lookup.assert_not_called()
    context.provider.assert_called_once()
    context.save.assert_called_once()


@pytest.mark.parametrize("method,suffix", [("post", "debrief"), ("get", "insights")])
def test_unknown_session_is_404(context, method, suffix):
    response = getattr(context.client, method)(f"/api/sessions/missing/{suffix}")
    assert response.status_code == 404 and response.json() == {"detail": "session not found"}
    assert_not_generated(context)


def test_missing_persona_is_404(context):
    context.store.redis.data.pop("ot:persona:p_1")
    response = context.client.post(DEBRIEF)
    assert response.status_code == 404 and response.json() == {"detail": "persona not found"}
    assert_not_generated(context)


def test_missing_report_is_404_and_read_never_generates(context):
    response = context.client.get(INSIGHTS)
    assert response.status_code == 404 and response.json() == {"detail": "report not found"}
    assert_not_generated(context)


@pytest.mark.parametrize("status", ["created", "live"])
def test_session_must_be_ended(context, status):
    session = context.store.get_session(SID).model_copy(update={"status": status})
    context.store.save_session(session)
    assert context.client.post(DEBRIEF).status_code == 409
    assert_not_generated(context)


@pytest.mark.parametrize(
    "change",
    [
        "no_events",
        "no_marker",
        "gap",
        "starts_at_two",
        "duplicate_seq",
        "two_markers",
        "after_marker",
        "wrong_session",
        "missing_text",
        "invalid_speaker",
    ],
)
def test_each_incomplete_transcript_gate_blocks_before_provider(context, change):
    events = context.store.get_events(SID)
    if change == "no_events":
        events = []
    elif change == "no_marker":
        events.pop()
    elif change == "gap":
        events.pop(4)
    elif change == "starts_at_two":
        events.pop(0)
    elif change == "duplicate_seq":
        events[3].seq = events[2].seq
    elif change == "two_markers":
        events.append(events[-1].model_copy(update={"seq": 10}))
    elif change == "after_marker":
        events.append(events[2].model_copy(update={"seq": 10}))
    elif change == "wrong_session":
        events[2].session_id = "another-session"
    elif change == "missing_text":
        events[2].data.pop("text")
    else:
        events[2].data["speaker"] = "assistant"
    replace_events(context, events)
    response = context.client.post(DEBRIEF)
    assert response.status_code == 409
    assert_not_generated(context)


@pytest.mark.parametrize("guide", [[], [""], [" \n\t "], ["Valid question?", " "]])
def test_missing_or_blank_guide_is_explicit_422(context, guide):
    session = context.store.get_session(SID).model_copy(update={"interview_guide": guide})
    context.store.save_session(session)
    response = context.client.post(DEBRIEF)
    assert response.status_code == 422 and "guide" in response.json()["detail"]
    assert_not_generated(context)


@pytest.mark.parametrize("change", ["only_marker", "interviewer_only", "blank_persona"])
def test_finalized_but_empty_persona_transcript_is_explicit_422(context, change):
    events = context.store.get_events(SID)
    if change == "only_marker":
        events = [events[-1].model_copy(update={"seq": 1})]
    else:
        for event in events:
            if event.type == "utterance" and event.data["speaker"] == "persona":
                if change == "interviewer_only":
                    event.data["speaker"] = "interviewer"
                else:
                    event.data["text"] = " \n\t "
    replace_events(context, events)
    response = context.client.post(DEBRIEF)
    assert response.status_code == 422 and "persona utterance" in response.json()["detail"]
    assert_not_generated(context)


@pytest.mark.parametrize("change", ["invented", "interviewer"])
def test_invalid_provider_quotes_are_dropped_not_fatal(context, change):
    draft = context.provider.return_value
    insight = draft.questions[0].insights[0]
    if change == "invented":
        insight.quote = "private invented quote"
    else:
        insight.turn_seq = 2
        insight.quote = load("session-events.json")[1]["data"]["text"]
    response = context.client.post(DEBRIEF)
    assert response.status_code == 200
    first = response.json()["questions"][0]
    assert first["insights"] == [] and first["signal"] == "unclear"
    assert "private invented quote" not in response.text


def test_duplicate_insight_ids_are_sanitized_502_without_saving(context):
    draft = context.provider.return_value
    draft.questions[1].insights[0].id = draft.questions[0].insights[0].id
    response = context.client.post(DEBRIEF)
    assert response.status_code == 502 and response.json() == {"detail": "debrief output unusable"}
    context.save.assert_not_called()
    assert context.store.get_report(SID) is None


@pytest.mark.parametrize("failure,status", [(ExtractionFailed, 502), (ProviderUnavailable, 503)])
def test_provider_failure_is_sanitized_and_retry_is_not_cached(context, failure, status):
    context.provider.side_effect = failure("private provider detail")
    response = context.client.post(DEBRIEF)
    assert response.status_code == status and "private" not in response.text
    context.save.assert_not_called()
    assert context.store.get_report(SID) is None
    context.provider.side_effect = None
    assert context.client.post(DEBRIEF).status_code == 200
    assert context.provider.call_count == 2
    context.save.assert_called_once()


@pytest.mark.parametrize(
    "change,status",
    [
        ("refusal", 502),
        ("incomplete", 502),
        ("timeout", 503),
        ("text_response", 502),
        ("null_output", 502),
        ("null_output_item", 502),
        ("noniterable_output", 502),
    ],
)
def test_sdk_provider_failures_reach_endpoint_without_saving(context, monkeypatch, change, status):
    body = response_body(context.provider.return_value)
    if change == "refusal":
        body["output"][0]["content"].append({"type": "refusal", "refusal": "private detail"})
    elif change == "incomplete":
        body["status"] = "incomplete"
    elif change == "text_response":
        body = "private provider detail"
    elif change == "null_output":
        body["output"] = None
    elif change == "null_output_item":
        body["output"] = [None]
    elif change == "noniterable_output":
        body["output"] = 1
    calls = mock_provider(monkeypatch, body, timeout=change == "timeout")
    app.dependency_overrides.pop(get_debriefer)
    response = context.client.post(DEBRIEF)
    assert response.status_code == status and "private" not in response.text
    assert len(calls) == 1
    context.save.assert_not_called()
    assert context.store.get_report(SID) is None


def test_provider_cannot_choose_report_identity_or_time(context, monkeypatch):
    body = response_body(context.provider.return_value)
    provider_json = context.provider.return_value.model_dump_json(by_alias=True)
    body["output"][0]["content"][0]["text"] = (
        '{"sessionId":"forged","generatedAt":"1900-01-01T00:00:00Z",' + provider_json[1:]
    )
    mock_provider(monkeypatch, body)
    app.dependency_overrides.pop(get_debriefer)
    response = context.client.post(DEBRIEF)
    assert response.status_code == 200
    assert response.json()["sessionId"] == SID
    assert datetime.fromisoformat(response.json()["generatedAt"]).year == datetime.now(UTC).year


@pytest.mark.parametrize("method", ["get_session", "get_persona", "get_report", "get_events"])
def test_store_failure_before_generation_uses_existing_sanitized_503(context, monkeypatch, method):
    monkeypatch.setattr(context.store, method, Mock(side_effect=StoreUnavailable("private detail")))
    response = context.client.post(DEBRIEF)
    assert response.status_code == 503 and response.json() == {"detail": "store unavailable"}
    context.provider.assert_not_called()
    context.save.assert_not_called()


def test_store_failure_on_snapshot_reread_does_not_save(context, monkeypatch):
    events = context.store.get_events(SID)
    monkeypatch.setattr(
        context.store, "get_events", Mock(side_effect=[events, StoreUnavailable("private detail")])
    )
    response = context.client.post(DEBRIEF)
    assert response.status_code == 503 and response.json() == {"detail": "store unavailable"}
    context.provider.assert_called_once()
    context.save.assert_not_called()
    assert context.store.get_report(SID) is None


def test_failed_save_never_returns_an_unpersisted_report(context):
    context.save.side_effect = StoreUnavailable("private detail")
    response = context.client.post(DEBRIEF)
    assert response.status_code == 503 and response.json() == {"detail": "store unavailable"}
    context.provider.assert_called_once()
    assert context.store.get_report(SID) is None


@pytest.mark.parametrize("method", ["get_session", "get_report"])
def test_insights_read_store_failures_are_sanitized(context, monkeypatch, method):
    monkeypatch.setattr(context.store, method, Mock(side_effect=StoreUnavailable("private detail")))
    response = context.client.get(INSIGHTS)
    assert response.status_code == 503 and response.json() == {"detail": "store unavailable"}
    context.provider.assert_not_called()


@pytest.mark.parametrize("change", ["append", "replace", "delete"])
def test_transcript_changes_during_generation_are_409_and_not_cached(context, change):
    draft = context.provider.return_value

    def generate(*_args):
        events = context.store.get_events(SID)
        if change == "append":
            events.append(events[2].model_copy(update={"seq": 10}))
        elif change == "replace":
            events[2].data["text"] += " Another statement."
        else:
            events.pop(3)
        replace_events(context, events)
        return draft

    context.provider.side_effect = generate
    response = context.client.post(DEBRIEF)
    assert response.status_code == 409 and "changed" in response.json()["detail"]
    context.save.assert_not_called()
    assert context.store.get_report(SID) is None


def test_health_session_and_persona_routes_remain_available(context):
    assert context.client.get("/api/health").json() == {"status": "ok"}
    assert context.client.get(f"/api/sessions/{SID}").json()["status"] == "ended"
    assert context.client.get("/api/personas/p_1").json()["name"] == load("persona.json")["name"]
    response = context.client.post("/api/sessions", json={"personaId": "p_1"})
    assert response.status_code == 201 and response.json()["status"] == "created"
