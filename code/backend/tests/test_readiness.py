import json
import threading
import time
from pathlib import Path

import httpx
import openai
import pytest
from fastapi.testclient import TestClient

from app import extract, provider_log, readiness
from app.contracts import Persona, PersonaSource
from app.extract import ExtractionFailed, PersonaDraft, ProbeAnswer, ProviderUnavailable
from app.main import REQUEST_ID_HEADER, app
from app.readiness import PROBES, score_readiness
from app.routers.personas import get_extractor, get_prober
from app.store import Store, get_store
from tests.fakes import FakeRedis

EXAMPLE = json.loads(
    (Path(__file__).parents[2] / "shared" / "examples" / "persona.json").read_text()
)
PERSONA = Persona.model_validate(EXAMPLE | {"readiness": None})
SOURCES = [PersonaSource(kind="miro", text="Quartier-Börse board SENTINEL_BRIEFING")]
# The example's facts in prompt order: which ids are grounded.
FACTS = PERSONA.jobs + PERSONA.pains + PERSONA.objections
GROUNDED = [f"F{i}" for i, f in enumerate(FACTS, 1) if f.label == "grounded"]
GUESSES = [f"F{i}" for i, f in enumerate(FACTS, 1) if f.label == "guess"]
REQUEST = {"language": "de", "sources": [{"kind": "miro", "text": EXAMPLE["evidence"][0]["quote"]}]}


def answer(position="yes", fact_ids=()) -> ProbeAnswer:
    return ProbeAnswer(answer="Ja.", position=position, fact_ids=list(fact_ids))


def always(result):
    return lambda _instructions, _question: result


def score(ask, persona=PERSONA, elapsed=0.0):
    return score_readiness(persona, SOURCES, ask, elapsed)


@pytest.fixture
def client():
    store = Store(FakeRedis())
    draft = PersonaDraft.model_validate(
        {k: v for k, v in EXAMPLE.items() if k in PersonaDraft.model_fields or k == "speechStyle"}
        | {"gender": "f", "face": "Sophie"}
    )
    app.dependency_overrides[get_store] = lambda: store
    app.dependency_overrides[get_extractor] = lambda: lambda _req: draft
    app.dependency_overrides[get_prober] = lambda: always(answer(fact_ids=GROUNDED[:1]))
    yield TestClient(app)
    app.dependency_overrides.clear()


def test_every_probe_runs_twice_against_the_persona_prompt_in_its_language():
    calls = []
    lock = threading.Lock()

    def ask(instructions, question):
        with lock:
            calls.append((instructions, question))
        return answer()

    score(ask, PERSONA.model_copy(update={"language": "en"}))
    assert sorted(question for _, question in calls) == sorted(PROBES["en"] * 2)
    assert len(PROBES["en"]) == len(PROBES["de"]) == 5
    instructions = calls[0][0]
    assert all(call[0] == instructions for call in calls)
    assert f"You are {PERSONA.name}" in instructions  # the real interview prompt
    assert "SENTINEL_BRIEFING" in instructions  # with the product briefing an interview gets
    assert f"F1: {FACTS[0].text}" in instructions


def test_runs_are_parallel():
    # All ten calls must be open at once, or the barrier breaks and the score is None.
    barrier = threading.Barrier(10, timeout=5)

    def ask(_instructions, _question):
        barrier.wait()
        return answer()

    assert score(ask) is not None


def disagreeing_on(questions, fact_ids=GROUNDED[:1]):
    """Answers yes, except that the first run of each given question says no."""
    seen = set()
    lock = threading.Lock()

    def ask(_instructions, question):
        with lock:
            first = question not in seen
            seen.add(question)
        return answer("no" if first and question in questions else "yes", fact_ids)

    return ask


def test_consistency_is_the_share_of_probes_where_both_runs_agree():
    result = score(disagreeing_on(PROBES["de"][:2]))
    assert (result.consistency, result.grounding, result.score) == (0.6, 1.0, 0.6)


