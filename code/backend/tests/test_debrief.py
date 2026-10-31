import json
from datetime import UTC, datetime
from pathlib import Path

import httpx
import openai
import pytest

from app import debrief, extract
from app.contracts import Persona, Session, SessionEvent
from app.extract import DebriefDraft, ExtractionFailed, ProviderUnavailable

EXAMPLES = Path(__file__).parents[2] / "shared" / "examples"


def load(name: str):
    return json.loads((EXAMPLES / name).read_text())


@pytest.fixture
def inputs():
    session = Session.model_validate({**load("session.json"), "status": "ended"})
    persona = Persona.model_validate(load("persona.json"))
    events = [SessionEvent.model_validate(e) for e in load("session-events.json")]
    examples = load("insight-report.json")["questions"]
    draft = DebriefDraft.model_validate(
        {
            "questions": [
                {**examples[1], "question": session.interview_guide[0]},
                {**examples[0], "question": session.interview_guide[1]},
                {
                    "question": session.interview_guide[2],
                    "signal": "supports",
                    "insights": [],
                    "followUps": ["Ask real customers about their last subscription renewal."],
                },
            ]
        }
    )
    return session, persona, events, draft


def test_preserves_guide_quotes_followups_and_assigns_server_metadata(inputs):
    session, persona, events, draft = inputs
    start = datetime.now(UTC)
    report = debrief.build_report(session, persona, events, draft)
    assert report.session_id == session.id
    assert start <= datetime.fromisoformat(report.generated_at) <= datetime.now(UTC)
    assert report.generated_at.endswith("Z")
    assert [q.question for q in report.questions] == session.interview_guide
    assert report.questions[2].signal == "unclear" and report.questions[2].insights == []
    assert [q.follow_ups for q in report.questions] == [q.follow_ups for q in draft.questions]
    assert report.questions[0].insights[0].quote == draft.questions[0].insights[0].quote
    assert set(report.model_dump(by_alias=True)) == {"sessionId", "generatedAt", "questions"}


@pytest.mark.parametrize("signal", ["supports", "contradicts", "unclear"])
def test_supported_signals_survive_validation(inputs, signal):
    session, persona, events, draft = inputs
    draft.questions[0].signal = signal
    assert debrief.build_report(session, persona, events, draft).questions[0].signal == signal


def test_arbitrary_saved_guide_is_used_verbatim_including_repeated_questions(inputs):
    session, persona, events, draft = inputs
    session.interview_guide = ["Custom question?  ", "Custom question?  ", "A different topic?"]
    for question, text in zip(draft.questions, session.interview_guide, strict=True):
        question.question = text
    report = debrief.build_report(session, persona, events, draft)
    assert [q.question for q in report.questions] == session.interview_guide


def test_exact_contiguous_substring_is_allowed_without_normalization(inputs):
    session, persona, events, draft = inputs
    events[5].data["text"] = "Prefix.  Exact\n  spacing. Suffix."
    draft.questions[0].insights[0].quote = "  Exact\n  spacing."
    report = debrief.build_report(session, persona, events, draft)
    assert report.questions[0].insights[0].quote == "  Exact\n  spacing."


@pytest.mark.parametrize(
    "quote",
    [
        "",
        " \n\t ",
        "Nobody said this.",
        "Moment, ich hab doch alles ins Projekt gegeben?\nDa steht sechs und sechs.",
        "Moment, ... Da steht sechs und sechs.",
        "moment, ich hab doch alles ins projekt gegeben? da steht sechs und sechs.",
    ],
)
def test_invalid_quotes_drop_only_that_insight(inputs, quote):
    session, persona, events, draft = inputs
    draft.questions[0].insights[0].quote = quote
    report = debrief.build_report(session, persona, events, draft)
    # The only insight of that question is gone, so nothing supports the signal anymore.
    assert report.questions[0].insights == [] and report.questions[0].signal == "unclear"
    assert report.questions[0].follow_ups == draft.questions[0].follow_ups
    assert len(report.questions[1].insights) == 1


