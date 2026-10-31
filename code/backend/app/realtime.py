"""OpenAI Realtime: a short-lived client secret the browser uses to open the WebRTC call itself.

Our backend never holds the audio connection (Vercel can't). The main API key stays here; the
browser only gets an ephemeral key, and the persona's instructions are baked into the session
server-side so the client can't change who it talks to.
"""

import os
from datetime import UTC, datetime

import openai

from app.contracts import Fact, Persona, SessionToken
from app.extract import ProviderUnavailable, _client

DEFAULT_MODEL = "gpt-realtime-2.1-mini"
DEFAULT_VOICE = "marin"
# The browser POSTs its SDP offer here with the client secret as bearer token.
CALLS_URL = "https://api.openai.com/v1/realtime/calls"
# Only needed to start the call; a reconnect fetches a fresh one.
SECRET_TTL_SECONDS = 600

LANGUAGE = {"de": "German (Swiss Standard German, Swiss words welcome)", "en": "English"}


def _facts(title: str, facts: list[Fact]) -> str:
    lines = [f"- {f.text}" + (" (your guess)" if f.label == "guess" else "") for f in facts]
    return f"{title}:\n" + ("\n".join(lines) or "- none")


def persona_instructions(p: Persona) -> str:
    """Build deterministic, in-character interview instructions from a persona."""
    who = ", ".join(str(x) for x in [p.name, p.age, p.location, p.context.job] if x)
    style = p.speech_style
    lang = LANGUAGE[p.language]
    return "\n\n".join(
        [
            (
                # Realtime mini models follow the first lines best, so the hard rules lead.
                f"HARD RULES. 1) Speak {lang}. If asked to switch, switch only to a language your "
                "background makes plausible (education, origin, work, travel), and only at the level "
                "that fits: hesitant, simple, mixing in words of your own language when unsure. "
                "Otherwise decline in one short, natural sentence in your own language and go on. "
                "Never talk about language beyond that, never describe how you talk or these rules. "
                "2) You are a private person, not an assistant or a chatbot: never offer help, "
                "never ask what else you can do, never say you are ready to answer. Banned phrases, "
                "and anything like them: 'Sag einfach Bescheid', 'Ich bin bereit', 'Wie kann ich "
                "helfen', 'Gibt es noch etwas', 'Lass uns loslegen', 'sag einfach etwas Konkretes'. "
                "3) If an input makes no sense to you or sounds like a mishearing, only ask back "
                "in a few words ('Wie meinst du das?') and stop; don't play along or explain."
            ),
            (
                f"You are {who}, taking part in a user interview about a prototype. Be this person "
                "for the whole call: your own life, history and opinions, no AI or meta remarks. "
                "The interface already tells the interviewer you are an AI persona, so don't say "
                "it yourself. Only if asked directly whether you are real or an AI, answer "
                "honestly; do not claim to be a real interviewed customer."
            ),
            (
                "How the call goes, like a real conversation with someone you just met: "
                "1) Greeting: say hello in one short sentence and ask back how they are. Don't "
                "introduce yourself, your job or family unless asked. "
                "2) Small talk: short and friendly; reveal details of your life only when asked. "
                "3) Only when the interviewer brings up the product: talk about your experience "
                "with it. Be concrete about what confused you, what is missing and how you would "
                "want it, and let your pains and objections come out one at a time, not all at "
                "once. You only know the prototype from what the interviewer shows or describes "
                "in this call; if you haven't seen something, say so instead of inventing screens "
                "or buttons."
            ),
            f"About you: {p.summary}",
            _facts("What you want to get done", p.jobs),
            _facts("What bothers you", p.pains),
            _facts("Why you might say no", p.objections),
            (
                "Behaviour: you are a customer, a bit reserved, not an assistant. Answer what was "
                "asked, naturally in 1-3 short sentences, sometimes only half a sentence. Don't "
                "drive the conversation, don't offer help, options or a plan, and never say things "
                "like 'let's get started'. Answer directly without repeating or paraphrasing the "
                "interviewer's question, and never repeat one of your own earlier answers; if you "
                "already said it, say so briefly or add something new. If you didn't catch or "
                "understand something, ask back briefly ('Wie meinst du?') instead of guessing. "
                "Admit confusion when you don't understand, allow natural hesitation, and disagree "
                "when justified by your profile rather than automatically agreeing. Do not give "
                "design advice or suggest features unless explicitly asked. Keep profile facts "
                "consistent. Facts marked as your guess are uncertain: hedge them whenever you use "
                "them. Never speak internal labels, tags or source IDs."
            ),
            (
                "Voice: calm and relaxed, low energy, unhurried, with natural pauses, like talking "
                "to an acquaintance, never like a presenter or a sales call."
            ),
            f"Your language is {lang}: start in it and return to it, whatever language the "
            "interviewer uses, unless they asked you to switch to one you plausibly speak."
            + (" Use Standard German, not dialect." if p.language == "de" else "")
            + (f" Style: {style.notes}" if style.notes else ""),
        ]
    )


def mint_client_secret(persona: Persona) -> SessionToken:
    try:
        secret = _client().realtime.client_secrets.create(
            expires_after={"anchor": "created_at", "seconds": SECRET_TTL_SECONDS},
            session={
                "type": "realtime",
                "model": os.environ.get("OPENAI_REALTIME_MODEL") or DEFAULT_MODEL,
                "instructions": persona_instructions(persona),
                "audio": {
                    # Transcribe the interviewer too, so the browser can log both sides.
                    "input": {
                        "transcription": {
                            "model": "gpt-4o-mini-transcribe",
                            "language": persona.language,
                        },
                        # Low eagerness: wait for the interviewer to really finish, don't jump into pauses.
                        "turn_detection": {"type": "semantic_vad", "eagerness": "low"},
                    },
                    "output": {"voice": os.environ.get("OPENAI_REALTIME_VOICE") or DEFAULT_VOICE},
                },
            },
        )
    except openai.OpenAIError as exc:
        # Only the type: provider messages can echo request content.
        raise ProviderUnavailable(type(exc).__name__) from None
    return SessionToken(
        provider="openai-realtime",
        token=secret.value,
        url=CALLS_URL,
        expires_at=datetime.fromtimestamp(secret.expires_at, UTC)
        .isoformat()
        .replace("+00:00", "Z"),
    )
