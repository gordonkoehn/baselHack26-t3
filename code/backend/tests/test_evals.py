"""`make eval` spends money and never runs here: these feed its scoring and runner fixed fixtures."""

import json
import os
from copy import deepcopy
from types import SimpleNamespace
from unittest.mock import patch

import httpx
import openai
import pytest

from app import debrief, extract
from app.contracts import Evidence, Fact, Persona, PersonaCreate, PersonaSource, Session
from app.contracts import SessionEvent as Event
from app.extract import DebriefDraft, PersonaDraft
from evals import run, scoring
from evals.scoring import score_debrief, score_persona, score_replies

QUOTE = "Sonst ist es für mich nur Werbung."
REQUEST = PersonaCreate(
    language="de",
    sources=[
        PersonaSource(kind="note", text="Spielplatz Littau, 12 Shares, Bäckerei Muff."),
        PersonaSource(kind="transcript", text=f"P1: Aber   ich will Belege.\n{QUOTE}"),
    ],
)
GUIDE = ["Vertrauen sie dem Projekt?"]


def persona_draft(**changes) -> PersonaDraft:
    fields = {
        "name": "Nadine Meier",
        "summary": "Nadine wohnt in Littau und hat zwei Kinder, die dort spielen.",
        "jobs": [Fact(text="Will 12 Shares verteilen", label="grounded", evidence_id="e1")],
        "pains": [],
        "objections": [Fact(text="Vermutet Werbung", label="grounded", evidence_id="e1")],
        "evidence": [Evidence(id="e1", kind="transcript", claim="Skepsis", quote=QUOTE)],
        "gender": "f",
        "face": "Anna",
    }
    return PersonaDraft(**{**fields, **changes})


def persona() -> Persona:
    return run.build_persona(persona_draft(), REQUEST)


def session() -> Session:
    return Session(
        id="s_eval",
        persona_id="p_eval",
        status="ended",
        provider="openai-realtime",
        interview_guide=GUIDE,
    )


def events(reply: str = QUOTE) -> list[Event]:
    def event(seq, kind, data):
        return Event(session_id="s_eval", seq=seq, at="2026-10-31T14:00:00Z", type=kind, data=data)

    return [
        event(1, "utterance", {"speaker": "interviewer", "text": "Was denkst du? Über 12 Shares?"}),
        event(2, "utterance", {"speaker": "persona", "text": reply}),
        event(3, "session.ended", {}),
    ]


def debrief_draft(theme: str = "Ohne Belege bleibt es Werbung", quote: str = QUOTE) -> DebriefDraft:
    insight = {
        "id": "i1",
        "theme": theme,
        "quote": quote,
        "turnSeq": 2,
        "label": "guess",
        "evidenceId": None,
    }
    return DebriefDraft.model_validate(
        {"questions": [{"question": GUIDE[0], "signal": "contradicts", "insights": [insight]}]}
    )


def failed(checks) -> set[str]:
    return {check.name for check in checks if not check.ok}


def test_good_output_passes_every_check():
    assert failed(score_persona(persona_draft(), REQUEST)) == set()
    assert failed(score_replies([QUOTE, "Ja, klar."], "de")) == set()
    assert failed(score_debrief(debrief_draft(), session(), persona(), events())) == set()


@pytest.mark.parametrize(
    ("changes", "check"),
    [
        (
            {"jobs": [Fact(text="Mag Parks", label="grounded", evidence_id="e9")]},
            "grounded_facts_cite_evidence",
        ),
        (
            {"jobs": [Fact(text="Mag Parks", label="grounded", evidence_id=None)]},
            "grounded_facts_cite_evidence",
        ),
        (
            {"evidence": [Evidence(id="e1", kind="note", claim="c", quote="Nur Werbung, sonst.")]},
            "evidence_quotes_in_sources",
        ),
        (
            {"evidence": [Evidence(id="e1", kind="note", claim="c", quote=None)]},
            "evidence_quotes_in_sources",
        ),
        (
            {"jobs": [Fact(text="Sammelt 99 Shares", label="grounded", evidence_id="e1")]},
            "grounded_facts_no_invented_numbers",
        ),
        (
            {"jobs": [Fact(text="Kauft bei Brot Keller", label="grounded", evidence_id="e1")]},
            "grounded_facts_no_invented_names",
        ),
        (
            {"summary": "She lives in Littau and the kids play there with her friends."},
            "persona_keeps_language",
        ),
        ({"jobs": [], "objections": []}, "persona_has_grounded_facts"),
    ],
)
def test_bad_persona_fails_the_matching_check(changes, check):
    assert check in failed(score_persona(persona_draft(**changes), REQUEST))


