"""`make eval`: real persona extraction, interview replies and debrief on the Quartier-Börse case.

Opt-in and never part of `make check` or CI, because it spends money. `python -m evals.run` exits
0: every check passed. 1: a check failed. 2: the eval could not finish (no key, provider error,
budget, crash). `make eval` exits 2 for both failures, as make does for any failed recipe; its
"Error 1" or "Error 2" line and the printed output keep them apart.

Limit: replies come from OPENAI_MODEL through the Responses API with the live persona prompt, not
from the Realtime voice model, so this catches prompt regressions, not voice model behaviour.
"""

import json
import os
import re
import sys
import traceback
from datetime import UTC, datetime
from pathlib import Path
from types import SimpleNamespace

from dotenv import load_dotenv
from pydantic import BaseModel

from app import extract
from app.contracts import Persona, PersonaCreate, PersonaSource, Session, SessionEvent
from app.extract import ExtractionFailed, PersonaDraft, ProviderUnavailable
from app.faces import FACES, VOICES, fitting_face
from app.provider_log import provider_call
from app.realtime import persona_instructions
from app.routers.personas import ground_draft
from evals.scoring import Check, format_table, score_debrief, score_persona, score_replies

CODE = Path(__file__).resolve().parents[2]
ENV_FILE = CODE / "backend" / ".env"
REPORTS = CODE / "reports" / "evals"
TESTCASE = CODE.parent / "documentation" / "testcase-quartier-boerse.md"
SAMPLE = CODE / "frontend" / "src" / "lib" / "sample.ts"

LANGUAGE = "de"
# Persona extraction + one reply per interviewer line in the sample transcript + debrief.
MAX_CALLS = 10
STRUCTURED_OUTPUT_CAP = 12_000
REPLY_OUTPUT_CAP = 1_000
# No new call starts once it could pass this, counting the call's whole output cap.
TOKEN_BUDGET = 150_000
# USD per 1M tokens (input, output), from OpenAI's model page on 2026-10-31. Cached input is
# billed less, so a cost computed from these can only overstate it.
PRICES = {"gpt-5.4-mini": (0.75, 4.50)}


class BudgetExceeded(Exception):
    pass


def _model() -> str:
    return os.environ.get("OPENAI_MODEL") or extract.DEFAULT_MODEL


def cost_usd(model: str, input_tokens: int, output_tokens: int) -> float | None:
    """None for a model whose price we don't know: better no number than a wrong one."""
    if model not in PRICES:
        return None
    price_in, price_out = PRICES[model]
    return (input_tokens * price_in + output_tokens * price_out) / 1_000_000


def worst_case_usd(model: str) -> float | None:
    """The budget as input plus every call's output cap. About: the last call's input isn't known
    before it is sent, so it can pass the budget by that much (a few thousand tokens)."""
    return cost_usd(
        model, TOKEN_BUDGET, 2 * STRUCTURED_OUTPUT_CAP + (MAX_CALLS - 2) * REPLY_OUTPUT_CAP
    )


class Meter:
    """Wraps client.responses: caps every call's output, counts tokens, refuses past the budget."""

    def __init__(self, responses) -> None:
        self.responses = responses
        self.calls = self.input_tokens = self.output_tokens = 0
        # A call that failed or returned no usage, which the provider may still bill.
        self.unmetered_calls = 0

    def _before(self, cap: int) -> None:
        used = self.input_tokens + self.output_tokens
        if self.calls >= MAX_CALLS or used + cap > TOKEN_BUDGET:
            raise BudgetExceeded(f"stopped after {self.calls} calls and {used} tokens")
        self.calls += 1

    def _call(self, method, cap: int, kwargs: dict):
        self._before(cap)
        try:
            response = method(**kwargs, max_output_tokens=cap)
        except Exception:
            self.unmetered_calls += 1
            raise
        if response.usage is None:
            self.unmetered_calls += 1
        else:
            self.input_tokens += response.usage.input_tokens
            self.output_tokens += response.usage.output_tokens
        return response

    def parse(self, **kwargs):
        return self._call(self.responses.parse, STRUCTURED_OUTPUT_CAP, kwargs)

    def create(self, **kwargs):
        return self._call(self.responses.create, REPLY_OUTPUT_CAP, kwargs)

    def summary(self, model: str) -> str:
        cost = cost_usd(model, self.input_tokens, self.output_tokens)
        price = f"about ${cost:.3f}" if cost is not None else f"no price known for {model}"
        line = (
            f"Cost: {self.calls} call(s), {self.input_tokens} input + {self.output_tokens} "
            f"output tokens, {price}."
        )
        if self.unmetered_calls:
            line += f" Not counted: {self.unmetered_calls} call(s) without usage data."
        return line


def load_case() -> tuple[PersonaCreate, list[str], list[str]]:
    """The sources, interviewer lines and guide the demo uses, so the eval can't drift from it."""
    sample = SAMPLE.read_text()
    transcript = re.search(r"SAMPLE_TRANSCRIPT = `(.*?)`;", sample, re.DOTALL)
    guide = re.search(r"QUARTIER_BOERSE_GUIDE = \[(.*?)\];", sample, re.DOTALL)
    if transcript is None or guide is None:
        raise ValueError(f"sample transcript or guide not found in {SAMPLE}")
    # The document opens with a status banner for readers; the app's prefilled copy starts at its title.
    testcase = TESTCASE.read_text()
    request = PersonaCreate(
        language=LANGUAGE,
        sources=[
            PersonaSource(
                kind="note",
                title="Interview guide Quartier-Börse",
                text=testcase[testcase.index("# Test case:") :],
            ),
            PersonaSource(
                kind="transcript",
                title="Interview transcript (synthetic)",
                text=transcript.group(1),
            ),
        ],
    )
    questions = re.findall(r"^I: (.+)$", transcript.group(1), re.MULTILINE)
    return request, questions, re.findall(r'"([^"]+)"', guide.group(1))


