"""Durable store for personas, sessions, events and reports (Upstash Redis over REST).

Endpoints call `get_store()`; tests pass a fake client to `Store(...)`. Values are camelCase
contract JSON, so what we read back validates against the same models.
"""

import json
from functools import lru_cache
from typing import Any

from pydantic import BaseModel

from app.contracts import InsightReport, Persona, Session, SessionEvent

# shortcut: one TTL for every key so events/reports never outlive their session; revisit after the demo.
TTL_SECONDS = 7 * 24 * 3600
PREFIX = "ot"


class StoreUnavailable(Exception):
    """Store not configured or not reachable. Endpoints map this to 503."""


class EventConflict(Exception):
    """Same (sessionId, seq) was already stored with different content."""


def _dump(model: BaseModel) -> str:
    # Keep nulls: some fields are required-but-nullable (e.g. Fact.evidenceId).
    return model.model_dump_json(by_alias=True)


class Store:
    def __init__(self, redis: Any):
        self.redis = redis

    def _call(self, method: str, *args: Any, **kwargs: Any) -> Any:
        try:
            return getattr(self.redis, method)(*args, **kwargs)
        except Exception as exc:  # noqa: BLE001 - any client failure becomes a controlled 503
            # Only the error type: messages could echo keys or values (transcripts).
            raise StoreUnavailable(f"store {method} failed: {type(exc).__name__}") from None

    def _put(self, key: str, model: BaseModel) -> None:
        self._call("set", key, _dump(model), ex=TTL_SECONDS)

    def _load(self, key: str, cls: type[BaseModel]) -> Any:
        raw = self._call("get", key)
        return None if raw is None else cls.model_validate_json(raw)

    def save_persona(self, persona: Persona) -> None:
        self._put(f"{PREFIX}:persona:{persona.id}", persona)

    def get_persona(self, persona_id: str) -> Persona | None:
        return self._load(f"{PREFIX}:persona:{persona_id}", Persona)

    def save_session(self, session: Session) -> None:
        self._put(f"{PREFIX}:session:{session.id}", session)

    def get_session(self, session_id: str) -> Session | None:
        return self._load(f"{PREFIX}:session:{session_id}", Session)

    def save_report(self, report: InsightReport) -> None:
        self._put(f"{PREFIX}:session:{report.session_id}:report", report)

    def get_report(self, session_id: str) -> InsightReport | None:
        return self._load(f"{PREFIX}:session:{session_id}:report", InsightReport)

    def append_events(self, session_id: str, events: list[SessionEvent]) -> int:
        """Store events, returns how many were new. Identical retries add nothing.

        HSETNX per seq is atomic in Redis, so concurrent writers can't both win a seq.
        """
        key = f"{PREFIX}:session:{session_id}:events"
        added = 0
        try:
            for event in events:
                if event.session_id != session_id:
                    raise ValueError("event belongs to another session")
                value = _dump(event)
                if self._call("hsetnx", key, str(event.seq), value):
                    added += 1
                    continue
                existing = self._call("hget", key, str(event.seq))
                if json.loads(existing) != json.loads(value):
                    raise EventConflict(f"seq {event.seq} already stored with different content")
        finally:
            # Always (re)set: a conflict or a failed EXPIRE must not leave the hash without TTL,
            # and an identical retry repairs it. EXPIRE on a missing key is a no-op.
            self._call("expire", key, TTL_SECONDS)
        return added

    def get_events(self, session_id: str) -> list[SessionEvent]:
        raw = self._call("hgetall", f"{PREFIX}:session:{session_id}:events") or {}
        events = [SessionEvent.model_validate_json(v) for v in raw.values()]
        return sorted(events, key=lambda e: e.seq)


@lru_cache
def get_store() -> Store:
    from upstash_redis import Redis

    try:
        # Reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
        return Store(Redis.from_env(allow_telemetry=False))
    except Exception:  # noqa: BLE001 - missing env or bad config, same 503
        raise StoreUnavailable("UPSTASH_REDIS_REST_URL / _TOKEN not configured") from None