def test_invented_backstory_is_allowed_outside_grounded_facts():
    # The prompt asks for it: the summary and guess facts go beyond the sources on purpose.
    draft = persona_draft(
        summary="Nadine Meier hat seit 2019 die Kinder Mia und Luca bei sich.",
        pains=[Fact(text="Fährt 99 Mal zu Tante Rosa", label="guess", evidence_id=None)],
    )
    assert failed(score_persona(draft, REQUEST)) == set()


def test_evidence_whitespace_is_normalized_like_the_server():
    evidence = [Evidence(id="e1", kind="transcript", claim="c", quote="Aber ich will Belege.")]
    assert failed(score_persona(persona_draft(evidence=evidence), REQUEST)) == set()


def test_a_quote_spanning_two_sources_is_not_verbatim():
    evidence = [Evidence(id="e1", kind="note", claim="c", quote="Bäckerei Muff. P1: Aber")]
    checks = score_persona(persona_draft(evidence=evidence), REQUEST)
    assert "evidence_quotes_in_sources" in failed(checks)


@pytest.mark.parametrize(
    ("reply", "check"),
    [
        (" ", "reply_length"),
        ("wort " * (scoring.MAX_REPLY_WORDS + 1), "reply_length"),
        ("I would rather see that the money gets there and not this.", "reply_keeps_language"),
    ],
)
def test_bad_reply_fails_the_matching_check(reply, check):
    assert check in failed(score_replies([QUOTE, reply], "de"))


def test_reply_at_the_length_limit_passes():
    assert failed(score_replies(["wort " * scoring.MAX_REPLY_WORDS], "de")) == set()


@pytest.mark.parametrize(
    ("draft", "check"),
    [
        (debrief_draft(quote="nur Werbung, sonst"), "debrief_quotes_in_cited_turns"),
        (debrief_draft(quote="Was denkst du?"), "debrief_quotes_in_cited_turns"),
        (debrief_draft(theme="Sie würde 99 Shares geben"), "debrief_no_invented_numbers"),
        (debrief_draft(theme="Sie vertraut der Brot Keller"), "debrief_no_invented_names"),
        (
            debrief_draft(theme="She would like to see this and that the money arrives."),
            "debrief_keeps_language",
        ),
        (DebriefDraft(questions=[]), "debrief_accepted_by_server"),
        (DebriefDraft(questions=[]), "debrief_has_insights"),
    ],
)
def test_bad_debrief_fails_the_matching_check(draft, check):
    assert check in failed(score_debrief(draft, session(), persona(), events()))


def test_debrief_scores_the_raw_draft_not_the_repaired_report():
    # build_report silently drops this insight, which is why it must still count as a failure.
    draft = debrief_draft(quote="nur Werbung, sonst")
    checks = {c.name: c for c in score_debrief(draft, session(), persona(), events())}
    assert checks["debrief_accepted_by_server"].ok
    assert not checks["debrief_quotes_in_cited_turns"].ok


