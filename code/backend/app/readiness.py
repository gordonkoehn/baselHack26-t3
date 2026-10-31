"""Readiness score: how far a new persona can be trusted before anyone interviews it.

Asks the persona prompt five yes/no questions twice each, in parallel. The score is optional
extra: whatever goes wrong here, the persona is returned with readiness null instead of failing.

Only the provider's reported facts and position are used. Labels come from the stored persona, so
the model can't talk a guess into a grounded fact, but whether an answer really relies on the facts
it cites is its own claim. It runs on the text model, not on the realtime model used in interviews.
"""

import contextvars
import logging
from collections.abc import Callable
from concurrent.futures import FIRST_EXCEPTION, ThreadPoolExecutor, wait

from app.contracts import Fact, Language, Persona, PersonaSource, Readiness
from app.extract import ProbeAnswer
from app.realtime import persona_instructions

logger = logging.getLogger("app.readiness")

RUNS = 2
# All probes together. Extraction takes up to ~180 s (90 s timeout, one retry), so normally the
# whole request stays well under the 300 s function limit.
BUDGET_SECONDS = 60
# If extraction took unusually long, probes get less, leaving time to save and respond within 300 s.
LATEST_END_SECONDS = 280

# Closed questions, so two runs can be compared without a further provider call. Any persona can
# answer them, whatever the sprint is about.
PROBES: dict[Language, tuple[str, ...]] = {
    "de": (
        "Ist das Thema dieses Gesprächs in deinem Alltag ein echtes Problem?",
        "Bist du zufrieden damit, wie du das heute löst?",
        "Würdest du für etwas bezahlen, das dir das abnimmt?",
        "Würdest du einem neuen Dienst dafür persönliche Daten anvertrauen?",
        "Würdest du aufgeben, was du heute nutzt, wenn etwas Neues besser aussieht?",
    ),
    "en": (
        "Is the topic of this conversation a real problem in your everyday life?",
        "Are you happy with how you handle this today?",
        "Would you pay for something that takes this off your hands?",
        "Would you trust a new service with personal data for this?",
        "Would you give up what you use today if something new looked better?",
    ),
}

CHECK = """\
This is a written question, not the call: skip the greeting and small talk and answer it straight \
away, as yourself, in one or two sentences. Set position to your own honest yes, no or unsure. Set \
factIds to the ids of the facts below that your answer really relies on, or leave it empty if it \
relies on none of them. factIds is a separate field: never mention an id in your answer.
{facts}"""


def _numbered_facts(persona: Persona) -> dict[str, Fact]:
    facts = persona.jobs + persona.pains + persona.objections
    return {f"F{i}": fact for i, fact in enumerate(facts, start=1)}


def _relies_on_grounded(answer: ProbeAnswer, facts: dict[str, Fact]) -> bool:
    """More grounded than guessed facts among those cited; an answer citing nothing never counts."""
    cited = [facts[i] for i in set(answer.fact_ids) if i in facts]
    grounded = sum(fact.label == "grounded" for fact in cited)
    return grounded > len(cited) - grounded


def _ask_all(
    ask: Callable[[str, str], ProbeAnswer], instructions: str, questions: tuple[str, ...], budget
) -> list[ProbeAnswer]:
    """All answers in question order, or raise on the first failure or when the budget runs out."""
    pool = ThreadPoolExecutor(max_workers=len(questions) * RUNS)
    try:
        futures = [
            # Each call gets a copy of the context, or its log line would lose the request id.
            pool.submit(contextvars.copy_context().run, ask, instructions, question)
            for question in questions
            for _ in range(RUNS)
        ]
        done, pending = wait(futures, timeout=budget, return_when=FIRST_EXCEPTION)
        for future in done:
            future.result()
        if pending:
            raise TimeoutError
        return [future.result() for future in futures]
    finally:
        # Never wait for a hanging call: the provider timeout ends it after we have responded.
        pool.shutdown(wait=False, cancel_futures=True)


def score_readiness(
    persona: Persona,
    sources: list[PersonaSource],
    ask: Callable[[str, str], ProbeAnswer],
    elapsed: float,
) -> Readiness | None:
    """The persona's score, or None if any run fails; `elapsed` is the time the request has used."""
    try:
        budget = min(BUDGET_SECONDS, LATEST_END_SECONDS - elapsed)
        if budget <= 0:
            raise TimeoutError
        facts = _numbered_facts(persona)
        instructions = "\n\n".join(
            [
                persona_instructions(persona, sources=sources),
                CHECK.format(facts="\n".join(f"{i}: {f.text}" for i, f in facts.items())),
            ]
        )
        answers = _ask_all(ask, instructions, PROBES[persona.language], budget)
    except Exception as exc:  # noqa: BLE001 - any failure here must not fail persona creation
        # Only the type: provider messages can echo request content.
        logger.warning("readiness unavailable: %s", type(exc).__name__)
        return None

    pairs = list(zip(answers[::RUNS], answers[1::RUNS], strict=True))
    consistency = sum(a.position == b.position for a, b in pairs) / len(pairs)
    grounding = sum(_relies_on_grounded(a, facts) for a in answers) / len(answers)
    return Readiness(
        score=round(consistency * grounding, 2),
        consistency=round(consistency, 2),
        grounding=round(grounding, 2),
    )
