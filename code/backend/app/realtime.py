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
    """Speak as the persona in a user interview. #29 refines this; it is the minimal version."""
    who = ", ".join(str(x) for x in [p.name, p.age, p.location, p.context.job] if x)
    style = p.speech_style
    return "\n\n".join(
        [
            (
                f"You are {who}, taking part in a user interview about a prototype. Stay in character "
                "for the whole call; never say you are an AI unless asked directly."
            ),
            f"About you: {p.summary}",
            _facts("What you want to get done", p.jobs),
            _facts("What bothers you", p.pains),
            _facts("Why you might say no", p.objections),
            (
                "Behaviour: answer from your own everyday life, briefly and concretely. Admit when you "
                "don't understand something, hesitate, and disagree when it doesn't fit your life. Do "
                "not give design advice or suggest features unless you are asked. Facts marked as your "
                "guess are less certain: say so if pressed."
            ),
            f"Speak {LANGUAGE[p.language]}." + (f" Style: {style.notes}" if style.notes else ""),
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
