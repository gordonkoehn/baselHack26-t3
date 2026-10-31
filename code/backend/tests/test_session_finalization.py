"""Offline transition regressions using FakeRedis; no real Redis/Lua execution."""

import json
import threading
from concurrent.futures import ThreadPoolExecutor

import pytest
from fastapi.testclient import TestClient

from app.contracts import Session
from app.main import app
from app.store import (
    PREFIX,
    SESSION_TRANSITION_ATTEMPTS,
    TRANSITION_SESSION,
    TTL_SECONDS,
    SessionConflict,
    Store,
    StoreUnavailable,
    get_store,
)
from tests.fakes import FakeRedis


@pytest.fixture
def state():
    redis = FakeRedis()
    store = Store(redis)
    store.save_session(
        Session(id="s_atomic", persona_id="p_fake", status="created", provider="openai-realtime")
    )
    app.dependency_overrides[get_store] = lambda: store
    try:
        yield store, redis, TestClient(app)
    finally:
        app.dependency_overrides.clear()


@pytest.mark.parametrize("first", ["live", "ended"])
@pytest.mark.parametrize("guide", [[], ['Question with "quotes", punctuation: {} [] and café?']])
def test_timestamps_aliases_ttl_and_repeated_end(state, first, guide):
    store, redis, client = state
    key = f"{PREFIX}:session:s_atomic"
    store.save_session(
        store.get_session("s_atomic").model_copy(
            update={
                "interview_guide": guide,
                "join_url": "https://example.invalid/room",
                "ready_seconds": 1.2345678901234567,
            }
        )
    )
    redis.ttl[key] = 123
    initial = store.get_session("s_atomic").model_dump(by_alias=True)
    response = client.patch("/api/sessions/s_atomic", json={"status": first})
    assert response.status_code == 200
    transitioned = response.json()
    assert redis.ttl[key] == TTL_SECONDS
    assert json.loads(redis.data[key])["interviewGuide"] == guide
    assert transitioned["interviewGuide"] == guide
    if first == "live":
        assert transitioned["startedAt"] and transitioned["endedAt"] is None
        redis.ttl[key] = 122
        assert (
            client.patch("/api/sessions/s_atomic", json={"status": "live"}).json() == transitioned
        )
        assert redis.ttl[key] == 122  # Idempotent writes do not refresh TTL.
    ended = client.patch("/api/sessions/s_atomic", json={"status": "ended"}).json()
    assert ended["endedAt"]
    assert ended["startedAt"] == transitioned["startedAt"]
    for field in initial.keys() - {"status", "startedAt", "endedAt"}:
        assert ended[field] == initial[field]
    redis.ttl[key] = 121
    assert client.patch("/api/sessions/s_atomic", json={"status": "ended"}).json() == ended
    assert client.patch("/api/sessions/s_atomic", json={"status": "live"}).status_code == 409
    assert redis.ttl[key] == 121
    assert client.get("/api/sessions/s_atomic").json() == ended


def test_missing_transition_is_404_without_creating_key(state):
    _, redis, client = state
    for status in ["live", "ended"]:
        assert client.patch("/api/sessions/s_missing", json={"status": status}).status_code == 404
    assert f"{PREFIX}:session:s_missing" not in redis.data
    assert f"{PREFIX}:session:s_missing" not in redis.ttl


def test_delayed_live_cannot_overwrite_ended_after_gateway_timeout(state, monkeypatch):
    store, redis, client = state
    entered, release = threading.Event(), threading.Event()
    original = redis.eval

    def delayed(script, keys, args):
        if script == TRANSITION_SESSION and json.loads(args[1])["status"] == "live":
            entered.set()
            assert release.wait(5)
        return original(script, keys, args)

    monkeypatch.setattr(redis, "eval", delayed)
    with ThreadPoolExecutor(max_workers=1) as pool:
        # The gateway/client can time out while this server request is still waiting.
        live = pool.submit(client.patch, "/api/sessions/s_atomic", json={"status": "live"})
        assert entered.wait(5)
        try:
            ended = client.patch("/api/sessions/s_atomic", json={"status": "ended"})
            assert ended.status_code == 200
            snapshot = ended.json()
        finally:
            release.set()
        assert live.result(timeout=5).status_code == 409
    assert store.get_session("s_atomic").model_dump(by_alias=True) == snapshot
    assert snapshot["startedAt"] is None and snapshot["endedAt"]


def test_concurrent_endpoint_transitions_always_end_terminal(state):
    store, _, client = state
    barrier = threading.Barrier(12)

    def patch(status):
        barrier.wait(timeout=5)
        return status, client.patch("/api/sessions/s_atomic", json={"status": status})

    with ThreadPoolExecutor(max_workers=12) as pool:
        results = list(pool.map(patch, ["live", "ended"] * 6))
    ended = store.get_session("s_atomic").model_dump(by_alias=True)
    assert ended["status"] == "ended" and ended["endedAt"]
    for status, response in results:
        if status == "ended":
            assert response.status_code == 200 and response.json() == ended
        else:
            assert response.status_code in {200, 409}
            if response.status_code == 200:
                assert response.json()["startedAt"] == ended["startedAt"]


