import json
from collections.abc import Iterator
from copy import deepcopy
from pathlib import Path
from unittest.mock import Mock

import pytest
from fastapi.testclient import TestClient

from app.contracts import Session
from app.main import app
from app.store import Store, get_store
from tests.fakes import FakeRedis

EXAMPLES: list[dict[str, object]] = json.loads(
    (Path(__file__).parents[2] / "shared" / "examples" / "session-events.json").read_text()
)
URL = "/api/sessions/s_1/events"


def event(event_type: str = "utterance", **changes: object) -> dict[str, object]:
    result = deepcopy(next(e for e in EXAMPLES if e["type"] == event_type))
    result.update(changes)
    return result


@pytest.fixture
def store() -> Store:
    store = Store(FakeRedis())
    store.save_session(
        Session(id="s_1", persona_id="p_1", status="live", provider="openai-realtime")
    )
    return store


@pytest.fixture
def client(store: Store) -> Iterator[TestClient]:
    app.dependency_overrides[get_store] = lambda: store
    try:
        with TestClient(app) as client:
            yield client
    finally:
        app.dependency_overrides.clear()


def test_all_examples_round_trip_sorted_and_strictly_after(client: TestClient) -> None:
    session = client.get("/api/sessions/s_1").json()
    assert client.get(URL).json() == []
    response = client.post(URL, json=list(reversed(EXAMPLES)))
    assert response.status_code == 200 and response.json() == {"accepted": len(EXAMPLES)}
    assert client.get(URL).json() == EXAMPLES
    assert client.get(URL, params={"after": 0}).json() == EXAMPLES
    assert client.get(URL, params={"after": 4}).json() == EXAMPLES[4:]
    assert client.get(URL, params={"after": 9}).json() == []
    assert client.get(URL, params={"after": 100}).json() == []
    assert client.post(URL, json=EXAMPLES).json() == {"accepted": 0}
    assert client.get("/api/sessions/s_1").json() == session


def test_integral_float_seq_uses_integer_store_key(client: TestClient) -> None:
    body = event(seq=2.0)
    response = client.post(URL, json=[body])
    assert response.status_code == 200 and response.json() == {"accepted": 1}
    returned = client.get(URL, params={"after": 1}).json()
    assert returned == [body]
    assert type(returned[0]["seq"]) is int
    assert client.get(URL, params={"after": 2}).json() == []
    assert client.post(URL, json=[event(seq=2)]).json() == {"accepted": 0}


def test_integral_float_reaction_intensity_preserved(client: TestClient) -> None:
    body = event("twin.reaction", data={"kind": "confused", "intensity": 3.0})
    response = client.post(URL, json=[body])
    assert response.status_code == 200 and response.json() == {"accepted": 1}
    returned = client.get(URL).json()
    assert returned == [body]
    assert type(returned[0]["data"]["intensity"]) is float
    assert client.post(URL, json=[body]).json() == {"accepted": 0}


def test_integral_float_suggestion_turn_seq_preserved(client: TestClient) -> None:
    body = event("copilot.suggestion", data={"kind": "coverage", "text": "ok", "turnSeq": 1.0})
    response = client.post(URL, json=[body])
    assert response.status_code == 200 and response.json() == {"accepted": 1}
    returned = client.get(URL).json()
    assert returned == [body]
    assert type(returned[0]["data"]["turnSeq"]) is float
    assert client.post(URL, json=[body]).json() == {"accepted": 0}


@pytest.mark.parametrize(
    ("event_type", "data"),
    [
        ("utterance", {"speaker": "persona", "text": ""}),
        ("utterance", {"speaker": "interviewer", "text": "ok", "tStart": None, "tEnd": None}),
        ("utterance", {"speaker": "persona", "text": "ok", "tStart": -1, "tEnd": 0.25}),
        ("screen.caption", {"caption": "", "source": "dom"}),
        ("twin.reaction", {"kind": "pleased", "intensity": 1}),
        ("twin.reaction", {"kind": "sceptical", "intensity": 5}),
        ("copilot.suggestion", {"kind": "pitching", "text": ""}),
        ("copilot.suggestion", {"kind": "follow_up", "text": "ok", "turnSeq": None}),
        ("copilot.suggestion", {"kind": "coverage", "text": "ok", "turnSeq": -1}),
        ("session.ended", {}),
        ("session.ended", {"durationSeconds": -0.5}),
        ("session.ended", {"durationSeconds": 3, "transcriptGaps": True}),
    ],
)
def test_schema_optional_null_and_extra_fields_preserved(
    client: TestClient, event_type: str, data: dict[str, object]
) -> None:
    body = event(event_type, data={**data, "metadata": {"note": None, "tags": ["test"]}})
    body["extraEnvelopeField"] = "allowed by schema"
    assert client.post(URL, json=[body]).json() == {"accepted": 1}
    returned = client.get(URL).json()[0]
    assert returned["data"] == body["data"]
    assert returned["sessionId"] == "s_1" and "session_id" not in returned
    assert client.post(URL, json=[body]).json() == {"accepted": 0}