@pytest.mark.parametrize(
    ("replies", "cited", "reported_insights"),
    [
        # Said twice, cited on the interviewer's turn: build_report can't tell which, so drops it.
        ([QUOTE, QUOTE], 1, 0),
        # Said once, cited on the wrong turn: build_report moves it.
        ([QUOTE, "Keine Ahnung."], 4, 1),
    ],
)
def test_debrief_quote_on_the_wrong_turn_fails_though_the_server_repairs_it(
    replies, cited, reported_insights
):
    def event(seq, kind, data):
        return Event(session_id="s_eval", seq=seq, at="2026-10-31T14:00:00Z", type=kind, data=data)

    transcript = [
        event(1, "utterance", {"speaker": "interviewer", "text": "Und?"}),
        event(2, "utterance", {"speaker": "persona", "text": replies[0]}),
        event(3, "utterance", {"speaker": "interviewer", "text": "Und?"}),
        event(4, "utterance", {"speaker": "persona", "text": replies[1]}),
        event(5, "session.ended", {}),
    ]
    draft = debrief_draft()
    draft.questions[0].insights[0].turn_seq = cited

    report = debrief.build_report(session(), persona(), transcript, draft)
    assert len(report.questions[0].insights) == reported_insights
    assert failed(score_debrief(draft, session(), persona(), transcript)) == {
        "debrief_quotes_in_cited_turns"
    }


def test_debrief_may_use_numbers_and_names_from_the_call():
    theme = "Sie zweifelt an den 12 Shares, sagt Nadine Meier"
    assert failed(score_debrief(debrief_draft(theme=theme), session(), persona(), events())) == (
        set()
    )


def test_numbers_are_compared_as_whole_values():
    assert scoring.invented_numbers("8,2 kg und 1'460", "8.2 und 1460") == set()
    assert scoring.invented_numbers("14 Tage", "141 Tage") == {"14"}


def test_a_capitalized_sentence_start_is_not_a_name():
    assert scoring.invented_names("Klare Transparenz fehlt.", "") == []
    assert scoring.invented_names("Es fehlt. Klare Transparenz fehlt.", "") == []


@pytest.mark.parametrize(
    "text",
    [
        "«Reine Werbung» statt Mehrwert",
        "Wünscht «Klare Transparenz» beim Projekt",
        "Wünscht ‹Klare Transparenz› beim Projekt",
        "Wünscht „Klare Transparenz“ beim Projekt",
        "Wünscht ‚Klare Transparenz‘ beim Projekt",
        'Fragt "Klare Transparenz"',
        "Fragt 'Klare Transparenz'",
    ],
)
def test_a_capitalized_quote_start_is_not_a_name(text):
    assert scoring.invented_names(text, "") == []


def test_only_the_first_word_of_a_quote_is_excused():
    assert scoring.invented_names("Kauft bei «Bäckerei Peter Keller» ein", "") == ["Peter Keller"]


def test_a_capital_after_a_comma_is_still_checked():
    assert scoring.invented_names("Sie mag Anna, Peter Keller nicht", "") == ["Peter Keller"]


@pytest.mark.parametrize("reply", ["Ja, the Börse klingt gut.", "Ok, and?"])
def test_one_stopword_from_the_other_language_is_not_clear_evidence(reply):
    assert not scoring.wrong_language(reply, "de")


def test_two_stopwords_from_the_other_language_are_clear_evidence():
    assert scoring.wrong_language("Ja, the Börse and klingt gut.", "de")


def test_a_quote_copied_from_the_interviewer_fails_though_it_is_in_the_cited_turn():
    draft = debrief_draft(quote="Was denkst du?")
    draft.questions[0].insights[0].turn_seq = 1
    checks = {c.name: c for c in score_debrief(draft, session(), persona(), events())}
    assert not checks["debrief_quotes_in_cited_turns"].ok


def test_a_theme_may_name_a_topic_from_the_interview_guide():
    guide = ["Wie sieht sie die Quartier Börse?"]
    theme = "Die Skepsis trifft auch die Quartier Börse"
    interview = session().model_copy(update={"interview_guide": guide})
    checks = {
        c.name: c for c in score_debrief(debrief_draft(theme), interview, persona(), events())
    }
    assert checks["debrief_no_invented_names"].ok