def test_transition_store_failure_is_503(state, monkeypatch):
    _, redis, client = state

    def unavailable(*args, **kwargs):
        raise RuntimeError("synthetic private detail")

    monkeypatch.setattr(redis, "eval", unavailable)
    response = client.patch("/api/sessions/s_atomic", json={"status": "ended"})
    assert response.status_code == 503
    assert "private detail" not in response.text


def test_independent_store_instances_share_terminal_transition(state):
    first, redis, _ = state
    second = Store(redis)
    ended = second.transition_session("s_atomic", "ended", "2026-10-31T10:00:00Z")
    with pytest.raises(SessionConflict, match="cannot go from ended to live"):
        first.transition_session("s_atomic", "live", "2026-10-31T09:59:00Z")
    assert first.transition_session("s_atomic", "ended", "2026-10-31T10:01:00Z") == ended
    assert second.get_session("s_atomic") == ended


def test_failed_atomic_transition_preserves_json_and_ttl(state, monkeypatch):
    store, redis, _ = state
    before_data, before_ttl = dict(redis.data), dict(redis.ttl)

    def interrupted(*args, **kwargs):
        raise TimeoutError("synthetic interruption")

    monkeypatch.setattr(redis, "eval", interrupted)
    with pytest.raises(StoreUnavailable):
        store.transition_session("s_atomic", "ended", "2026-10-31T10:00:00Z")
    assert redis.data == before_data and redis.ttl == before_ttl


@pytest.mark.parametrize("status", ["live", "ended"])
def test_transition_preserves_high_precision_and_json_values(state, status):
    store, redis, _ = state
    key = f"{PREFIX}:session:s_atomic"
    fields = json.loads(redis.data[key])
    fields.update(
        readySeconds=1.2345678901234567,
        interviewGuide=[],
        joinUrl=None,
        futureMetadata={"empty": [], "null": None, "text": 'café 雪 "quoted"'},
    )
    redis.set(key, json.dumps(fields, ensure_ascii=False), ex=123)
    store.transition_session("s_atomic", status, "2026-10-31T10:00:00Z")
    saved = json.loads(redis.data[key])
    for field in fields.keys() - {"status", "startedAt", "endedAt"}:
        assert saved[field] == fields[field]
    assert saved["readySeconds"] == 1.2345678901234567
    assert saved["status"] == status
    assert redis.ttl[key] == TTL_SECONDS


def test_cas_retries_preserve_concurrent_unrelated_update(state, monkeypatch):
    store, redis, _ = state
    key = f"{PREFIX}:session:s_atomic"
    original = redis.eval
    attempts = 0

    def race(script, keys, args):
        nonlocal attempts
        attempts += 1
        if attempts == 1:
            fields = json.loads(redis.data[key])
            fields["readySeconds"] = 9.876543210987654
            fields["interviewGuide"] = ["Concurrent update 雪"]
            redis.set(key, json.dumps(fields), ex=111)
        return original(script, keys, args)

    monkeypatch.setattr(redis, "eval", race)
    ended = store.transition_session("s_atomic", "ended", "2026-10-31T10:00:00Z")
    assert attempts == 2
    assert ended.status == "ended"
    assert ended.ready_seconds == 9.876543210987654
    assert ended.interview_guide == ["Concurrent update 雪"]
    assert redis.ttl[key] == TTL_SECONDS


def test_cas_missing_between_read_and_write_does_not_recreate_session(state, monkeypatch):
    store, redis, _ = state
    key = f"{PREFIX}:session:s_atomic"
    original = redis.eval

    def expire(script, keys, args):
        del redis.data[key]
        del redis.ttl[key]
        return original(script, keys, args)

    monkeypatch.setattr(redis, "eval", expire)
    assert store.transition_session("s_atomic", "ended", "2026-10-31T10:00:00Z") is None
    assert key not in redis.data and key not in redis.ttl


def test_cas_contention_has_finite_budget_without_overwriting_other_writer(state, monkeypatch):
    store, redis, client = state
    key = f"{PREFIX}:session:s_atomic"
    original = redis.eval
    attempts = 0

    def race(script, keys, args):
        nonlocal attempts
        attempts += 1
        fields = json.loads(redis.data[key])
        fields["readySeconds"] = attempts
        redis.set(key, json.dumps(fields), ex=111)
        return original(script, keys, args)

    monkeypatch.setattr(redis, "eval", race)
    response = client.patch("/api/sessions/s_atomic", json={"status": "ended"})
    assert response.status_code == 503
    assert attempts == SESSION_TRANSITION_ATTEMPTS
    assert store.get_session("s_atomic").status == "created"
    assert store.get_session("s_atomic").ready_seconds == attempts
    assert redis.ttl[key] == 111
