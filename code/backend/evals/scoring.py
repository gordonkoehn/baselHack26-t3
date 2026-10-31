"""Cheap, objective checks on raw model output. No provider calls, so tests can run them offline.

They score the draft BEFORE ground_draft and build_report repair it: the server hides a bad quote
from users, so checking the repaired output would never notice that a prompt got worse.
"""

import re
from dataclasses import dataclass, field

from app import debrief
from app.contracts import Persona, PersonaCreate, Session, SessionEvent
from app.extract import DebriefDraft, ExtractionFailed, PersonaDraft

# The persona prompt asks for 1-3 short sentences; this leaves room for a long one among them.
MAX_REPLY_WORDS = 60

# Frequent words that exist in only one of the two languages ("was", "in", "also" are in both).
STOPWORDS = {
    "de": frozenset(
        [
            "aber",
            "auch",
            "bei",
            "dass",
            "den",
            "dem",
            "der",
            "das",
            "eine",
            "einen",
            "ich",
            "ist",
            "mit",
            "nicht",
            "sehr",
            "sich",
            "und",
            "von",
            "wenn",
            "wir",
            "zu",
            "für",
            "auf",
        ]
    ),
    "en": frozenset(
        [
            "and",
            "are",
            "but",
            "for",
            "from",
            "have",
            "not",
            "she",
            "that",
            "the",
            "they",
            "this",
            "very",
            "with",
            "would",
            "you",
        ]
    ),
}
WORD = re.compile(r"[\w’'-]+")
NUMBER = re.compile(r"\d+(?:[.,'’]\d+)*")
# Two or more capitalized words in a row. German capitalizes every noun, so a single capitalized
# word proves nothing; this catches "Nadine Meier" but not a lone invented "Meier".
NAME = re.compile(r"[A-ZÄÖÜ][\w’'-]+(?:\s+[A-ZÄÖÜ][\w’'-]+)+")


@dataclass
class Check:
    name: str
    passed: int
    total: int
    failures: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return self.passed == self.total

    @property
    def result(self) -> str:
        return f"{self.passed}/{self.total}"


def _check(name: str, items: list[str], is_bad) -> Check:
    failures = [item for item in items if is_bad(item)]
    return Check(name, len(items) - len(failures), len(items), failures)


def _at_least_one(name: str, count: int, what: str) -> Check:
    # Without these, a model that labels nothing grounded would pass every grounding check.
    return Check(name, int(count > 0), 1, [] if count else [f"no {what}"])


def _norm(text: str) -> str:
    return " ".join(text.split())


def wrong_language(text: str, expected: str) -> bool:
    """True only on clear evidence, so a short reply like "Ja, klar." never fails."""
    words = [word.casefold() for word in WORD.findall(text)]
    hits = {language: sum(w in stop for w in words) for language, stop in STOPWORDS.items()}
    other = max(count for language, count in hits.items() if language != expected)
    return other >= 2 and other > hits[expected]


def _numbers(text: str) -> set[str]:
    return {re.sub("['’]", "", n).replace(",", ".") for n in NUMBER.findall(text)}


def invented_numbers(text: str, corpus: str) -> set[str]:
    return _numbers(text) - _numbers(corpus)


def invented_names(text: str, corpus: str) -> list[str]:
    """Runs of capitalized words with a word from outside the corpus ("Bäckerei Keller").

    Heuristic, in both directions. A name opening a sentence ("Peter Keller vertraut") looks the
    same as "Klare Transparenz fehlt", so it passes; two nouns in a row with no article between
    them ("will Kindern Spielplätze") can fail. Failures are printed for a person to judge.
    """
    known = {word.casefold() for word in WORD.findall(corpus.replace("-", " "))}
    found = []
    for match in NAME.finditer(text):
        words = match.group().split()
        before = text[: match.start()].rstrip()
        # Any word can start a sentence capitalized, so the first one there says nothing.
        if not before or before[-1] in ".!?:":
            words = words[1:]
        parts = " ".join(words).replace("-", " ").split()
        if len(words) > 1 and any(part.casefold() not in known for part in parts):
            found.append(" ".join(words))
    return found


