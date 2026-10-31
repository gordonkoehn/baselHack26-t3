import hashlib
import io
from dataclasses import dataclass
from unittest.mock import Mock

import fakeredis
import pytest
from fastapi.testclient import TestClient
from pypdf import PdfWriter

from app import avatar, extract, rate_limit, realtime
from app.contracts import Persona, Session, SessionEvent, SessionToken
from app.extract import ProviderUnavailable
from app.main import app
from app.routers.guides import get_reviewer
from app.routers.insights import get_debriefer
from app.routers.personas import get_answerer, get_coverage_checker, get_extractor
from app.store import PREFIX, Store, get_store
from tests.fakes import FakeRedis
from tests.test_debrief import load
from tests.test_personas import REQUEST

TOKEN = "/api/sessions/s_live/token"
AVATAR_TOKEN = "/api/sessions/s_live/avatar-token"
WINDOW = rate_limit.WINDOW_SECONDS


def blank_pdf() -> bytes:
    writer = PdfWriter()
    writer.add_blank_page(width=100, height=100)
    buffer = io.BytesIO()
    writer.write(buffer)
    return buffer.getvalue()


# Every paid route, with a request that reaches its provider unless the limit stops it.
PAID = [
    ("/api/personas", "personas", {"json": REQUEST}),
    ("/api/personas/p_1/coverage", "personas", {"json": {"testGoal": "A dashboard"}}),
    (
        "/api/personas/p_1/answers",
        "personas",
        {"json": {"answers": [{"question": "Q", "answer": "A"}]}},
    ),
    ("/api/sources/pdf", "sources", {"content": blank_pdf()}),
    ("/api/sources/image", "sources", {"content": b"\x89PNG\r\n\x1a\n" + b"\0" * 32}),
    ("/api/guides/review", "guides", {"json": {"questions": ["Why?"], "language": "en"}}),
    (TOKEN, "tokens", {}),
    (AVATAR_TOKEN, "tokens", {}),
    ("/api/sessions/s_1/debrief", "debrief", {}),
]


@dataclass
class Context:
    client: TestClient
    redis: FakeRedis
    provider: Mock

    def counters(self) -> dict:
        return {k: v for k, v in self.redis.data.items() if k.startswith("ot:rate:")}


@pytest.fixture
def ctx(monkeypatch):
    monkeypatch.delenv("DEMO_PASSCODE", raising=False)
    monkeypatch.delenv("VERCEL", raising=False)
    monkeypatch.delenv("RATE_LIMIT_MULTIPLIER", raising=False)
    redis = FakeRedis()
    store = Store(redis)
    store.save_persona(Persona.model_validate(load("persona.json")))
    example = load("session.json")
    store.save_session(Session.model_validate({**example, "status": "ended"}))
    store.save_session(Session.model_validate({**example, "id": "s_live", "status": "created"}))
    store.append_events(
        "s_1", [SessionEvent.model_validate(e) for e in load("session-events.json")]
    )
    # The provider is "down": a 503 proves the request got past the limit and reached it.
    provider = Mock(side_effect=ProviderUnavailable("down"))
    monkeypatch.setattr(realtime, "mint_client_secret", provider)
    monkeypatch.setattr(avatar, "mint_session_token", provider)
    monkeypatch.setattr(extract, "transcribe", provider)
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_extractor] = lambda: provider
    app.dependency_overrides[get_debriefer] = lambda: provider
    app.dependency_overrides[get_coverage_checker] = lambda: provider
    app.dependency_overrides[get_answerer] = lambda: provider
    app.dependency_overrides[get_reviewer] = lambda: provider
    yield Context(TestClient(app), redis, provider)
    for dependency in (
        get_extractor,
        get_debriefer,
        get_coverage_checker,
        get_answerer,
        get_reviewer,
    ):
        app.dependency_overrides.pop(dependency)


def limit(monkeypatch, bucket: str, per_ip: int, overall: int) -> None:
    monkeypatch.setitem(rate_limit.LIMITS, bucket, (per_ip, overall))


def from_ip(ip: str) -> dict:
    return {"X-Forwarded-For": ip}


