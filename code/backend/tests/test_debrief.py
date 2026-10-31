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
    assert set(report.model_dump(by_alias=True)) == {
        "sessionId",
        "generatedAt",
        "transcriptGaps",
        "questions",
    }


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


@pytest.mark.parametrize("change", ["missing", "extra", "reordered", "reordered_and_retyped"])
def test_questions_that_cannot_be_matched_by_position_still_fail(inputs, change):
    session, persona, events, draft = inputs
    if change == "missing":
        draft.questions.pop()
    elif change == "extra":
        draft.questions.append(draft.questions[0].model_copy(deep=True))
    elif change == "reordered":
        draft.questions.reverse()
    else:
        draft.questions.reverse()
        draft.questions[0].question = f"  {draft.questions[0].question.upper().rstrip('?')} "
    with pytest.raises(ExtractionFailed, match="questions"):
        debrief.build_report(session, persona, events, draft)


@pytest.mark.parametrize(
    "disguise",
    [
        lambda q: q.upper(),
        lambda q: f"  {q} ".replace(" ", "  "),
        lambda q: q.rstrip("?!.") + " -",
        lambda q: q.upper().replace(":", " -").replace(" ", "").rstrip("?"),
    ],
)
def test_a_swap_is_caught_through_case_spacing_and_punctuation(inputs, disguise):
    session, persona, events, draft = inputs
    draft.questions[0].question = disguise(session.interview_guide[1])
    with pytest.raises(ExtractionFailed, match="questions"):
        debrief.build_report(session, persona, events, draft)


@pytest.mark.parametrize("blank", ["", "   ", "?", " ... ", "¿?", "_"])
def test_a_blank_or_punctuation_only_question_fails(inputs, blank):
    session, persona, events, draft = inputs
    draft.questions[1].question = blank
    with pytest.raises(ExtractionFailed, match="questions"):
        debrief.build_report(session, persona, events, draft)


GUIDE = [
    "Erleben Nutzer:innen das Teilen ihrer Kilo-Shares fürs Quartier als Mehrwert oder als Verlust?",
    "Erhöht das Partner-Matching (Bäckerei Muff verdoppelt) den Anteil fürs Projekt?",
    "Vertrauen sie darauf, dass ihr Beitrag wirklich beim Projekt ankommt?",
]


def test_known_limit_a_question_both_reordered_and_reworded_is_not_detected(inputs):
    session, persona, events, draft = inputs
    session.interview_guide = GUIDE
    draft.questions[0].question = "Erhöht das Matching den Projektanteil?"
    draft.questions[1].question = "Ist Teilen ein Mehrwert oder ein Verlust?"
    draft.questions[2].question = GUIDE[2]
    report = debrief.build_report(session, persona, events, draft)
    assert [q.question for q in report.questions] == GUIDE


def test_the_prompt_tells_the_model_to_keep_the_guides_order():
    assert "the same order" in " ".join(extract.DEBRIEF_INSTRUCTIONS.split())


@pytest.mark.parametrize(
    "guide, asked",
    [
        (
            GUIDE,
            [
                "Ist Teilen ein Mehrwert oder ein Verlust?",
                "Erhöht das Matching den Projektanteil?",
                "Vertrauen in den Beitrag?",
            ],
        ),
        (
            GUIDE,
            [
                "Sharing: benefit or loss?",
                "Does matching raise the project share?",
                "Do they trust the money arrives?",
            ],
        ),
        (
            [
                "Was kostet Sie das Problem heute?",
                "Wann ist es zuletzt passiert?",
                "Wie haben Sie es gelöst?",
            ],
            [
                "What does the problem cost you today?",
                "When did it last happen?",
                "How did you solve it?",
            ],
        ),
    ],
)
def test_shortening_or_translating_in_place_passes(inputs, guide, asked):
    session, persona, events, draft = inputs
    session.interview_guide = guide
    for question, text in zip(draft.questions, asked, strict=True):
        question.question = text
    report = debrief.build_report(session, persona, events, draft)
    assert [q.question for q in report.questions] == guide


