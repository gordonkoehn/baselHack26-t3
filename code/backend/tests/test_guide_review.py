import json
from pathlib import Path
from types import SimpleNamespace

import httpx
import openai
import pytest
from fastapi.testclient import TestClient

from app import extract, guide_review
from app.contracts import GuideReview, GuideReviewRequest
from app.extract import ExtractionFailed, ProviderUnavailable
from app.main import app
from app.routers.guides import get_reviewer

EXAMPLE = json.loads(
    (Path(__file__).parents[2] / "shared" / "examples" / "guide-review.json").read_text()
)
REVIEW = GuideReview.model_validate(EXAMPLE)
QUESTIONS = [item["question"] for item in EXAMPLE["items"]]
PAY_REWRITE = "Tell me about the last time you paid for something like this."
client = TestClient(app)


def request(questions=QUESTIONS, language="en"):
    return GuideReviewRequest(questions=questions, language=language)


def use_output(monkeypatch, parsed, status="completed"):
    """Replace the provider with a fixed parsed answer; returns the recorded parse() calls."""
    calls = []

    def parse(**kwargs):
        calls.append(kwargs)
        return SimpleNamespace(output_parsed=parsed, status=status)

    client_ = SimpleNamespace(responses=SimpleNamespace(parse=parse))
    monkeypatch.setattr(extract, "_client", lambda: client_)
    return calls


def review_of(*items):
    return GuideReview.model_validate(
        {"items": [{"question": q, "issues": i, "rewrite": r} for q, i, r in items]}
    )


def test_mom_test_example_comes_back_flagged_with_an_open_rewrite(monkeypatch):
    calls = use_output(monkeypatch, REVIEW)
    res = client.post("/api/guides/review", json={"questions": QUESTIONS, "language": "en"})
    assert res.status_code == 200
    assert res.json() == EXAMPLE
    pay = res.json()["items"][0]
    assert pay["question"] == "Would you pay 10 CHF for this?"
    assert "hypothetical" in pay["issues"] and pay["rewrite"] == PAY_REWRITE
    assert json.loads(calls[0]["input"]) == {"questions": QUESTIONS}


def test_prompt_defines_every_issue_and_asks_for_the_requested_language(monkeypatch):
    calls = use_output(monkeypatch, review_of(("Warum?", [], None)))
    guide_review.review_guide(request(["Warum?"], "de"))
    for issue in ("leading", "hypothetical", "closed", "pitch"):
        assert f"- {issue}:" in calls[0]["instructions"]
    assert "German" in calls[0]["instructions"]
    assert "Would you pay 10 CHF for this?" in calls[0]["instructions"]


def test_a_real_sdk_call_uses_strict_structured_output(monkeypatch):
    calls = []

    def handle(http_request):
        calls.append(json.loads(http_request.content))
        return httpx.Response(
            200,
            json={
                "id": "resp_1",
                "object": "response",
                "created_at": 1,
                "model": "gpt-test",
                "status": "completed",
                "parallel_tool_calls": False,
                "tool_choice": "auto",
                "tools": [],
                "output": [
                    {
                        "id": "msg_1",
                        "type": "message",
                        "role": "assistant",
                        "status": "completed",
                        "content": [
                            {
                                "type": "output_text",
                                "annotations": [],
                                "text": json.dumps(EXAMPLE),
                            }
                        ],
                    }
                ],
            },
        )

    sdk = openai.OpenAI(
        api_key="test-only",
        max_retries=0,
        http_client=httpx.Client(transport=httpx.MockTransport(handle)),
    )
    monkeypatch.setattr(extract, "_client", lambda: sdk)
    assert guide_review.review_guide(request()) == REVIEW
    assert calls[0]["text"]["format"]["strict"] is True
    assert set(calls[0]["text"]["format"]["schema"]["properties"]) == {"items"}


@pytest.mark.parametrize(
    "items",
    [
        [(QUESTIONS[0], ["closed"], "x")],
        [(QUESTIONS[1], [], None), (QUESTIONS[0], ["closed"], "x")],
        [(QUESTIONS[0], ["closed"], "x"), ("Another question?", [], None)],
    ],
    ids=["dropped", "reordered", "changed"],
)
def test_output_that_does_not_pair_with_the_questions_is_rejected(monkeypatch, items):
    use_output(monkeypatch, review_of(*items))
    with pytest.raises(ExtractionFailed):
        guide_review.review_guide(request())


def test_whitespace_changes_in_the_echo_still_return_the_callers_text(monkeypatch):
    use_output(monkeypatch, review_of(("Do you recycle?", ["closed"], "x")))
    review = guide_review.review_guide(request(["Do you  recycle?"]))
    assert review.items[0].question == "Do you  recycle?"


def test_rewrite_is_normalized_to_fit_the_one_question_per_line_guide(monkeypatch):
    use_output(
        monkeypatch,
        review_of(
            ("A?", ["closed", "closed", "pitch"], "  Tell me\nabout  it. "),
            ("B?", [], "A pointless rewording."),
            ("C?", ["pitch"], "   "),
        ),
    )
    items = guide_review.review_guide(request(["A?", "B?", "C?"])).items
    assert (items[0].issues, items[0].rewrite) == (["closed", "pitch"], "Tell me about it.")
    assert (items[1].issues, items[1].rewrite) == ([], None)
    assert (items[2].issues, items[2].rewrite) == (["pitch"], None)


@pytest.mark.parametrize(
    "parsed,status", [(None, "completed"), (REVIEW, "incomplete")], ids=["refusal", "incomplete"]
)
def test_unusable_response_fails(monkeypatch, parsed, status):
    use_output(monkeypatch, parsed, status)
    with pytest.raises(ExtractionFailed):
        guide_review.review_guide(request())


def test_parser_failure_inside_the_sdk_fails_cleanly(monkeypatch):
    def parse(**_kwargs):
        raise json.JSONDecodeError("bad", "doc", 0)

    bad = SimpleNamespace(responses=SimpleNamespace(parse=parse))
    monkeypatch.setattr(extract, "_client", lambda: bad)
    with pytest.raises(ExtractionFailed):
        guide_review.review_guide(request())


def test_missing_key_is_503(monkeypatch):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)
    extract._client.cache_clear()
    res = client.post("/api/guides/review", json={"questions": ["Why?"], "language": "en"})
    assert res.status_code == 503


@pytest.mark.parametrize(
    "error,code", [(ProviderUnavailable("x"), 503), (ExtractionFailed("x"), 502)]
)
def test_router_maps_failures(error, code):
    def reviewer(_request):
        raise error

    app.dependency_overrides[get_reviewer] = lambda: reviewer
    try:
        res = client.post("/api/guides/review", json={"questions": ["Why?"], "language": "en"})
    finally:
        del app.dependency_overrides[get_reviewer]
    assert res.status_code == code


@pytest.mark.parametrize(
    "body",
    [
        {"questions": [], "language": "en"},
        {"questions": ["   "], "language": "en"},
        {"questions": ["x" * 501], "language": "en"},
        {"questions": ["Why?"] * 51, "language": "en"},
        {"questions": ["Why?"], "language": "fr"},
        {"questions": ["Why?"]},
    ],
    ids=["empty", "blank", "too-long", "too-many", "bad-language", "no-language"],
)
def test_bad_bodies_are_422_without_a_provider_call(monkeypatch, body):
    calls = use_output(monkeypatch, REVIEW)
    assert client.post("/api/guides/review", json=body).status_code == 422
    assert calls == []