@pytest.mark.parametrize(("route", "bucket", "body"), PAID)
def test_over_the_limit_is_429_and_the_provider_is_not_called(
    ctx, monkeypatch, route, bucket, body
):
    limit(monkeypatch, bucket, 2, 100)
    assert [ctx.client.post(route, **body).status_code for _ in range(2)] == [503, 503]
    assert ctx.provider.call_count == 2

    res = ctx.client.post(route, **body)

    assert res.status_code == 429
    assert res.headers["retry-after"] == str(WINDOW)
    assert res.json()["detail"] == "Too many requests from this network. Try again in 60 min."
    assert ctx.provider.call_count == 2


def test_a_loop_cannot_mint_more_tokens_than_the_table_allows(ctx, monkeypatch):
    per_ip = rate_limit.LIMITS["tokens"][0]
    mint = Mock(return_value=SessionToken(provider="openai-realtime", expires_at="soon"))
    monkeypatch.setattr(realtime, "mint_client_secret", mint)
    codes = [ctx.client.post(TOKEN).status_code for _ in range(per_ip + 5)]
    assert codes == [200] * per_ip + [429] * 5
    assert mint.call_count == per_ip


def test_token_and_avatar_token_share_a_bucket(ctx, monkeypatch):
    limit(monkeypatch, "tokens", 2, 100)
    assert ctx.client.post(TOKEN).status_code == 503
    assert ctx.client.post(AVATAR_TOKEN).status_code == 503
    assert ctx.client.post(TOKEN).status_code == 429
    assert ctx.client.post(AVATAR_TOKEN).status_code == 429


def test_buckets_are_counted_separately(ctx, monkeypatch):
    limit(monkeypatch, "tokens", 1, 100)
    assert ctx.client.post(TOKEN).status_code == 503
    assert ctx.client.post(TOKEN).status_code == 429
    assert ctx.client.post("/api/personas", json=REQUEST).status_code == 503


def test_wrong_passcode_is_refused_before_counting(ctx, monkeypatch):
    monkeypatch.setenv("DEMO_PASSCODE", "right")
    limit(monkeypatch, "tokens", 1, 1)
    for _ in range(3):
        assert ctx.client.post(TOKEN, headers={"X-Demo-Passcode": "wrong"}).status_code == 401
    assert ctx.counters() == {}
    assert ctx.client.post(TOKEN, headers={"X-Demo-Passcode": "right"}).status_code == 503


def test_global_cap_holds_when_the_ip_changes_every_call(ctx, monkeypatch):
    limit(monkeypatch, "tokens", 100, 2)
    codes = [ctx.client.post(TOKEN, headers=from_ip(f"10.0.0.{i}")).status_code for i in range(4)]
    assert codes == [503, 503, 429, 429]
    assert ctx.provider.call_count == 2
    res = ctx.client.post(TOKEN, headers=from_ip("10.0.0.9"))
    assert "this demo" in res.json()["detail"]


def test_requests_over_the_ip_limit_do_not_spend_the_global_budget(ctx, monkeypatch):
    limit(monkeypatch, "tokens", 1, 2)
    for _ in range(5):
        ctx.client.post(TOKEN, headers=from_ip("10.0.0.1"))
    assert ctx.counters()["ot:rate:tokens:all"] == 1
    assert ctx.client.post(TOKEN, headers=from_ip("10.0.0.2")).status_code == 503


def test_each_ip_has_its_own_limit(ctx, monkeypatch):
    limit(monkeypatch, "tokens", 1, 100)
    assert ctx.client.post(TOKEN, headers=from_ip("10.0.0.1")).status_code == 503
    assert ctx.client.post(TOKEN, headers=from_ip("10.0.0.1")).status_code == 429
    assert ctx.client.post(TOKEN, headers=from_ip("10.0.0.2")).status_code == 503


def test_the_first_forwarded_entry_is_the_ip_and_it_is_only_stored_hashed(ctx, monkeypatch):
    limit(monkeypatch, "tokens", 1, 100)
    assert ctx.client.post(TOKEN, headers=from_ip("203.0.113.7, 10.0.0.1")).status_code == 503
    assert ctx.client.post(TOKEN, headers=from_ip(" 203.0.113.7 ,10.0.0.2")).status_code == 429
    digest = hashlib.sha256(b"203.0.113.7").hexdigest()[:16]
    assert f"ot:rate:tokens:ip:{digest}" in ctx.counters()
    assert not any("203.0.113.7" in key for key in ctx.counters())


