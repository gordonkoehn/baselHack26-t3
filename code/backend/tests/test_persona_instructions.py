import json
from pathlib import Path

import pytest
from pydantic import ValidationError

from app.contracts import Language, Persona
from app.realtime import persona_instructions

EXAMPLE = Path(__file__).parents[2] / "shared" / "examples" / "persona.json"


@pytest.fixture
def persona() -> Persona:
    return Persona.model_validate(json.loads(EXAMPLE.read_text()))


def test_answers_are_short_natural_and_direct(persona: Persona) -> None:
    text = persona_instructions(persona)
    assert "naturally in 1-3 short sentences" in text
    assert "without repeating or paraphrasing the interviewer's question" in text


def test_conversation_starts_with_small_talk_not_a_pitch(persona: Persona) -> None:
    text = persona_instructions(persona)
    assert "Don't introduce yourself, your job or family unless asked" in text
    assert "Only when the interviewer brings up the product" in text
    assert "instead of inventing screens or buttons" in text
    assert "never say things like 'let's get started'" in text
    assert "never repeat one of your own earlier answers" in text
    assert "ask back briefly" in text


def test_persona_can_be_uncertain_and_disagree(persona: Persona) -> None:
    text = persona_instructions(persona)
    assert "Admit confusion when you don't understand" in text
    assert "natural hesitation" in text
    assert "disagree when justified by your profile" in text
    assert "Do not give design advice or suggest features unless explicitly asked" in text
    assert "hedge them whenever you use them" in text


def test_stays_in_character_and_is_honest_only_when_asked(persona: Persona) -> None:
    # Johan's decision: the UI labels the AI persona; the persona itself doesn't break character.
    text = persona_instructions(persona)
    assert "no AI or meta remarks" in text
    assert "don't say it yourself" in text
    assert "Only if asked directly whether you are real or an AI, answer honestly" in text
    assert "do not claim to be a real interviewed customer" in text
    assert "disclose" not in text


@pytest.mark.parametrize(("language", "guidance"), [("de", "German"), ("en", "English")])
def test_answers_follow_persona_language(
    persona: Persona, language: Language, guidance: str
) -> None:
    persona.language = language
    persona.speech_style.notes = None
    text = persona_instructions(persona)
    assert f"Your language is {guidance}" in text
    # Johan: switching depends on the persona's background, at a realistic level.
    assert "switch only to a language your background makes plausible" in text
    assert "Otherwise decline in one short, natural sentence" in text
    if language == "de":
        assert "Swiss Standard German" in text
        assert "not dialect" in text
    else:
        assert "Swiss Standard German" not in text


def test_profile_and_speech_notes_are_preserved(persona: Persona) -> None:
    text = persona_instructions(persona)
    for value in (persona.name, str(persona.age), persona.location, persona.context.job):
        assert value and value in text
    assert persona.summary in text
    assert persona.speech_style.notes and f"Style: {persona.speech_style.notes}" in text
    assert "Keep profile facts consistent" in text


@pytest.mark.parametrize("field", ["jobs", "pains", "objections"])
def test_facts_keep_their_order_and_guess_markers(persona: Persona, field: str) -> None:
    text = persona_instructions(persona)
    facts = {"jobs": persona.jobs, "pains": persona.pains, "objections": persona.objections}[field]
    lines = text.splitlines()
    positions = []
    for fact in facts:
        suffix = " (your guess)" if fact.label == "guess" else ""
        positions.append(lines.index(f"- {fact.text}{suffix}"))
    assert positions == sorted(positions)


def test_internal_metadata_is_not_spoken_or_included(persona: Persona) -> None:
    persona.id = "private-persona-id"
    for evidence in persona.evidence:
        evidence.id = "private-evidence-id"
        evidence.source_ref = "private-source-id"
    for fact in persona.jobs + persona.pains + persona.objections:
        if fact.label == "grounded":
            fact.evidence_id = "private-evidence-id"
    text = persona_instructions(persona)
    assert "Never speak internal labels, tags or source IDs" in text
    for internal_id in ("private-persona-id", "private-evidence-id", "private-source-id"):
        assert internal_id not in text


def test_nullable_profile_and_guess_evidence_are_supported(persona: Persona) -> None:
    data = persona.model_dump(by_alias=True)
    data.update(
        age=None,
        location=None,
        context={"job": None},
        speechStyle={"notes": None},
        jobs=[{"text": "May try it later", "label": "guess", "evidenceId": None}],
        pains=[],
        objections=[],
    )
    sparse = Persona.model_validate(data)
    text = persona_instructions(sparse)
    assert sparse.jobs[0].evidence_id is None
    assert "- May try it later (your guess)" in text
    assert "What bothers you:\n- none" in text
    assert "Why you might say no:\n- none" in text
    assert "None" not in text
    assert "Style:" not in text
    del data["jobs"][0]["evidenceId"]
    with pytest.raises(ValidationError) as error:
        Persona.model_validate(data)
    assert error.value.errors()[0]["loc"] == ("jobs", 0, "evidenceId")


def test_construction_is_deterministic_and_does_not_mutate(persona: Persona) -> None:
    before = persona.model_dump()
    text = persona_instructions(persona)
    assert persona_instructions(persona) == text
    assert persona_instructions(Persona.model_validate(before)) == text
    assert persona.model_dump() == before