@pytest.mark.parametrize(
    ("event_type", "data"),
    [
        ("utterance", {}),
        ("utterance", {"speaker": "persona"}),
        ("utterance", {"text": "ok"}),
        ("utterance", {"speaker": "system", "text": "ok"}),
        ("utterance", {"speaker": "persona", "text": False}),
        ("utterance", {"speaker": "persona", "text": None}),
        ("utterance", {"speaker": "persona", "text": 42}),
        ("utterance", {"speaker": "persona", "text": "ok", "tStart": "1.2"}),
        ("utterance", {"speaker": "persona", "text": "ok", "tStart": True}),
        ("utterance", {"speaker": "persona", "text": "ok", "tEnd": "2"}),
        ("utterance", {"speaker": "persona", "text": "ok", "tEnd": False}),
        ("screen.caption", {}),
        ("screen.caption", {"source": "vision"}),
        ("screen.caption", {"caption": "ok"}),
        ("screen.caption", {"caption": "ok", "source": "camera"}),
        ("screen.caption", {"caption": False, "source": "vision"}),
        ("screen.caption", {"caption": None, "source": "vision"}),
        ("screen.caption", {"caption": "ok", "source": None}),
        ("twin.reaction", {}),
        ("twin.reaction", {"kind": "confused"}),
        ("twin.reaction", {"intensity": 3}),
        ("twin.reaction", {"kind": "angry", "intensity": 3}),
        ("twin.reaction", {"kind": "confused", "intensity": 0}),
        ("twin.reaction", {"kind": "confused", "intensity": 6}),
        ("twin.reaction", {"kind": "confused", "intensity": 1.5}),
        ("twin.reaction", {"kind": "confused", "intensity": "3"}),
        ("twin.reaction", {"kind": "confused", "intensity": True}),
        ("twin.reaction", {"kind": "confused", "intensity": None}),
        ("copilot.suggestion", {}),
        ("copilot.suggestion", {"kind": "coverage"}),
        ("copilot.suggestion", {"text": "ok"}),
        ("copilot.suggestion", {"kind": "other", "text": "ok"}),
        ("copilot.suggestion", {"kind": "coverage", "text": None}),
        ("copilot.suggestion", {"kind": "coverage", "text": 42}),
        ("copilot.suggestion", {"kind": "coverage", "text": "ok", "turnSeq": "7"}),
        ("copilot.suggestion", {"kind": "coverage", "text": "ok", "turnSeq": True}),
        ("copilot.suggestion", {"kind": "coverage", "text": "ok", "turnSeq": 1.5}),
        ("session.ended", {"durationSeconds": None}),
        ("session.ended", {"durationSeconds": "1800"}),
        ("session.ended", {"durationSeconds": True}),
        ("session.ended", {"durationSeconds": {}}),
        ("session.ended", {"transcriptGaps": "yes"}),
        ("session.ended", {"transcriptGaps": 1}),
        ("session.ended", {"transcriptGaps": None}),
    ],
)
def test_invalid_data_rejected_before_any_batch_write(
    client: TestClient, store: Store, event_type: str, data: dict[str, object]
) -> None:
    response = client.post(URL, json=[event(seq=20), event(event_type, seq=21, data=data)])
    assert response.status_code == 422
    assert store.get_events("s_1") == []


@pytest.mark.parametrize("field", ["sessionId", "seq", "at", "type", "data"])
def test_missing_envelope_field(client: TestClient, store: Store, field: str) -> None:
    body = event()
    del body[field]
    assert client.post(URL, json=[event(seq=20), body]).status_code == 422
    assert store.get_events("s_1") == []


