"""Durable store for personas, sessions, events and reports (Upstash Redis over REST).

Endpoints call `get_store()`; tests pass a fake client to `Store(...)`. Values are camelCase
contract JSON, so what we read back validates against the same models.
"""

import base64
import json
from functools import lru_cache
from typing import Any, Literal

from pydantic import BaseModel

from app.contracts import (
    CoverageReport,
    InsightReport,
    Persona,
    PersonaCreate,
    Session,
    SessionEvent,
)

# shortcut: one TTL for every key so events/reports never outlive their session; revisit after the demo.
TTL_SECONDS = 7 * 24 * 3600
PREFIX = "ot"


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

# KEYS[1] = counter, ARGV[1] = window seconds. Returns {count, seconds left in the window}.
# Atomic, so a counter never exists without its expiry; later hits don't extend the window.
COUNT_HIT = """
local count = redis.call('INCR', KEYS[1])
if count == 1 then
  redis.call('EXPIRE', KEYS[1], tonumber(ARGV[1]))
end
return {count, redis.call('TTL', KEYS[1])}
"""


# KEYS[1] = session JSON; ARGV = expected raw JSON, replacement JSON, TTL.
# Compare exact bytes atomically. Never decode/re-encode unrelated fields in Lua:
# cjson can lose numeric precision and change empty arrays into objects.
TRANSITION_SESSION = """
local raw = redis.call('GET', KEYS[1])
if not raw then return {'missing', ''} end
if raw ~= ARGV[1] then return {'retry', raw} end
if raw ~= ARGV[2] then
  redis.call('SET', KEYS[1], ARGV[2], 'EX', tonumber(ARGV[3]))
end
return {'ok', ARGV[2]}
"""
SESSION_TRANSITION_ATTEMPTS = 16


class SessionConflict(Exception):
    """The requested status would move a session backwards."""


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

    # The picture as base64 next to its type; kept apart so persona reads stay small.
    def save_photo(self, persona_id: str, mime: str, data: bytes) -> None:
        value = json.dumps({"mime": mime, "data": base64.b64encode(data).decode()})
        self._call("set", f"{PREFIX}:photo:{persona_id}", value, ex=TTL_SECONDS)

    def get_photo(self, persona_id: str) -> tuple[str, bytes] | None:
        raw = self._call("get", f"{PREFIX}:photo:{persona_id}")
        if raw is None:
            return None
        value = json.loads(raw)
        return value["mime"], base64.b64decode(value["data"])

    # Only the last check per persona: a re-check compares against it so the score stays stable.
    def save_coverage(self, report: CoverageReport) -> None:
        self._put(f"{PREFIX}:coverage:{report.persona_id}", report)

    def get_coverage(self, persona_id: str) -> CoverageReport | None:
        return self._load(f"{PREFIX}:coverage:{persona_id}", CoverageReport)

    # The voice persona needs the product material later; the persona itself only keeps facts.
    def save_persona_sources(self, persona_id: str, request: PersonaCreate) -> None:
        self._put(f"{PREFIX}:persona:{persona_id}:sources", request)

    def get_persona_sources(self, persona_id: str) -> PersonaCreate | None:
        return self._load(f"{PREFIX}:persona:{persona_id}:sources", PersonaCreate)

    def save_session(self, session: Session) -> None:
        self._put(f"{PREFIX}:session:{session.id}", session)

    def get_session(self, session_id: str) -> Session | None:
        return self._load(f"{PREFIX}:session:{session_id}", Session)

    def transition_session(
        self, session_id: str, status: Literal["live", "ended"], at: str
    ) -> Session | None:
        key = f"{PREFIX}:session:{session_id}"
        raw = self._call("get", key)
        for _ in range(SESSION_TRANSITION_ATTEMPTS):
            if raw is None:
                return None
            session = Session.model_validate_json(raw)
            if session.status == status:
                updated = raw  # Idempotence must not refresh the TTL or timestamps.
            elif session.status == "created" or (session.status == "live" and status == "ended"):
                # Prepare JSON in Python, preserving nulls, lists, Unicode and numeric precision.
                fields = json.loads(raw)
                fields["status"] = status
                fields["startedAt" if status == "live" else "endedAt"] = at
                updated = json.dumps(fields, ensure_ascii=False, separators=(",", ":"))
            else:
                raise SessionConflict(f"cannot go from {session.status} to {status}")
            result, value = self._call(
                "eval",
                TRANSITION_SESSION,
                keys=[key],
                args=[raw, updated, str(TTL_SECONDS)],
            )
            if result == "missing":
                return None
            if result == "ok":
                return Session.model_validate_json(value)
            # Another writer won. Revalidate its exact snapshot before attempting any write.
            raw = value
        raise StoreUnavailable("session transition contention limit exceeded")

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

    def count_hit(self, name: str, window_seconds: int) -> tuple[int, int]:
        """Counts one hit in a fixed window, returns (hits so far, seconds until it resets)."""
        count, seconds_left = self._call(
            "eval", COUNT_HIT, keys=[f"{PREFIX}:rate:{name}"], args=[str(window_seconds)]
        )
        return int(count), int(seconds_left)


@lru_cache
def get_store() -> Store:
    from upstash_redis import Redis

    try:
        # Reads UPSTASH_REDIS_REST_URL / UPSTASH_REDIS_REST_TOKEN.
        return Store(Redis.from_env(allow_telemetry=False))
    except Exception:  # noqa: BLE001 - missing env or bad config, same 503
        raise StoreUnavailable("UPSTASH_REDIS_REST_URL / _TOKEN not configured") from None