@pytest.mark.parametrize(
    ("text", "name"),
    [
        ("Vertraut Peter Keller nicht", "Peter Keller"),
        ("Für Sandra Bucher zählt Transparenz", "Sandra Bucher"),
        ("Es fehlt. Für Sandra Bucher zählt das.", "Sandra Bucher"),
        # One word from the sources doesn't make the rest of the name real.
        ("Kauft bei Bäckerei Keller ein", "Bäckerei Keller"),
        ("Sammelt für Spielplatz Emmen", "Spielplatz Emmen"),
    ],
)
def test_an_invented_name_is_found_next_to_a_capitalized_or_known_word(text, name):
    assert scoring.invented_names(text, REQUEST.sources[0].text) == [name]


@pytest.mark.parametrize(
    "text",
    [
        "Vertraut Bäckerei Muff nicht",
        "Sie mag Spielplatz Littau",
        # The same words, hyphenated in the sources.
        "Sammelt Kilo Shares",
    ],
)
def test_a_name_from_the_sources_is_not_invented(text):
    assert scoring.invented_names(text, f"{REQUEST.sources[0].text} Kilo-Shares") == []


def test_a_name_opening_the_text_is_a_known_gap():
    # Same shape as "Klare Transparenz fehlt", which must pass: see invented_names.
    assert scoring.invented_names("Peter Keller vertraut sie nicht", "") == []


def test_a_grounded_fact_may_use_the_personas_own_name():
    jobs = [Fact(text="Für Nadine Meier ist das Werbung", label="grounded", evidence_id="e1")]
    assert failed(score_persona(persona_draft(jobs=jobs), REQUEST)) == set()


def test_table_flags_a_score_that_got_worse():
    checks = [scoring.Check("a", 1, 2, ["x"]), scoring.Check("b", 2, 2), scoring.Check("c", 1, 1)]
    lines = scoring.format_table(checks, {"a": "2/2", "b": "1/2"}).splitlines()
    assert "1/2" in lines[1] and "2/2" in lines[1] and "FAIL (worse than last run)" in lines[1]
    assert lines[2].endswith("ok")
    assert lines[3].split()[2] == "-"


def test_the_case_comes_from_the_demo_sample():
    request, questions, guide = run.load_case()
    assert [s.kind for s in request.sources] == ["note", "transcript"]
    assert "Kilo-Shares" in request.sources[0].text
    assert request.sources[1].text.startswith("SYNTHETIC INTERVIEW")
    assert "P1: Einen Fortschrittsbalken" in request.sources[1].text
    assert len(questions) == 8 and questions[0].startswith("Wie entsorgt")
    assert len(guide) == 3 and "Bäckerei Muff" in guide[1]
    assert 1 + len(questions) + 1 == run.MAX_CALLS


def case_debrief(guide: list[str], quote: str) -> DebriefDraft:
    """A draft for the real three-question guide, with the one insight on the first question."""
    questions = debrief_draft(quote=quote).questions[0].model_dump(by_alias=True)
    return DebriefDraft.model_validate(
        {
            "questions": [
                {**questions, "question": q, "insights": questions["insights"] if i == 0 else []}
                for i, q in enumerate(guide)
            ]
        }
    )


class FakeResponses:
    """Stands in for client.responses; the runner must never reach the network in tests."""

    def __init__(self, reply=QUOTE, usage=(100, 50)):
        self.reply = reply
        self.persona = persona_draft()
        self.usage = SimpleNamespace(input_tokens=usage[0], output_tokens=usage[1])
        self.calls: list[dict] = []

    def _response(self, **fields):
        return SimpleNamespace(
            status="completed",
            error=None,
            incomplete_details=None,
            output=[],
            usage=self.usage,
            **fields,
        )

    def parse(self, **kwargs):
        self.calls.append(kwargs)
        if kwargs["text_format"] is PersonaDraft:
            return self._response(output_parsed=self.persona)
        _, _, guide = run.load_case()
        return self._response(output_parsed=case_debrief(guide, self.reply))

    def create(self, **kwargs):
        # A copy: the runner keeps appending to the same history list.
        self.calls.append(deepcopy(kwargs))
        return self._response(output_text=self.reply)