def test_rewording_in_place_passes_even_with_similar_guide_questions(inputs):
    session, persona, events, draft = inputs
    session.interview_guide = [
        "Would you pay for the basic plan?",
        "Would you pay for the premium plan?",
        "Would you recommend the basic plan?",
    ]
    draft.questions[0].question = "1. Would you really pay for the basic plan at all?"
    draft.questions[1].question = "Would you pay for the premium plan (monthly)?"
    draft.questions[2].question = "Würden Sie den Basisplan weiterempfehlen?"
    report = debrief.build_report(session, persona, events, draft)
    assert [q.question for q in report.questions] == session.interview_guide


def test_an_honest_rewording_of_the_lumen_guide_passes(inputs):
    session, persona, events, draft = inputs
    guide = Path(__file__).parents[3] / "documentation/usecases/lumen-ipp/interview"
    session.interview_guide = (guide / "guide-short-miriam-kessler.txt").read_text().splitlines()
    draft.questions.append(draft.questions[2].model_copy())
    asked = [
        "How are you today?",
        "How do you find the prototype email?",
        "What would you improve?",
        "What exactly would you change on the prototype?",
    ]
    for question, text in zip(draft.questions, asked, strict=True):
        question.question = text
    report = debrief.build_report(session, persona, events, draft)
    assert [q.question for q in report.questions] == session.interview_guide


def test_a_repeated_guide_question_copied_at_either_position_passes(inputs):
    session, persona, events, draft = inputs
    session.interview_guide = ["Why?", "Why?", "How much?"]
    for question, text in zip(draft.questions, ["why", "WHY?", "How much?"], strict=True):
        question.question = text
    report = debrief.build_report(session, persona, events, draft)
    assert [q.question for q in report.questions] == session.interview_guide


@pytest.mark.parametrize(
    "reworded",
    [
        lambda q: q + " altered",
        lambda q: q.rstrip("?") + ".",
        lambda q: "Completely different words",
    ],
)
def test_reworded_question_matches_by_position_and_keeps_the_guides_text(inputs, reworded):
    session, persona, events, draft = inputs
    answer = draft.questions[0]
    draft.questions[0].question = reworded(answer.question)
    report = debrief.build_report(session, persona, events, draft)
    assert [q.question for q in report.questions] == session.interview_guide
    # The answer stays with its own question: same signal, same quotes, same follow-ups.
    assert report.questions[0].signal == answer.signal
    assert report.questions[0].insights[0].quote == answer.insights[0].quote
    assert report.questions[0].follow_ups == answer.follow_ups


def test_reworded_question_does_not_loosen_quote_verification(inputs):
    session, persona, events, draft = inputs
    draft.questions[0].question += " altered"
    draft.questions[0].insights[0].quote = "Nobody said this."
    report = debrief.build_report(session, persona, events, draft)
    assert report.questions[0].insights == [] and report.questions[0].signal == "unclear"


@pytest.mark.parametrize(
    "said, quote, kept",
    [
        ("I wouldn't pay for this.", "I would", False),
        ("I wouldn’t pay for this.", "I would", False),
        ("I can't pay for this.", "I can", False),
        ("Hard to say.", "e", False),
        ("Unfair, I think.", "fair", False),
        ("I wouldn´t buy it.", "I wouldn", False),
        ("I'd pay 1,000 francs.", "I'd pay 1", False),
        ("I'd pay 1'000 Franken.", "I'd pay 1", False),
        ("I'd pay 1.50 at most.", "I'd pay 1", False),
        ("I'd pay 1,000 francs.", "000 francs", False),
        ("I'd pay 1 000 francs.", "I'd pay 1", False),
        ("I'd pay 1\u00a0000 francs.", "I'd pay 1", False),
        ("I'd pay 1\u202f000 francs.", "I'd pay 1", False),
        ("I'd pay 1 000 francs.", "I'd pay 1 000", True),
        ("I'd pay 10 francs.", "I'd pay 10", True),
        ("This is non-binding for me.", "binding for me", False),
        ("I'd pay 1,000 francs.", "I'd pay 1,000", True),
        ("This is non-binding for me.", "non-binding", True),
        ("Ja, sicher. Aber nicht heute.", "Ja, sicher.", True),
        ("Ja, sicher. Aber nicht heute.", "Aber nicht heute", True),
        ("I wouldn't pay for this.", "I wouldn't pay", True),
        ("I wouldn't pay for this.", "pay for this.", True),
        ("Für die Bäckerei, ja.", "Bäckerei", True),
        ("He said it's 'the best' deal.", "the best", True),
    ],
)
def test_a_quote_must_be_whole_words_of_what_the_persona_said(inputs, said, quote, kept):
    session, persona, events, draft = inputs
    insight = draft.questions[0].insights[0]
    next(e for e in events if e.seq == insight.turn_seq).data["text"] = said
    insight.quote = quote
    quotes = [
        i.quote for i in debrief.build_report(session, persona, events, draft).questions[0].insights
    ]
    assert quotes == ([quote] if kept else [])


