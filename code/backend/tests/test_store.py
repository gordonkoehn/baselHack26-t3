import itertools
import json
import threading
import time
from pathlib import Path

import pytest

from app.contracts import InsightReport, Persona, Session, SessionEvent
from app.store import PERSONA_LIST_SIZE, TTL_SECONDS, EventConflict, Store, StoreUnavailable
from tests.fakes import FakeRedis

EXAMPLES = Path(__file__).parents[2] / "shared" / "examples"


def load(name: str):
    return json.loads((EXAMPLES / name).read_text())


class BrokenRedis:
    def __getattr__(self, name):
        def fail(*args, **kwargs):
            raise ConnectionError("https://secret-host token=abc")

        return fail


@pytest.fixture
def redis():
    return FakeRedis()


def events():
    return [SessionEvent.model_validate(e) for e in load("session-events.json")]


def test_second_instance_reads_what_first_saved(redis):
    persona = Persona.model_validate(load("persona.json"))
    session = Session.model_validate(load("session.json"))
    report = InsightReport.model_validate(load("insight-report.json"))
    first = Store(redis)
    first.save_persona(persona)
    first.save_session(session)
    first.save_report(report)

    second = Store(redis)
    assert second.get_persona(persona.id) == persona
    assert second.get_session(session.id) == session
    assert second.get_report(report.session_id) == report


def test_round_trip_keeps_camel_case_json(redis):
    Store(redis).save_persona(Persona.model_validate(load("persona.json")))
    raw = next(v for k, v in redis.data.items() if k.startswith("ot:persona:"))
    assert "voiceId" in json.loads(raw)


def test_missing_keys_return_none(redis):
    store = Store(redis)
    assert store.get_persona("nope") is None
    assert store.get_session("nope") is None
    assert store.get_report("nope") is None
    assert store.get_events("nope") == []


def test_events_sorted_and_identical_retry_adds_nothing(redis):
    store = Store(redis)
    batch = events()
    sid = batch[0].session_id
    assert store.append_events(sid, list(reversed(batch))) == len(batch)
    assert store.append_events(sid, batch) == 0
    assert [e.seq for e in store.get_events(sid)] == sorted(e.seq for e in batch)


def test_conflicting_duplicate_raises(redis):
    store = Store(redis)
    event = events()[0]
    store.append_events(event.session_id, [event])
    changed = event.model_copy(update={"data": {"text": "something else"}})
    with pytest.raises(EventConflict):
        store.append_events(event.session_id, [changed])


def test_event_for_other_session_rejected(redis):
    event = events()[0]
    with pytest.raises(ValueError):
        Store(redis).append_events("other-session", [event])


def test_concurrent_appends_store_each_seq_once(redis):
    store = Store(redis)
    event = events()[0]
    added = []
    threads = [
        threading.Thread(
            target=lambda: added.append(store.append_events(event.session_id, [event]))
        )
        for _ in range(20)
    ]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    assert sum(added) == 1
    assert len(store.get_events(event.session_id)) == 1


@pytest.fixture
def clock(monkeypatch):
    ticks = itertools.count(1_700_000_000)
    monkeypatch.setattr(time, "time", lambda: next(ticks))


def persona(persona_id: str) -> Persona:
    return Persona.model_validate(load("persona.json")).model_copy(update={"id": persona_id})


def test_list_is_newest_first_with_summary_fields(redis, clock):
    store = Store(redis)
    store.save_persona(persona("p_old"))
    store.save_persona(persona("p_new"))
    assert [p.model_dump(by_alias=True) for p in store.list_personas()] == [
        {
            "id": "p_new",
            "name": "Sandra",
            "role": "HR specialist, 80 %",
            "createdAt": "2023-11-14T22:13:21Z",
            "readiness": persona("p_new").readiness.model_dump(),
        },
        {
            "id": "p_old",
            "name": "Sandra",
            "role": "HR specialist, 80 %",
            "createdAt": "2023-11-14T22:13:20Z",
            "readiness": persona("p_old").readiness.model_dump(),
        },
    ]


def test_list_keeps_only_the_newest_personas(redis, clock):
    store = Store(redis)
    for i in range(PERSONA_LIST_SIZE + 1):
        store.save_persona(persona(f"p_{i:02}"))
    assert [p.id for p in store.list_personas()] == [
        f"p_{i:02}" for i in range(PERSONA_LIST_SIZE, 0, -1)
    ]
    assert len(redis.data["ot:personas"]) == PERSONA_LIST_SIZE


def test_saving_again_keeps_creation_time_and_shows_the_change(redis, clock):
    store = Store(redis)
    store.save_persona(persona("p_a"))
    store.save_persona(persona("p_b"))
    created = store.list_personas()[1].created_at
    store.save_persona(persona("p_a").model_copy(update={"name": "Renamed"}))
    assert [(p.id, p.name) for p in store.list_personas()] == [
        ("p_b", "Sandra"),
        ("p_a", "Renamed"),
    ]
    assert store.list_personas()[1].created_at == created


def test_list_skips_expired_personas(redis, clock):
    store = Store(redis)
    store.save_persona(persona("p_a"))
    store.save_persona(persona("p_b"))
    del redis.data["ot:persona:p_b"]
    assert [p.id for p in store.list_personas()] == ["p_a"]


def test_empty_list_needs_no_persona_reads(redis):
    assert Store(redis).list_personas() == []


def test_persona_index_has_the_shared_ttl(redis):
    Store(redis).save_persona(persona("p_a"))
    assert redis.ttl["ot:personas"] == TTL_SECONDS


def test_all_keys_share_one_ttl(redis):
    store = Store(redis)
    store.save_session(Session.model_validate(load("session.json")))
    batch = events()
    store.append_events(batch[0].session_id, batch)
    assert set(redis.ttl.values()) == {TTL_SECONDS}


def test_store_errors_hide_details():
    with pytest.raises(StoreUnavailable) as err:
        Store(BrokenRedis()).get_persona("x")
    assert "secret" not in str(err.value) and "token" not in str(err.value)


def test_conflict_after_first_insert_still_sets_ttl(redis):
    store = Store(redis)
    a = events()[0]
    b = a.model_copy(update={"data": {"text": "other"}})
    with pytest.raises(EventConflict):
        store.append_events(a.session_id, [a, b])
    assert redis.ttl[f"ot:session:{a.session_id}:events"] == TTL_SECONDS


def test_failed_script_writes_nothing():
    """Write and TTL fail together: no hash is left behind without expiry."""

    class EvalFails(FakeRedis):
        def eval(self, script, keys, args):
            raise TimeoutError("interrupted")

    redis = EvalFails()
    event = events()[0]
    with pytest.raises(StoreUnavailable):
        Store(redis).append_events(event.session_id, [event])
    assert redis.data == {} and redis.ttl == {}


def test_ttl_set_in_same_call_as_write(redis):
    """No separate EXPIRE command: the fake has none, so a second call would fail."""
    assert not hasattr(redis, "expire") and not hasattr(redis, "hsetnx")
    event = events()[0]
    Store(redis).append_events(event.session_id, [event])
    assert redis.ttl[f"ot:session:{event.session_id}:events"] == TTL_SECONDS


def test_empty_batch_is_noop(redis):
    assert Store(redis).append_events("s_1", []) == 0
    assert redis.data == {}