@pytest.mark.parametrize(
    ("fact_ids", "counts"),
    [
        ([], False),
        (GUESSES[:1], False),
        (GROUNDED[:1], True),
        (GROUNDED[:1] + GUESSES[:1], False),  # a tie isn't relying on grounded facts
        (GROUNDED[:2] + GUESSES[:1], True),
        (["F999", "made up"], False),  # unknown ids count for nothing
        (["F999", "F998"] + GROUNDED[:1], True),
        (GROUNDED[:1] * 3 + GUESSES[:2], False),  # repeating an id doesn't add weight
    ],
)
def test_grounding_counts_answers_relying_mainly_on_grounded_facts(fact_ids, counts):
    result = score(always(answer(fact_ids=fact_ids)))
    assert result.consistency == 1.0
    assert result.grounding == (1.0 if counts else 0.0)
    assert result.score == result.grounding


def test_labels_come_from_the_persona_not_the_model():
    """A persona without a grounded fact scores 0 whatever the model says it relied on."""
    guessed = [f.model_copy(update={"label": "guess", "evidence_id": None}) for f in PERSONA.jobs]
    persona = PERSONA.model_copy(update={"jobs": guessed, "pains": [], "objections": []})
    assert score(always(answer(fact_ids=["F1"])), persona).score == 0


def test_score_is_the_rounded_product():
    facts = iter([GROUNDED[:1]] * 7 + [[]] * 3)
    lock = threading.Lock()
    positions = disagreeing_on(PROBES["de"][:1])

    def ask(instructions, question):
        with lock:
            fact_ids = next(facts)
        return positions(instructions, question).model_copy(update={"fact_ids": fact_ids})

    result = score(ask)
    assert (result.consistency, result.grounding, result.score) == (0.8, 0.7, 0.56)


@pytest.mark.parametrize(
    "error", [ProviderUnavailable("x"), ExtractionFailed("x"), ValueError("SENTINEL_ERROR")]
)
def test_one_failed_run_means_no_score_and_logs_only_the_type(error, caplog):
    count = []
    lock = threading.Lock()

    def ask(_instructions, _question):
        with lock:
            count.append(1)
            fail = len(count) == 7
        if fail:
            raise error
        return answer(fact_ids=GROUNDED)

    assert score(ask) is None
    assert type(error).__name__ in caplog.text
    assert "SENTINEL" not in caplog.text


def test_budget_ends_a_hanging_probe_without_waiting_for_it(monkeypatch):
    monkeypatch.setattr(readiness, "BUDGET_SECONDS", 0.05)
    release = threading.Event()

    def ask(_instructions, _question):
        release.wait(10)
        return answer()

    started = time.monotonic()
    try:
        assert score(ask) is None
        assert time.monotonic() - started < 5
    finally:
        release.set()


def test_probes_get_only_the_time_extraction_left():
    def never(_instructions, _question):
        raise AssertionError("no time left: must not spend money on probes")

    assert score(never, elapsed=readiness.LATEST_END_SECONDS) is None


def test_slow_extraction_shortens_the_budget():
    release = threading.Event()

    def ask(_instructions, _question):
        release.wait(10)
        return answer()

    started = time.monotonic()
    try:
        assert score(ask, elapsed=readiness.LATEST_END_SECONDS - 0.05) is None
        assert time.monotonic() - started < 5
    finally:
        release.set()


def test_create_returns_and_stores_the_score(client):
    res = client.post("/api/personas", json=REQUEST)
    assert res.status_code == 201
    body = res.json()
    assert body["readiness"] == {"score": 1.0, "consistency": 1.0, "grounding": 1.0}
    assert client.get(f"/api/personas/{body['id']}").json() == body


def test_create_survives_failed_probes_with_null_readiness(client):
    def fail(_instructions, _question):
        raise ProviderUnavailable("down")

    app.dependency_overrides[get_prober] = lambda: fail
    res = client.post("/api/personas", json=REQUEST)
    assert res.status_code == 201
    assert res.json()["readiness"] is None
    assert client.get(f"/api/personas/{res.json()['id']}").json() == res.json()