@pytest.mark.parametrize("gaps", [True, False, None])
def test_report_gap_flag_comes_only_from_the_end_marker(inputs, gaps):
    session, persona, events, draft = inputs
    events[-1].data.pop("transcriptGaps", None)
    if gaps is not None:
        events[-1].data["transcriptGaps"] = gaps
    assert debrief.build_report(session, persona, events, draft).transcript_gaps is (gaps is True)


def test_quotes_stay_verified_on_a_transcript_with_gaps(inputs):
    session, persona, events, draft = inputs
    events[-1].data["transcriptGaps"] = True
    draft.questions[0].insights[0].quote = "Nobody said this."
    good = draft.questions[1].insights[0]
    report = debrief.build_report(session, persona, events, draft)
    assert report.transcript_gaps is True
    assert report.questions[0].insights == []
    assert report.questions[1].insights[0].quote == good.quote


@pytest.mark.parametrize("quote", ["(interrupted)", "interrupted"])
def test_the_interrupted_placeholder_is_not_something_the_persona_said(inputs, quote):
    session, persona, events, draft = inputs
    events[5].data["text"] = "(interrupted)"
    draft.questions[0].insights[0].quote = quote
    assert debrief.build_report(session, persona, events, draft).questions[0].insights == []


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
def test_only_exact_grounded_fact_with_its_own_verbatim_evidence_is_preserved(inputs, fact_list):
    session, persona, events, draft = prepare_grounded(inputs)
    fact = persona.jobs[0].model_copy()
    persona.jobs, persona.pains, persona.objections = [], [], []
    setattr(persona, fact_list, [fact])
    insight = debrief.build_report(session, persona, events, draft).questions[0].insights[0]
    assert insight.label == "grounded" and insight.evidence_id == fact.evidence_id


@pytest.mark.parametrize(
    "passage, said, label",
    [
        ("I'd pay 5", "I'd pay 50 francs a month for that.", "guess"),
        ("I'd pay 1", "I'd pay 1,000 francs.", "guess"),
        ("I would", "I wouldn't use this at all.", "guess"),
        ("no", "I know this works.", "guess"),
        ("binding", "This is non-binding for me.", "guess"),
        ("I'd pay 50", "I'd pay 50 francs a month for that.", "grounded"),
        ("I wouldn't", "I wouldn't use this at all.", "grounded"),
        # Only whitespace around a stored passage differs, and ground_draft can store that.
        (" I'd pay 50\n", "I'd pay 50", "grounded"),
    ],
)
def test_grounded_needs_the_source_passage_as_whole_words_of_the_quote(
    inputs, passage, said, label
):
    session, persona, events, draft = prepare_grounded(inputs)
    persona.evidence[0].quote = passage
    draft.questions[0].insights[0].quote = said
    events[5].data["text"] = said
    result = debrief.build_report(session, persona, events, draft).questions[0].insights[0]
    assert result.quote == said and result.label == label


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
        "unrelated_quote",
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
    elif change in ("null_quote", "blank_quote", "unrelated_quote"):
        persona.evidence[0].quote = {
            "null_quote": None,
            "blank_quote": " \n ",
            "unrelated_quote": "Another real source passage.",
        }[change]
    elif change == "duplicate_evidence":
        persona.evidence.append(persona.evidence[0].model_copy())
    else:
        insight.label = "guess"
    result = debrief.build_report(session, persona, events, draft).questions[0].insights[0]
    assert result.label == "guess" and result.evidence_id is None
    assert result.quote == insight.quote


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