@pytest.fixture
def provider(monkeypatch):
    monkeypatch.setenv("OPENAI_API_KEY", "test-key")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-5.4-mini")
    responses = FakeResponses()
    retries: list[int] = []

    def with_options(max_retries):
        retries.append(max_retries)
        return SimpleNamespace(responses=responses)

    monkeypatch.setattr(extract, "_client", lambda: SimpleNamespace(with_options=with_options))
    responses.retries = retries
    return responses


def test_run_scores_saves_raw_outputs_and_prints_cost(provider, tmp_path, capsys):
    assert run.main(tmp_path) == 0
    out = capsys.readouterr().out
    assert "at most 10 calls and 150000 tokens" in out
    assert "PASS" in out and "reply_length" in out
    # 10 calls of 100 input + 50 output tokens: (1000 * 0.75 + 500 * 4.50) / 1M = $0.003.
    assert "10 call(s), 1000 input + 500 output tokens, about $0.003." in out

    folder = next(tmp_path.iterdir())
    assert {p.name for p in folder.iterdir()} == {
        "persona-draft.json",
        "transcript.json",
        "debrief-draft.json",
        "scores.json",
    }
    scores = json.loads((folder / "scores.json").read_text())
    assert scores["calls"] == 10 and all(not c["failures"] for c in scores["checks"])
    transcript = json.loads((folder / "transcript.json").read_text())
    assert transcript[1]["data"] == {"speaker": "persona", "text": QUOTE}
    assert transcript[-1]["type"] == "session.ended"


def test_run_uses_the_live_prompts_and_bounds_every_call(provider, tmp_path):
    run.main(tmp_path)
    assert provider.retries == [0]
    assert len(provider.calls) == run.MAX_CALLS
    assert provider.calls[0]["instructions"].startswith(extract.INSTRUCTIONS[:40])
    reply_instructions = provider.calls[1]["instructions"]
    assert reply_instructions.startswith("HARD RULES")
    # The live prompt's briefing: the guide and the product note, not the interview transcript.
    assert run.load_case()[2][1] in reply_instructions
    assert "Spielplatz Littau (Luzern)" in reply_instructions
    assert provider.calls[-1]["instructions"] == extract.DEBRIEF_INSTRUCTIONS
    assert all(
        call["max_output_tokens"] == (1_000 if "text_format" not in call else 12_000)
        for call in provider.calls
    )
    # Each reply sees the running conversation, like the live call does.
    assert [m["role"] for m in provider.calls[2]["input"]] == ["user", "assistant", "user"]


def test_failed_check_exits_1_and_shows_the_failure(provider, tmp_path, capsys):
    provider.reply = "I would rather see that the money gets there and not this."
    assert run.main(tmp_path) == 1
    out = capsys.readouterr().out
    assert "FAIL: " in out and "reply_keeps_language: I would rather" in out


def test_persona_checks_score_the_raw_draft_not_the_grounded_one(provider, tmp_path):
    # ground_draft drops this evidence and downgrades its fact, so scoring after it would pass.
    provider.persona = persona_draft(
        pains=[Fact(text="Zweifelt", label="grounded", evidence_id="e2")],
        evidence=[
            Evidence(id="e1", kind="transcript", claim="Skepsis", quote=QUOTE),
            Evidence(id="e2", kind="transcript", claim="Zweifel", quote="Nur Werbung, sonst."),
        ],
    )
    assert run.main(tmp_path) == 1
    scores = json.loads((next(tmp_path.iterdir()) / "scores.json").read_text())
    results = {check["name"]: check["result"] for check in scores["checks"]}
    assert results["evidence_quotes_in_sources"] == "1/2"


def test_an_unusable_reply_stops_the_run_with_exit_2(provider, tmp_path, capsys):
    provider.reply = " "
    assert run.main(tmp_path) == 2
    assert len(provider.calls) == 2
    assert "ExtractionFailed: unusable persona reply" in capsys.readouterr().out


def test_a_crash_exits_2_and_still_prints_what_was_spent(provider, tmp_path, capsys, monkeypatch):
    monkeypatch.setattr(run, "SAMPLE", tmp_path / "missing.ts")
    assert run.main(tmp_path) == 2
    captured = capsys.readouterr()
    assert "Eval did not finish: FileNotFoundError" in captured.out
    assert "Cost: 0 call(s)" in captured.out
    assert "Traceback" in captured.err
    assert provider.calls == []


