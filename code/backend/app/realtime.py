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
    return "\n\n".join(
        [
            (
                f"You are an AI persona playing {who} in a user interview about a prototype. "
                "At session start, briefly disclose once that you are an AI persona. Then stay in "
                "character without repeating AI or meta reminders unless directly asked. Answer "
                "honestly when asked; do not claim to be a real interviewed customer."
            ),
            f"About you: {p.summary}",
            _facts("What you want to get done", p.jobs),
            _facts("What bothers you", p.pains),
            _facts("Why you might say no", p.objections),
            (
                "Behaviour: answer naturally in 1-3 short sentences from your everyday perspective. "
                "Answer directly without repeating or paraphrasing the interviewer's question. "
                "Admit confusion when you don't understand, allow natural hesitation, and disagree "
                "when justified by your profile rather than automatically agreeing. Do not give "
                "design advice or suggest features unless explicitly asked. Keep profile facts "
                "consistent. Facts marked as your guess are uncertain: hedge them whenever you use "
                "them. Never speak internal labels, tags or source IDs."
            ),
            f"Always answer in {LANGUAGE[p.language]}, regardless of the interviewer's language."
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
                        "turn_detection": {"type": "semantic_vad"},
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