def test_without_a_forwarded_header_the_client_address_is_used(ctx, monkeypatch):
    limit(monkeypatch, "tokens", 1, 100)
    assert ctx.client.post(TOKEN).status_code == 503
    assert ctx.client.post(TOKEN).status_code == 429
    digest = hashlib.sha256(b"testclient").hexdigest()[:16]
    assert f"ot:rate:tokens:ip:{digest}" in ctx.counters()


def test_refusal_says_how_long_is_left_in_the_window(ctx, monkeypatch):
    limit(monkeypatch, "tokens", 1, 100)
    ctx.client.post(TOKEN)
    assert {ctx.redis.ttl[key] for key in ctx.counters()} == {WINDOW}
    ip_key = next(key for key in ctx.counters() if ":ip:" in key)
    ctx.redis.ttl[ip_key] = 90

    res = ctx.client.post(TOKEN)

    assert res.status_code == 429
    assert res.headers["retry-after"] == "90"
    assert "Try again in 2 min." in res.json()["detail"]


def test_count_hit_script_starts_the_window_once():
    """FakeRedis only imitates the script, so this runs the real Lua in fakeredis's engine."""

    class LuaClient:
        eval = staticmethod(lambda script, keys, args: lua.eval(script, len(keys), *keys, *args))

    lua = fakeredis.FakeRedis()
    store = Store(LuaClient())
    key = f"{PREFIX}:rate:tokens:all"

    count, seconds_left = store.count_hit("tokens:all", WINDOW)
    assert count == 1
    assert WINDOW - 60 < seconds_left <= WINDOW

    lua.expire(key, 90)  # later in the window: more hits must not push the reset back
    count, seconds_left = store.count_hit("tokens:all", WINDOW)
    assert count == 2
    assert 30 < seconds_left <= 90

    lua.delete(key)  # the window ended: the next hit starts a new one, with its own expiry
    count, seconds_left = store.count_hit("tokens:all", WINDOW)
    assert count == 1
    assert WINDOW - 60 < seconds_left <= WINDOW


def test_multiplier_scales_both_limits(ctx, monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_MULTIPLIER", "3")
    limit(monkeypatch, "tokens", 1, 2)
    same_ip = [ctx.client.post(TOKEN).status_code for _ in range(4)]
    assert same_ip == [503, 503, 503, 429]
    others = [ctx.client.post(TOKEN, headers=from_ip(f"10.0.0.{i}")).status_code for i in range(4)]
    assert others == [503, 503, 503, 429]


@pytest.mark.parametrize("value", ["", "abc", "0", "-2", "inf", "nan"])
def test_bad_multiplier_keeps_the_normal_limits(ctx, monkeypatch, value):
    monkeypatch.setenv("RATE_LIMIT_MULTIPLIER", value)
    limit(monkeypatch, "tokens", 1, 100)
    assert [ctx.client.post(TOKEN).status_code for _ in range(2)] == [503, 429]


def test_a_huge_multiplier_is_capped_instead_of_crashing(ctx, monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_MULTIPLIER", "1e308")
    limit(monkeypatch, "tokens", 1, 1)
    calls = [ctx.client.post(TOKEN).status_code for _ in range(1001)]
    assert set(calls[:1000]) == {503} and calls[1000] == 429


def test_a_tiny_multiplier_still_allows_one_call(ctx, monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_MULTIPLIER", "0.001")
    limit(monkeypatch, "tokens", 2, 100)
    assert [ctx.client.post(TOKEN).status_code for _ in range(2)] == [503, 429]


@pytest.mark.parametrize(("route", "bucket", "body"), PAID)
def test_counting_failure_is_503_and_the_provider_is_not_called(
    ctx, monkeypatch, route, bucket, body
):
    monkeypatch.setattr(ctx.redis, "eval", Mock(side_effect=ConnectionError("down")))
    res = ctx.client.post(route, **body)
    assert res.status_code == 503 and res.json() == {"detail": "store unavailable"}
    assert ctx.provider.call_count == 0


def test_unconfigured_store_is_503_on_a_route_that_keeps_no_data(ctx, monkeypatch):
    monkeypatch.delenv("UPSTASH_REDIS_REST_URL", raising=False)
    monkeypatch.delenv("UPSTASH_REDIS_REST_TOKEN", raising=False)
    app.dependency_overrides.pop(get_store)
    get_store.cache_clear()
    png = b"\x89PNG\r\n\x1a\n" + b"\0" * 32
    assert ctx.client.post("/api/sources/image", content=png).status_code == 503
    assert ctx.provider.call_count == 0