def test_editing_clears_the_score_without_new_probes(client):
    created = client.post("/api/personas", json=REQUEST).json()
    assert created["readiness"] is not None

    def never(_instructions, _question):
        raise AssertionError("an edit must not call the provider")

    app.dependency_overrides[get_prober] = lambda: never
    res = client.patch(f"/api/personas/{created['id']}", json={"pains": created["pains"][:1]})
    assert res.status_code == 200
    assert res.json()["readiness"] is None
    assert res.json()["version"] == created["version"] + 1
    assert client.get(f"/api/personas/{created['id']}").json()["readiness"] is None


def provider_body(text: str | None) -> dict:
    content = [{"type": "output_text", "text": text, "annotations": []}] if text else []
    return {
        "id": "resp_test",
        "object": "response",
        "created_at": 1,
        "status": "completed",
        "error": None,
        "incomplete_details": None,
        "model": "test-model",
        "output": [
            {
                "id": "msg_test",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": content,
            }
        ],
        "parallel_tool_calls": False,
        "tool_choice": "auto",
        "tools": [],
    }


def use_sdk(monkeypatch, handle):
    """The real SDK and our real parsing, with only the HTTP transport replaced."""
    sdk = openai.OpenAI(
        api_key="test-only",
        max_retries=0,
        http_client=httpx.Client(transport=httpx.MockTransport(handle)),
    )
    monkeypatch.setattr(extract, "_client", lambda: sdk)


PROBE_JSON = json.dumps({"answer": "Ja.", "position": "no", "factIds": ["F1"]})


def test_answer_probe_through_the_sdk_uses_strict_structured_output(monkeypatch):
    calls = []

    def handle(request):
        calls.append(json.loads(request.content))
        return httpx.Response(200, json=provider_body(PROBE_JSON))

    use_sdk(monkeypatch, handle)
    monkeypatch.setenv("OPENAI_MODEL", "probe-test")
    result = extract.answer_probe("INSTRUCTIONS", "QUESTION")
    assert result.position == "no" and result.fact_ids == ["F1"]
    call = calls[0]
    assert (call["model"], call["instructions"], call["input"]) == (
        "probe-test",
        "INSTRUCTIONS",
        "QUESTION",
    )
    assert call["text"]["format"]["strict"] is True
    assert set(call["text"]["format"]["schema"]["properties"]) == {"answer", "position", "factIds"}


def test_answer_probe_maps_refusal_and_outage(monkeypatch):
    use_sdk(monkeypatch, lambda _r: httpx.Response(200, json=provider_body(None)))
    with pytest.raises(ExtractionFailed):
        extract.answer_probe("I", "Q")
    use_sdk(monkeypatch, lambda _r: httpx.Response(429, json={"error": {"message": "slow"}}))
    with pytest.raises(ProviderUnavailable):
        extract.answer_probe("I", "Q")


def test_each_probe_call_has_a_short_timeout_and_logs_the_request_id(client, monkeypatch, caplog):
    timeouts = []

    def handle(request):
        timeouts.append(request.extensions["timeout"]["read"])
        return httpx.Response(200, json=provider_body(PROBE_JSON))

    use_sdk(monkeypatch, handle)
    app.dependency_overrides.pop(get_prober)
    provider_log.logger.addHandler(caplog.handler)
    try:
        res = client.post("/api/personas", json=REQUEST)
    finally:
        provider_log.logger.removeHandler(caplog.handler)
    assert res.json()["readiness"]["consistency"] == 1.0
    assert timeouts == [extract.PROBE_TIMEOUT_SECONDS] * 10
    lines = [json.loads(record.getMessage()) for record in caplog.records]
    assert [line["operation"] for line in lines] == ["readiness_probe"] * 10
    assert {line["request_id"] for line in lines} == {res.headers[REQUEST_ID_HEADER]}