@pytest.mark.parametrize("turn", [2, 1])
def test_interviewer_and_caption_turns_cannot_supply_quotes(inputs, turn):
    session, persona, events, draft = inputs
    insight = draft.questions[0].insights[0]
    insight.turn_seq = turn
    insight.quote = events[turn - 1].data.get("text", events[0].data["caption"])
    assert debrief.build_report(session, persona, events, draft).questions[0].insights == []


def test_real_persona_quote_with_a_wrong_turn_is_moved_to_its_turn(inputs):
    session, persona, events, draft = inputs
    insight = draft.questions[0].insights[0]
    right = insight.turn_seq
    insight.turn_seq = 999
    assert (
        debrief.build_report(session, persona, events, draft).questions[0].insights[0].turn_seq
        == right
    )


def test_one_bad_quote_among_many_keeps_the_good_ones(inputs):
    # The real failure: one sentence from the persona's sources, eight correct interview quotes.
    session, persona, events, draft = inputs
    good = draft.questions[0].insights[0]
    draft.questions[0].insights = [good.model_copy(update={"id": f"g{n}"}) for n in range(8)] + [
        good.model_copy(update={"id": "bad", "quote": persona.evidence[0].quote})
    ]
    report = debrief.build_report(session, persona, events, draft)
    assert [i.id for i in report.questions[0].insights] == [f"g{n}" for n in range(8)]
    assert report.questions[0].signal == draft.questions[0].signal


def test_all_bad_quotes_leave_every_question_unclear(inputs):
    session, persona, events, draft = inputs
    for question in draft.questions:
        for insight in question.insights:
            insight.quote = "Nobody said this."
    report = debrief.build_report(session, persona, events, draft)
    assert all(q.signal == "unclear" and q.insights == [] for q in report.questions)


def test_quote_from_a_different_persona_turn_is_moved_there(inputs):
    session, persona, events, draft = inputs
    insight = draft.questions[0].insights[0]
    other = next(
        e for e in events if e.seq != insight.turn_seq and e.data.get("speaker") == "persona"
    )
    insight.quote = other.data["text"]
    report = debrief.build_report(session, persona, events, draft)
    assert report.questions[0].insights[0].turn_seq == other.seq


@pytest.mark.parametrize("same_question", [False, True])
def test_insight_ids_must_be_unique_across_the_report(inputs, same_question):
    session, persona, events, draft = inputs
    insight = draft.questions[0].insights[0]
    if same_question:
        draft.questions[0].insights.append(insight.model_copy())
    else:
        draft.questions[1].insights[0].id = insight.id
    with pytest.raises(ExtractionFailed, match="duplicate"):
        debrief.build_report(session, persona, events, draft)


@pytest.mark.parametrize("change", ["missing", "extra", "reordered", "reworded"])
def test_questions_must_match_the_entire_saved_guide(inputs, change):
    session, persona, events, draft = inputs
    if change == "missing":
        draft.questions.pop()
    elif change == "extra":
        draft.questions.append(draft.questions[0].model_copy(deep=True))
    elif change == "reordered":
        draft.questions.reverse()
    else:
        draft.questions[0].question += " altered"
    with pytest.raises(ExtractionFailed, match="questions"):
        debrief.build_report(session, persona, events, draft)


def prepare_grounded(inputs):
    session, persona, events, draft = inputs
    insight = draft.questions[0].insights[0]
    insight.label = "grounded"
    insight.theme = persona.jobs[0].text
    insight.evidence_id = persona.jobs[0].evidence_id
    insight.quote = f"I remember: {persona.evidence[0].quote} That is my experience."
    events[5].data["text"] = insight.quote
    return session, persona, events, draft