def test_unreadable_earlier_scores_exit_2_before_any_call(provider, tmp_path, capsys):
    older = tmp_path / "20200101T000000Z"
    older.mkdir()
    (older / "scores.json").write_text("not json")
    assert run.main(tmp_path) == 2
    assert "Eval did not finish: JSONDecodeError" in capsys.readouterr().out
    assert provider.calls == []


def test_env_file_from_the_example_loads_without_printing_secrets(tmp_path, capfd, monkeypatch):
    # OPENAI_API_KEY stays empty, so this stops before any client exists.
    env = run.CODE.joinpath(".env.example").read_text()
    for key in ("UPSTASH_REDIS_REST_TOKEN", "SIMLI_API_KEY", "DEMO_PASSCODE"):
        env = env.replace(f"{key}=", f"{key}=FAKE-SECRET-{key}")
    (tmp_path / ".env").write_text(env)
    monkeypatch.setattr(run, "ENV_FILE", tmp_path / ".env")
    with patch.dict(os.environ, clear=True):
        assert run.cli() == 2
        assert os.environ["DEMO_PASSCODE"] == "FAKE-SECRET-DEMO_PASSCODE"
        assert os.environ["OPENAI_API_KEY"] == ""
    captured = capfd.readouterr()
    assert "FAKE-SECRET" not in captured.out + captured.err


def test_make_eval_does_not_hand_the_env_file_to_uv():
    makefile = run.CODE.joinpath("Makefile").read_text()
    recipe = makefile.split("\neval:", 1)[1].split("\n\n", 1)[0]
    assert "python -m evals.run" in recipe and "--env-file" not in recipe


def test_without_a_key_nothing_is_called_or_written(monkeypatch, tmp_path, capsys):
    monkeypatch.delenv("OPENAI_API_KEY", raising=False)

    def no_client():
        raise AssertionError("must not build a client")

    monkeypatch.setattr(extract, "_client", no_client)
    folder = tmp_path / "evals"
    assert run.main(folder) == 2
    assert "OPENAI_API_KEY" in capsys.readouterr().out
    assert not folder.exists()


def test_budget_stops_the_run_and_still_prints_what_was_spent(provider, tmp_path, capsys):
    provider.usage = SimpleNamespace(input_tokens=run.TOKEN_BUDGET, output_tokens=0)
    assert run.main(tmp_path) == 2
    assert len(provider.calls) == 1
    out = capsys.readouterr().out
    assert "BudgetExceeded" in out and "Cost: 1 call(s)" in out
    assert (next(tmp_path.iterdir()) / "persona-draft.json").exists()


def test_meter_refuses_more_than_max_calls():
    meter = run.Meter(FakeResponses())
    for _ in range(run.MAX_CALLS):
        meter.create(model="m")
    with pytest.raises(run.BudgetExceeded):
        meter.create(model="m")
    assert meter.calls == run.MAX_CALLS


@pytest.mark.parametrize(
    ("method", "cap"),
    [("parse", run.STRUCTURED_OUTPUT_CAP), ("create", run.REPLY_OUTPUT_CAP)],
)
def test_meter_counts_the_whole_output_cap_against_the_budget(method, cap):
    fake = FakeResponses()
    meter = run.Meter(fake)
    meter.input_tokens = run.TOKEN_BUDGET - cap
    getattr(meter, method)(model="m", text_format=PersonaDraft)
    assert len(fake.calls) == 1

    meter = run.Meter(fake)
    meter.input_tokens = run.TOKEN_BUDGET - cap + 1
    with pytest.raises(run.BudgetExceeded):
        getattr(meter, method)(model="m", text_format=PersonaDraft)
    assert len(fake.calls) == 1


def test_meter_counts_a_call_without_usage_as_not_metered():
    fake = FakeResponses()
    fake.usage = None
    meter = run.Meter(fake)
    meter.create(model="m")
    assert "Not counted: 1 call(s)" in meter.summary("gpt-5.4-mini")