@pytest.mark.parametrize(
    "changes",
    [
        {"seq": 0},
        {"seq": -1},
        {"seq": True},
        {"seq": "2"},
        {"seq": 1.5},
        {"seq": None},
        {"at": 1793455925},
        {"at": None},
        {"sessionId": 1},
        {"sessionId": None},
        {"type": "audio"},
        {"type": None},
        {"data": None},
        {"data": []},
        {"data": "caption"},
    ],
)
def test_invalid_envelope(client: TestClient, changes: dict[str, object]) -> None:
    assert client.post(URL, json=[event(**changes)]).status_code == 422


def test_session_id_must_use_canonical_alias(client: TestClient) -> None:
    body = event()
    body["session_id"] = body.pop("sessionId")
    assert client.post(URL, json=[body]).status_code == 422


@pytest.mark.parametrize("body", [{}, "text", 1, [None], [[]]])
def test_invalid_batch_body(client: TestClient, body: object) -> None:
    assert client.post(URL, json=body).status_code == 422


@pytest.mark.parametrize("body", ["1e400", "-1e400", "NaN", "Infinity", "-Infinity"])
def test_nonfinite_batch_body_is_sanitized_422(client: TestClient, store: Store, body: str) -> None:
    response = client.post(URL, content=body, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert response.json() == {"detail": "expected a list of session events"}
    assert store.get_events("s_1") == []


def test_missing_and_malformed_json_body(client: TestClient) -> None:
    assert client.post(URL).status_code == 422
    assert (
        client.post(URL, content="[", headers={"Content-Type": "application/json"}).status_code
        == 422
    )


@pytest.mark.parametrize(
    "at",
    [
        "2026-10-31T14:12:05Z",
        "2026-10-31T14:12:05.123456789+02:30",
        "2026-10-31t14:12:05z",
        "2026-10-31T14:12:05-07:00",
    ],
)
def test_valid_timestamp_preserved(client: TestClient, at: str) -> None:
    assert client.post(URL, json=[event(at=at)]).json() == {"accepted": 1}
    assert client.get(URL).json()[0]["at"] == at


@pytest.mark.parametrize("event_type", sorted({e["type"] for e in EXAMPLES}))
@pytest.mark.parametrize(
    "at",
    [
        "2016-12-31T23:59:60Z",
        "2016-12-31t23:59:60.123456789z",
        "2017-01-01T00:59:60+01:00",
        "2016-12-31T16:59:60-07:00",
        "2015-06-30T23:59:60Z",
        "2015-07-01T05:29:60+05:30",
        "2015-06-30T20:29:60-03:30",
    ],
)
def test_leap_second_round_trip_preserves_original(
    client: TestClient, event_type: str, at: str
) -> None:
    body = event(event_type, at=at)
    response = client.post(URL, json=[body])
    assert response.status_code == 200 and response.json() == {"accepted": 1}
    assert client.get(URL).json() == [body]
    assert client.post(URL, json=[body]).json() == {"accepted": 0}


@pytest.mark.parametrize("event_type", sorted({e["type"] for e in EXAMPLES}))
@pytest.mark.parametrize(
    "at",
    [
        "2017-01-01T12:34:60Z",
        "2016-12-31T12:34:60Z",
        "2016-12-31T23:58:60Z",
        "2016-12-30T23:59:60Z",
        "2015-06-29T23:59:60Z",
        "2016-03-31T23:59:60Z",
        "2016-12-31T23:59:60+01:00",
        "2016-12-31T23:59:60-01:00",
        "2017-01-01T00:59:60-01:00",
        "2017-07-01T00:00:60+01:00",
        "0001-01-01T00:59:60+01:00",
        "9999-12-31T23:59:60-01:00",
    ],
)
def test_invalid_leap_second_rejected_before_any_batch_write(
    client: TestClient,
    store: Store,
    monkeypatch: pytest.MonkeyPatch,
    event_type: str,
    at: str,
) -> None:
    append_events = Mock(wraps=store.append_events)
    monkeypatch.setattr(store, "append_events", append_events)
    response = client.post(URL, json=[event(seq=20), event(event_type, seq=21, at=at)])
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid session event"}
    append_events.assert_not_called()
    assert store.get_events("s_1") == []


@pytest.mark.parametrize(
    "at",
    [
        "",
        "not a timestamp",
        "2026-10-31",
        "2026-10-31T14:12:05",
        "2026-10-31 14:12:05Z",
        "2026-10-31T14:12Z",
        "2026-02-30T14:12:05Z",
        "2016-02-30T23:59:60Z",
        "2016-12-31T24:59:60Z",
        "2016-12-31T23:60:60Z",
        "2016-12-31T23:59:60+00:60",
        "2026-10-31T24:12:05Z",
        "2026-10-31T14:60:05Z",
        "2026-10-31T14:12:61Z",
        "2026-10-31T14:12:05+25:00",
        "2026-10-31T14:12:05+00:60",
        "2026-10-31T14:12:05+0200",
        "20261031T141205Z",
    ],
)
def test_invalid_timestamp_no_writes(client: TestClient, store: Store, at: str) -> None:
    assert client.post(URL, json=[event(seq=20), event(at=at)]).status_code == 422
    assert store.get_events("s_1") == []


@pytest.mark.parametrize(
    "after",
    [
        "-1",
        "abc",
        "1.5",
        "1.0",
        "true",
        "",
        "NaN",
        "null",
        "0x10",
        " 1",
        "+1",
        "١",
        pytest.param("9" * 4301, id="overlong-integer"),
    ],
)
def test_invalid_cursor(client: TestClient, after: str) -> None:
    assert client.get(URL, params={"after": after}).status_code == 422


def test_session_mismatch_no_writes(client: TestClient, store: Store) -> None:
    response = client.post(URL, json=[event(seq=20), event(sessionId="s_other")])
    assert response.status_code == 422
    assert store.get_events("s_1") == [] and store.get_events("s_other") == []


def test_unknown_session(client: TestClient, store: Store) -> None:
    url = "/api/sessions/missing/events"
    assert client.get(url).status_code == 404
    assert client.post(url, json=[event(sessionId="missing")]).status_code == 404
    assert client.post(url, json=[]).status_code == 404
    assert store.get_events("missing") == []


def test_empty_batch_is_noop(client: TestClient, store: Store) -> None:
    assert client.post(URL, json=[]).json() == {"accepted": 0}
    assert store.get_events("s_1") == []


def test_identical_duplicates_count_once_and_retry_adds_zero(client: TestClient) -> None:
    body = [event(), event(), event(seq=20)]
    assert client.post(URL, json=body).json() == {"accepted": 2}
    assert client.post(URL, json=body).json() == {"accepted": 0}
    assert client.get(URL).json() == [body[0], body[2]]


def test_conflicting_duplicates_rejected_before_write(client: TestClient, store: Store) -> None:
    response = client.post(
        URL,
        json=[event(seq=20), event(), event(data={"speaker": "persona", "text": "changed"})],
    )
    assert response.status_code == 409
    assert store.get_events("s_1") == []


@pytest.mark.parametrize(
    "changes",
    [
        {"data": {"speaker": "persona", "text": "changed"}},
        {"at": "2026-10-31T14:12:11Z"},
        {"type": "session.ended", "data": {}},
    ],
)
def test_existing_seq_conflict_preserves_original(
    client: TestClient, changes: dict[str, object]
) -> None:
    original = event()
    assert client.post(URL, json=[original]).json() == {"accepted": 1}
    assert client.post(URL, json=[event(**changes)]).status_code == 409
    assert client.get(URL).json() == [original]


def test_existing_store_conflict_does_not_promise_batch_rollback(client: TestClient) -> None:
    original, new = event(), event(seq=20)
    client.post(URL, json=[original])
    changed = event(data={"speaker": "persona", "text": "changed"})
    assert client.post(URL, json=[new, changed]).status_code == 409
    # Store inserts each new seq and reports conflicts; it does not roll back other inserts.
    assert client.get(URL).json() == [original, new]
    assert client.post(URL, json=[new]).json() == {"accepted": 0}


@pytest.mark.parametrize(
    ("method", "operation"), [("GET", "get"), ("POST", "get"), ("GET", "hgetall"), ("POST", "eval")]
)
def test_store_outage_is_sanitized_503(
    client: TestClient, store: Store, monkeypatch: pytest.MonkeyPatch, method: str, operation: str
) -> None:
    def fail(*args: object, **kwargs: object) -> None:
        raise ConnectionError("https://secret-host token=abc private transcript")

    monkeypatch.setattr(store.redis, operation, fail)
    response = client.request(method, URL, **({"json": [event()]} if method == "POST" else {}))
    assert response.status_code == 503
    assert response.json() == {"detail": "store unavailable"}


def test_nonfinite_numeric_data_is_controlled_422(client: TestClient, store: Store) -> None:
    body = json.dumps([event("session.ended", data={"durationSeconds": float("nan")})])
    response = client.post(URL, content=body, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert store.get_events("s_1") == []


@pytest.mark.parametrize("event_type", sorted({e["type"] for e in EXAMPLES}))
@pytest.mark.parametrize("extra", ["1e400", "-1e400", "NaN", "Infinity", "-Infinity"])
@pytest.mark.parametrize("nested", [False, True])
def test_nonfinite_extra_data_rejected_before_any_batch_write(
    client: TestClient, store: Store, event_type: str, extra: str, nested: bool
) -> None:
    body = event(event_type, seq=21)
    # Use raw JSON so overflow and non-standard number tokens reach the request parser.
    encoded = json.dumps(body)
    data_extra = f'{{"items": [{{"value": {extra}}}]}}' if nested else extra
    encoded = encoded[:-2] + f', "extra": {data_extra}' + encoded[-2:]
    response = client.post(
        URL,
        content=f"[{json.dumps(event(seq=20))}, {encoded}]",
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid session event"}
    assert store.get_events("s_1") == []


@pytest.mark.parametrize("event_type", sorted({e["type"] for e in EXAMPLES}))
@pytest.mark.parametrize(
    "depth",
    [
        pytest.param(220, id="store-json-recursion-limit"),
        pytest.param(970, id="precheck-recursion-limit"),
    ],
)
def test_deeply_nested_extra_rejected_before_any_batch_write(
    client: TestClient,
    store: Store,
    monkeypatch: pytest.MonkeyPatch,
    event_type: str,
    depth: int,
) -> None:
    append_events = Mock(wraps=store.append_events)
    monkeypatch.setattr(store, "append_events", append_events)
    # Build raw JSON so the client encoder cannot hit its recursion limit first.
    nested = "[" * depth + '"private transcript"' + "]" * depth
    encoded = json.dumps(event(event_type, seq=21))
    encoded = encoded[:-2] + f', "extra": {nested}' + encoded[-2:]
    response = client.post(
        URL,
        content=f"[{json.dumps(event(seq=20))}, {encoded}]",
        headers={"Content-Type": "application/json"},
    )
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid session event"}
    append_events.assert_not_called()
    assert store.get_events("s_1") == []
    polled = client.get(URL)
    assert polled.status_code == 200 and polled.json() == []


@pytest.mark.parametrize(
    ("event_type", "data"),
    [
        ("utterance", {"speaker": "persona", "text": "\ud800"}),
        ("screen.caption", {"caption": "\ud800", "source": "vision"}),
        ("copilot.suggestion", {"kind": "coverage", "text": "\ud800"}),
    ],
)
def test_unpaired_surrogate_text_rejected_before_any_batch_write(
    client: TestClient, store: Store, event_type: str, data: dict[str, object]
) -> None:
    body = json.dumps([event(seq=20), event(event_type, seq=21, data=data)])
    response = client.post(URL, content=body, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid session event"}
    assert store.get_events("s_1") == []


@pytest.mark.parametrize("event_type", sorted({e["type"] for e in EXAMPLES}))
@pytest.mark.parametrize("extra", [{"note": "\ud800"}, {"\udfff": "note"}])
def test_unpaired_surrogate_nested_extras_rejected_before_any_batch_write(
    client: TestClient, store: Store, event_type: str, extra: dict[str, object]
) -> None:
    original = event(event_type)
    assert isinstance(original["data"], dict)
    data = {**original["data"], "metadata": {"items": [extra]}}
    body = json.dumps([event(seq=20), event(event_type, seq=21, data=data)])
    response = client.post(URL, content=body, headers={"Content-Type": "application/json"})
    assert response.status_code == 422
    assert response.json() == {"detail": "invalid session event"}
    assert store.get_events("s_1") == []


def test_late_finalized_turns_can_flush_without_changing_lifecycle(client: TestClient) -> None:
    ended = client.patch("/api/sessions/s_1", json={"status": "ended"}).json()
    final_marker = event("session.ended", seq=50)
    late_turn = event(seq=49)
    assert client.post(URL, json=[final_marker]).json() == {"accepted": 1}
    assert client.post(URL, json=[late_turn]).json() == {"accepted": 1}
    assert client.get(URL, params={"after": 48}).json() == [late_turn, final_marker]
    assert client.get("/api/sessions/s_1").json() == ended
    assert client.post("/api/sessions/s_1/token").status_code == 409
    assert client.get("/api/health").json() == {"status": "ok"}