@pytest.mark.parametrize("fact_list", ["jobs", "pains", "objections"])
def test_grounded_fact_with_real_evidence_is_preserved_from_any_fact_list(inputs, fact_list):
    session, persona, events, draft = prepare_grounded(inputs)
    fact = persona.jobs[0].model_copy()
    persona.jobs, persona.pains, persona.objections = [], [], []
    setattr(persona, fact_list, [fact])
    insight = debrief.build_report(session, persona, events, draft).questions[0].insights[0]
    assert insight.label == "grounded" and insight.evidence_id == fact.evidence_id


@pytest.mark.parametrize(
    "change",
    [
        "missing_id",
        "unknown_id",
        "unrelated_theme",
        "fact_is_guess",
        "different_fact_id",
        "no_evidence",
        "null_quote",
        "blank_quote",
        "duplicate_evidence",
        "provider_guess",
    ],
)
def test_unsupported_source_labels_are_downgraded_without_dropping_quotes(inputs, change):
    session, persona, events, draft = prepare_grounded(inputs)
    insight = draft.questions[0].insights[0]
    if change == "missing_id":
        insight.evidence_id = None
    elif change == "unknown_id":
        insight.evidence_id = "e_missing"
    elif change == "unrelated_theme":
        insight.theme = "Matching proves retention will increase"
    elif change == "fact_is_guess":
        persona.jobs[0].label = "guess"
    elif change == "different_fact_id":
        persona.jobs[0].evidence_id = "e_other"
    elif change == "no_evidence":
        persona.evidence = []
    elif change in ("null_quote", "blank_quote"):
        persona.evidence[0].quote = {"null_quote": None, "blank_quote": " \n "}[change]
    elif change == "duplicate_evidence":
        persona.evidence.append(persona.evidence[0].model_copy())
    else:
        insight.label = "guess"
    result = debrief.build_report(session, persona, events, draft).questions[0].insights[0]
    assert result.label == "guess" and result.evidence_id is None
    assert result.quote == insight.quote


def prepare_reworded(inputs):
    """Grounded citation of a real fact: theme reworded, persona's answer without the source quote."""
    session, persona, events, draft = inputs
    insight = draft.questions[0].insights[0]
    insight.label = "grounded"
    insight.theme = "Wants the collection point off her to-do list"
    insight.evidence_id = persona.jobs[0].evidence_id
    assert insight.theme != persona.jobs[0].text
    assert persona.evidence[0].quote not in insight.quote
    return session, persona, events, draft


def test_reworded_theme_citing_a_real_grounded_fact_stays_grounded(inputs):
    session, persona, events, draft = prepare_reworded(inputs)
    result = debrief.build_report(session, persona, events, draft).questions[0].insights[0]
    assert result.label == "grounded" and result.evidence_id == persona.jobs[0].evidence_id


def test_reworded_german_theme_matches_regardless_of_case(inputs):
    session, persona, events, draft = prepare_reworded(inputs)
    persona.jobs[0].text = "Punkteprogramme zahlen zu wenig für den grossen Aufwand"
    draft.questions[0].insights[0].theme = "Der AUFWAND lohnt sich bei Punkteprogramme nie"
    result = debrief.build_report(session, persona, events, draft).questions[0].insights[0]
    assert result.label == "grounded"


@pytest.mark.parametrize(
    ("fact", "theme"),
    [("Zu teuer", "Findet das Angebot teuer"), ("Too dear", "Too dear")],
)
def test_short_facts_can_still_be_matched(inputs, fact, theme):
    session, persona, events, draft = prepare_reworded(inputs)
    persona.jobs[0].text = fact
    draft.questions[0].insights[0].theme = theme
    result = debrief.build_report(session, persona, events, draft).questions[0].insights[0]
    assert result.label == "grounded"