def test_unknown_model_gets_tokens_but_no_invented_price():
    meter = run.Meter(FakeResponses())
    meter.create(model="m")
    assert "100 input + 50 output tokens, no price known for other" in meter.summary("other")
    assert run.worst_case_usd("other") is None


def test_worst_case_cost_counts_the_whole_budget_and_every_output_cap():
    assert run.worst_case_usd("gpt-5.4-mini") == pytest.approx(0.2565)


def test_last_scores_are_compared_with_the_previous_run(provider, tmp_path, capsys):
    for folder, result in (("20100101T000000Z", "8/9"), ("20200101T000000Z", "9/9")):
        (tmp_path / folder).mkdir()
        saved = {"checks": [{"name": "reply_length", "result": result, "failures": []}]}
        (tmp_path / folder / "scores.json").write_text(json.dumps(saved))
    (tmp_path / "30000101T000000Z").mkdir()  # a run that never finished has no scores
    provider.reply = "wort " * (scoring.MAX_REPLY_WORDS + 1)
    assert run.main(tmp_path) == 1
    row = next(
        line for line in capsys.readouterr().out.splitlines() if line.startswith("reply_length ")
    )
    assert "0/8" in row and "9/9" in row and "worse than last run" in row


def sdk_client(monkeypatch, handle) -> None:
    """The real SDK on a mock transport, so request and response shapes are checked offline."""
    monkeypatch.setenv("OPENAI_API_KEY", "test-only")
    monkeypatch.setenv("OPENAI_MODEL", "gpt-5.4-mini")
    client = openai.OpenAI(
        api_key="test-only", http_client=httpx.Client(transport=httpx.MockTransport(handle))
    )
    monkeypatch.setattr(extract, "_client", lambda: client)


def sdk_body(text: str) -> dict:
    return {
        "id": "resp_test",
        "object": "response",
        "created_at": 1,
        "status": "completed",
        "error": None,
        "incomplete_details": None,
        "instructions": None,
        "model": "gpt-5.4-mini",
        "parallel_tool_calls": False,
        "temperature": 1,
        "tool_choice": "auto",
        "tools": [],
        "top_p": 1,
        "usage": {
            "input_tokens": 100,
            "input_tokens_details": {"cached_tokens": 0},
            "output_tokens": 50,
            "output_tokens_details": {"reasoning_tokens": 0},
            "total_tokens": 150,
        },
        "output": [
            {
                "id": "msg_test",
                "type": "message",
                "role": "assistant",
                "status": "completed",
                "content": [{"type": "output_text", "text": text, "annotations": []}],
            }
        ],
    }


def test_full_run_through_the_real_sdk_sends_the_caps(monkeypatch, tmp_path, capsys):
    bodies: list[dict] = []
    _, _, guide = run.load_case()

    def handle(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        bodies.append(body)
        name = body.get("text", {}).get("format", {}).get("name")
        draft = persona_draft() if name == "PersonaDraft" else case_debrief(guide, QUOTE)
        text = draft.model_dump_json(by_alias=True) if name else QUOTE
        return httpx.Response(200, json=sdk_body(text))

    sdk_client(monkeypatch, handle)
    assert run.main(tmp_path) == 0
    assert "10 call(s), 1000 input + 500 output tokens, about $0.003." in capsys.readouterr().out
    assert [b["max_output_tokens"] for b in bodies] == [12_000, *[1_000] * 8, 12_000]
    assert bodies[2]["input"][1] == {"role": "assistant", "content": QUOTE}


def test_a_provider_error_is_not_retried_and_exits_2(monkeypatch, tmp_path, capsys):
    requests: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        requests.append(request)
        return httpx.Response(429, json={"error": {"message": "slow down"}})

    sdk_client(monkeypatch, handle)
    assert run.main(tmp_path) == 2
    assert len(requests) == 1
    out = capsys.readouterr().out
    assert "ProviderUnavailable: RateLimitError" in out and "Not counted: 1 call(s)" in out