def build_persona(draft: PersonaDraft, request: PersonaCreate) -> Persona:
    """What create_persona stores, without the store."""
    return Persona(
        **draft.model_dump(exclude={"face", "gender"}),
        id="p_eval",
        language=request.language,
        voice_id=VOICES[draft.gender],
        face_id=FACES[fitting_face(draft.face, draft.gender, draft.age)][0],
        cloned=False,
    )


def _reply(instructions: str, history: list[dict]) -> str:
    with extract._provider_errors(), provider_call("openai", "eval_persona_reply"):
        response = extract._client().responses.create(
            model=_model(), instructions=instructions, input=history
        )
        if response.status != "completed" or not response.output_text.strip():
            raise ExtractionFailed("unusable persona reply")
    return response.output_text.strip()


def interview(persona: Persona, request: PersonaCreate, questions: list[str], guide: list[str]):
    """Ask each question in one running conversation; returns the replies and the session events."""
    instructions = persona_instructions(persona, guide, request.sources)
    history: list[dict] = []
    replies = []
    for question in questions:
        history.append({"role": "user", "content": question})
        reply = _reply(instructions, history)
        history.append({"role": "assistant", "content": reply})
        replies.append(reply)

    def event(seq: int, kind: str, data: dict) -> SessionEvent:
        return SessionEvent(
            session_id="s_eval", seq=seq, at="2026-10-31T14:00:00Z", type=kind, data=data
        )

    turns = [
        {"speaker": speaker, "text": text}
        for question, reply in zip(questions, replies, strict=True)
        for speaker, text in (("interviewer", question), ("persona", reply))
    ]
    events = [event(seq, "utterance", data) for seq, data in enumerate(turns, start=1)]
    events.append(event(len(events) + 1, "session.ended", {}))
    return replies, events


def _save(folder: Path, name: str, data) -> None:
    if isinstance(data, BaseModel):
        data = data.model_dump(mode="json", by_alias=True)
    (folder / name).write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n")


def last_scores(reports: Path) -> dict[str, str] | None:
    """Scores of the newest finished run; run folders are UTC timestamps, so they sort by time."""
    if not reports.is_dir():
        return None
    runs = sorted(p for p in reports.iterdir() if (p / "scores.json").is_file())
    if not runs:
        return None
    saved = json.loads((runs[-1] / "scores.json").read_text())["checks"]
    return {check["name"]: check["result"] for check in saved}


def run_case(folder: Path) -> list[Check]:
    request, questions, guide = load_case()
    draft = extract.extract_persona(request)
    _save(folder, "persona-draft.json", draft)
    checks = score_persona(draft, request)

    persona = build_persona(ground_draft(draft, request), request)
    replies, events = interview(persona, request, questions, guide)
    _save(folder, "transcript.json", [e.model_dump(mode="json", by_alias=True) for e in events])
    checks += score_replies(replies, request.language)

    session = Session(
        id="s_eval",
        persona_id=persona.id,
        status="ended",
        provider="openai-realtime",
        interview_guide=guide,
    )
    debrief_draft = extract.extract_debrief(session, persona, events)
    _save(folder, "debrief-draft.json", debrief_draft)
    return checks + score_debrief(debrief_draft, session, persona, events)


def main(reports: Path = REPORTS) -> int:
    if not os.environ.get("OPENAI_API_KEY"):
        print("make eval needs OPENAI_API_KEY (in code/backend/.env or the environment).")
        return 2

    model = _model()
    worst = worst_case_usd(model)
    print(
        f"Real provider calls, model {model}: at most {MAX_CALLS} calls and {TOKEN_BUDGET} tokens"
        + (f", about ${worst:.2f} at worst." if worst is not None else "; no price known.")
    )
    folder = reports / datetime.now(UTC).strftime("%Y%m%dT%H%M%SZ")

    # No SDK retries: a retry is a billed call the meter can't see.
    meter = Meter(extract._client().with_options(max_retries=0).responses)
    extract._client = lambda: SimpleNamespace(responses=meter)
    try:
        folder.mkdir(parents=True)
        previous = last_scores(reports)
        checks = run_case(folder)
        _save(
            folder,
            "scores.json",
            {
                "model": model,
                "calls": meter.calls,
                "inputTokens": meter.input_tokens,
                "outputTokens": meter.output_tokens,
                "checks": [
                    {"name": c.name, "result": c.result, "failures": c.failures} for c in checks
                ],
            },
        )
    except Exception as exc:  # noqa: BLE001 - any crash means "did not finish", with the spend shown
        if not isinstance(exc, ProviderUnavailable | ExtractionFailed | BudgetExceeded):
            traceback.print_exc()
        print(f"Eval did not finish: {type(exc).__name__}: {exc}")
        print(meter.summary(model))
        print(f"Partial outputs: {folder}")
        return 2

    print(format_table(checks, previous))
    for check in checks:
        for failure in check.failures:
            print(f"  {check.name}: {failure}")
    failed = sum(not check.ok for check in checks)
    print(f"{'FAIL' if failed else 'PASS'}: {len(checks) - failed} of {len(checks)} checks passed.")
    print(meter.summary(model))
    print(f"Raw outputs: {folder}")
    return 1 if failed else 0


def cli() -> int:
    # Not `uv run --env-file`: its parser stops at an apostrophe in a comment of .env and prints the
    # rest of the file, secrets included. Variables already in the environment win.
    load_dotenv(ENV_FILE)
    return main()


if __name__ == "__main__":
    sys.exit(cli())