@pytest.mark.parametrize(
    "change",
    [
        "made_up_id",
        "topic_only",
        "function_words_only",
        "no_content_words",
        "fact_is_guess",
        "other_fact_says_it",
        "null_quote",
        "provider_guess",
    ],
)
def test_reworded_theme_without_a_real_matching_citation_is_a_guess(inputs, change):
    session, persona, events, draft = prepare_reworded(inputs)
    insight = draft.questions[0].insights[0]
    if change == "made_up_id":
        insight.evidence_id = "e_made_up"
    elif change == "topic_only":
        insight.theme = "Unsure about the collection fee"
    elif change == "function_words_only":
        persona.jobs[0].text = "Would really rather not, without their consent"
        insight.theme = "Without matching their offer is really dull"
    elif change == "no_content_words":
        persona.jobs[0].text = "Too dear"
        insight.theme = "Too dear for now"
    elif change == "fact_is_guess":
        persona.jobs[0].label = "guess"
    elif change == "other_fact_says_it":
        # The wording matches a fact, but that fact cites nothing, so the id does not back it.
        persona.jobs[1].text = insight.theme
        persona.jobs[0].text = "Something else entirely"
        persona.pains[0].text = "Something else entirely"
    elif change == "null_quote":
        persona.evidence[0].quote = None
    else:
        insight.label = "guess"
    result = debrief.build_report(session, persona, events, draft).questions[0].insights[0]
    assert result.label == "guess" and result.evidence_id is None


def test_grounded_citation_does_not_loosen_quote_verification(inputs):
    # A source passage the persona never said stays unquotable, however good the citation is.
    session, persona, events, draft = prepare_reworded(inputs)
    draft.questions[0].insights[0].quote = persona.evidence[0].quote
    assert debrief.build_report(session, persona, events, draft).questions[0].insights == []


def test_prompt_matches_the_source_label_rule():
    prompt = " ".join(extract.DEBRIEF_INSTRUCTIONS.split())
    assert "exactly equals" not in prompt
    assert "substring of the insight quote" not in prompt
    assert "must reuse at least two of its key words unchanged" in prompt
    assert "never make up an evidenceId" in prompt


def test_strict_revalidation_rejects_unvalidated_provider_data(inputs):
    session, persona, events, draft = inputs
    draft.questions[0].insights[0] = (
        draft.questions[0].insights[0].model_copy(update={"turn_seq": "6"})
    )
    with (
        pytest.warns(UserWarning, match="serializer warnings"),
        pytest.raises(ExtractionFailed, match="invalid"),
    ):
        debrief.build_report(session, persona, events, draft)


def response_body(draft: DebriefDraft) -> dict:
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
                "content": [
                    {
                        "type": "output_text",
                        "text": draft.model_dump_json(by_alias=True),
                        "annotations": [],
                    }
                ],
            }
        ],
    }


def mock_provider(monkeypatch, body: dict | str, *, code: int = 200, timeout: bool = False):
    calls: list[dict] = []

    def handle(request: httpx.Request) -> httpx.Response:
        calls.append(json.loads(request.content))
        if timeout:
            raise httpx.ReadTimeout("private provider detail", request=request)
        if isinstance(body, str):
            return httpx.Response(code, text=body)
        return httpx.Response(code, json=body)

    client = openai.OpenAI(
        api_key="test-only",
        max_retries=0,
        http_client=httpx.Client(transport=httpx.MockTransport(handle)),
    )
    monkeypatch.setattr(extract, "_client", lambda: client)
    return calls


def test_sdk_structured_output_uses_existing_model_and_supplies_saved_data(inputs, monkeypatch):
    session, persona, events, draft = inputs
    monkeypatch.setenv("OPENAI_MODEL", "debrief-test")
    calls = mock_provider(monkeypatch, response_body(draft))
    assert extract.extract_debrief(session, persona, events) == draft
    call = calls[0]
    assert call["model"] == "debrief-test"
    assert call["text"]["format"]["strict"] is True
    assert set(call["text"]["format"]["schema"]["properties"]) == {"questions"}
    data = json.loads(call["input"])
    assert data["interviewGuide"] == session.interview_guide
    assert data["events"] == [event.model_dump(by_alias=True) for event in events]
    assert data["persona"] == persona.model_dump(by_alias=True)
    assert "real-customer validation" in call["instructions"]


