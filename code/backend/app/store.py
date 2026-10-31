"""Durable store for personas, sessions, events and reports (Upstash Redis over REST).

Endpoints call `get_store()`; tests pass a fake client to `Store(...)`. Values are camelCase
contract JSON, so what we read back validates against the same models.
"""

import json
import time
from datetime import UTC, datetime
from functools import lru_cache
from typing import Any

from pydantic import BaseModel

from app.contracts import (
    InsightReport,
    Persona,
    PersonaCreate,
    PersonaSummary,
    Session,
    SessionEvent,
)

# shortcut: one TTL for every key so events/reports never outlive their session; revisit after the demo.
TTL_SECONDS = 7 * 24 * 3600
PREFIX = "ot"
PERSONA_LIST_SIZE = 20


# KEYS[1] = events hash, ARGV = ttl, then seq/value pairs.
# Returns per pair "" if inserted, else the value already stored for that seq.
APPEND_EVENTS = """
local out = {}
for i = 2, #ARGV, 2 do
  if redis.call('HSETNX', KEYS[1], ARGV[i], ARGV[i + 1]) == 1 then
    out[#out + 1] = ''
  else
    out[#out + 1] = redis.call('HGET', KEYS[1], ARGV[i])
  end
end
redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
return out
"""


# KEYS[1] = persona index, ARGV = created-at score, persona id, rank to trim up to, ttl.
# NX: saving a persona again must not change when it was created.
INDEX_PERSONA = """
redis.call('ZADD', KEYS[1], 'NX', ARGV[1], ARGV[2])
redis.call('ZREMRANGEBYRANK', KEYS[1], 0, ARGV[3])
redis.call('EXPIRE', KEYS[1], ARGV[4])
"""


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
        args = [str(time.time()), persona.id, str(-PERSONA_LIST_SIZE - 1), str(TTL_SECONDS)]
        self._call("eval", INDEX_PERSONA, keys=[f"{PREFIX}:personas"], args=args)

    def list_personas(self) -> list[PersonaSummary]:
        """Newest first. A persona can expire before its index entry, those are skipped."""
        rows = self._call(
            "zrange", f"{PREFIX}:personas", 0, PERSONA_LIST_SIZE - 1, rev=True, withscores=True
        )
        if not rows:
            return []
        raws = self._call("mget", *[f"{PREFIX}:persona:{persona_id}" for persona_id, _ in rows])
        summaries = []
        for (_, created), raw in zip(rows, raws, strict=True):
            if raw is None:
                continue
            persona = Persona.model_validate_json(raw)
            summaries.append(
                PersonaSummary(
                    id=persona.id,
                    name=persona.name,
                    role=persona.context.job,
                    created_at=datetime.fromtimestamp(created, UTC)
                    .isoformat()
                    .replace("+00:00", "Z"),
                    readiness=persona.readiness,
                )
            )
        return summaries

    def get_persona(self, persona_id: str) -> Persona | None:
        return self._load(f"{PREFIX}:persona:{persona_id}", Persona)

    # The voice persona needs the product material later; the persona itself only keeps facts.
    def save_persona_sources(self, persona_id: str, request: PersonaCreate) -> None:
        self._put(f"{PREFIX}:persona:{persona_id}:sources", request)

    def get_persona_sources(self, persona_id: str) -> PersonaCreate | None:
        return self._load(f"{PREFIX}:persona:{persona_id}:sources", PersonaCreate)

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

        One Lua script does every HSETNX plus the EXPIRE, so Redis runs it atomically:
        concurrent writers can't both win a seq, and no write lands without its TTL.
        """
        if any(e.session_id != session_id for e in events):
            raise ValueError("event belongs to another session")
        if not events:
            return 0
        values = [_dump(e) for e in events]
        args = [str(TTL_SECONDS)]
        for event, value in zip(events, values, strict=True):
            args += [str(event.seq), value]
        stored = self._call(
            "eval", APPEND_EVENTS, keys=[f"{PREFIX}:session:{session_id}:events"], args=args
        )
        added = 0
        for event, value, existing in zip(events, values, stored, strict=True):
            if existing == "":
                added += 1
            elif json.loads(existing) != json.loads(value):
                raise EventConflict(f"seq {event.seq} already stored with different content")
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