def score_persona(draft: PersonaDraft, request: PersonaCreate) -> list[Check]:
    """Only grounded facts must stay within the sources: the prompt asks for invented backstory."""
    sources = "\n".join(s.text for s in request.sources)
    normalized = [_norm(s.text) for s in request.sources]
    quoted = {e.id for e in draft.evidence if (e.quote or "").strip()}
    facts = draft.jobs + draft.pains + draft.objections
    grounded = [f for f in facts if f.label == "grounded"]
    uncited = [f.text for f in grounded if f.evidence_id not in quoted]
    persona_text = [draft.summary, *(f.text for f in facts)]
    return [
        _at_least_one("persona_has_grounded_facts", len(grounded), "grounded fact"),
        Check("grounded_facts_cite_evidence", len(grounded) - len(uncited), len(grounded), uncited),
        _check(
            "evidence_quotes_in_sources",
            [e.quote or "(no quote)" for e in draft.evidence],
            lambda quote: not _norm(quote) or not any(_norm(quote) in s for s in normalized),
        ),
        _check(
            "grounded_facts_no_invented_numbers",
            [f.text for f in grounded],
            lambda text: invented_numbers(text, sources),
        ),
        _check(
            "grounded_facts_no_invented_names",
            [f.text for f in grounded],
            # The prompt invents the persona's own name on purpose.
            lambda text: invented_names(text, f"{sources}\n{draft.name}"),
        ),
        _check(
            "persona_keeps_language",
            persona_text,
            lambda text: wrong_language(text, request.language),
        ),
    ]


def score_replies(replies: list[str], language: str) -> list[Check]:
    return [
        _check(
            "reply_length",
            replies,
            lambda reply: not 1 <= len(WORD.findall(reply)) <= MAX_REPLY_WORDS,
        ),
        _check("reply_keeps_language", replies, lambda reply: wrong_language(reply, language)),
    ]


def score_debrief(
    draft: DebriefDraft, session: Session, persona: Persona, events: list[SessionEvent]
) -> list[Check]:
    utterances = [e.data["text"] for e in events if e.type == "utterance"]
    persona_turns = {
        e.seq: e.data["text"]
        for e in events
        if e.type == "utterance" and e.data["speaker"] == "persona"
    }
    insights = [insight for question in draft.questions for insight in question.insights]
    themes = [insight.theme for insight in insights]
    # Stricter than build_report, which moves or drops a quote on the wrong turn.
    misquoted = [
        insight.quote or "(no quote)"
        for insight in insights
        if not insight.quote.strip() or insight.quote not in persona_turns.get(insight.turn_seq, "")
    ]
    # A finding may name the guide's topics and the persona, but nothing else from outside the call.
    corpus = "\n".join([*utterances, *session.interview_guide, persona.name])
    try:
        debrief.build_report(session, persona, events, draft)
        unusable = []
    except ExtractionFailed as exc:
        unusable = [str(exc)]
    return [
        Check("debrief_accepted_by_server", int(not unusable), 1, unusable),
        _at_least_one("debrief_has_insights", len(insights), "insight"),
        Check(
            "debrief_quotes_in_cited_turns",
            len(insights) - len(misquoted),
            len(insights),
            misquoted,
        ),
        _check(
            "debrief_no_invented_numbers",
            themes,
            lambda theme: invented_numbers(theme, corpus),
        ),
        _check(
            "debrief_no_invented_names",
            themes,
            lambda theme: invented_names(theme, corpus),
        ),
        _check(
            "debrief_keeps_language",
            themes,
            lambda theme: wrong_language(theme, persona.language),
        ),
    ]


def _ratio(result: str) -> float:
    passed, total = result.split("/")
    return int(passed) / int(total) if int(total) else 1.0


def format_table(checks: list[Check], previous: dict[str, str] | None = None) -> str:
    """The score table. `previous` is {check name: result} from the last saved run, if any."""
    previous = previous or {}
    width = max(len(check.name) for check in checks)
    lines = [f"{'check':<{width}}  {'score':>7}  {'last run':>8}  status"]
    for check in checks:
        last = previous.get(check.name)
        status = "ok" if check.ok else "FAIL"
        if last and _ratio(check.result) < _ratio(last):
            status += " (worse than last run)"
        lines.append(f"{check.name:<{width}}  {check.result:>7}  {last or '-':>8}  {status}")
    return "\n".join(lines)