def test_debrief_uses_default_model_without_override(inputs, monkeypatch):
    session, persona, events, draft = inputs
    monkeypatch.delenv("OPENAI_MODEL", raising=False)
    calls = mock_provider(monkeypatch, response_body(draft))
    extract.extract_debrief(session, persona, events)
    assert calls[0]["model"] == extract.DEFAULT_MODEL


def test_debrief_sends_concrete_theme_and_per_question_quote_rules(inputs, monkeypatch):
    session, persona, events, draft = inputs
    calls = mock_provider(monkeypatch, response_body(draft))
    extract.extract_debrief(session, persona, events)
    instructions = calls[0]["instructions"]
    assert "short, concrete finding in the persona's words, supported by its quote" in instructions
    assert "not a restatement of the question or a generic topic label" in instructions
    assert "Do not invent a finding to fill a slot" in instructions
    assert "Within each question, use each quote at most once" in instructions
    assert "combine insights that rely on the same quote" in instructions
    assert "keep useful followUps" in instructions
    assert "does not prohibit reuse across different questions" in instructions


def test_debrief_defines_the_signal_for_open_prompts(inputs, monkeypatch):
    # The guide check's rewrites are open prompts, which have no yes or no answer.
    session, persona, events, draft = inputs
    calls = mock_provider(monkeypatch, response_body(draft))
    extract.extract_debrief(session, persona, events)
    instructions = calls[0]["instructions"]
    assert "supports means the findings say yes" in instructions
    assert "For an open prompt with no yes or no answer" in instructions
    assert "contradicts means the persona says it never happened" in instructions


@pytest.mark.parametrize(
    "change",
    [
        "incomplete",
        "incomplete_message",
        "failed",
        "error",
        "incomplete_details",
        "refusal",
        "mixed_refusal",
        "null",
        "json",
        "shape",
        "wrong_type",
        "text_response",
        "null_output",
        "null_output_item",
        "noniterable_output",
    ],
)
def test_sdk_rejects_incomplete_refused_or_invalid_output(inputs, monkeypatch, change):
    session, persona, events, draft = inputs
    body = response_body(draft)
    content = body["output"][0]["content"]
    if change in ("incomplete", "failed"):
        body["status"] = change
    elif change == "incomplete_message":
        body["output"][0]["status"] = "incomplete"
    elif change == "error":
        body["error"] = {"code": "server_error", "message": "private detail"}
    elif change == "incomplete_details":
        body["incomplete_details"] = {"reason": "max_output_tokens"}
    elif change in ("refusal", "mixed_refusal"):
        if change == "refusal":
            content.clear()
        content.append({"type": "refusal", "refusal": "private detail"})
    elif change == "null":
        body["output"] = []
    elif change == "text_response":
        body = "private provider detail"
    elif change == "null_output":
        body["output"] = None
    elif change == "null_output_item":
        body["output"] = [None]
    elif change == "noniterable_output":
        body["output"] = 1
    elif change == "wrong_type":
        data = draft.model_dump(by_alias=True)
        data["questions"][0]["insights"][0]["turnSeq"] = "6"
        content[0]["text"] = json.dumps(data)
    else:
        content[0]["text"] = "{broken" if change == "json" else '{"questions": null}'
    mock_provider(monkeypatch, body)
    with pytest.raises(ExtractionFailed) as error:
        extract.extract_debrief(session, persona, events)
    assert "private" not in str(error.value)


@pytest.mark.parametrize("code", [401, 429, 500])
def test_sdk_provider_service_errors_reuse_unavailable_mapping(inputs, monkeypatch, code):
    session, persona, events, _draft = inputs
    mock_provider(monkeypatch, {"error": {"message": "private detail"}}, code=code)
    with pytest.raises(ProviderUnavailable):
        extract.extract_debrief(session, persona, events)


def test_sdk_timeout_reuses_unavailable_mapping(inputs, monkeypatch):
    session, persona, events, _draft = inputs
    mock_provider(monkeypatch, {}, timeout=True)
    with pytest.raises(ProviderUnavailable):
        extract.extract_debrief(session, persona, events)
