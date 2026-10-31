"""Simli avatar: a short-lived session token the browser uses to open the avatar stream itself.

Like the voice, the avatar video never passes through our backend. The Simli API key stays here.
"""

import os
import re
from datetime import UTC, datetime, timedelta

import httpx

from app.contracts import Persona, SessionToken
from app.extract import ProviderUnavailable
from app.provider_log import provider_call

TOKEN_URL = "https://api.simli.ai/compose/token"
# Simli's documented example preset (Trinity-2 face "Anna").
DEFAULT_FACE = "bf13113a-355a-4d97-8b90-4edccd1da7b2"
# A full interview is 20-30 minutes; Simli stops the session after this.
MAX_SESSION_SECONDS = 1800
MAX_IDLE_SECONDS = 300
UUID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$")


def face_for(persona: Persona) -> str:
    # Personas carry a stock id until faces are chosen per persona; only a Simli UUID is used.
    if UUID.match(persona.face_id):
        return persona.face_id
    return os.environ.get("SIMLI_FACE_ID") or DEFAULT_FACE


def mint_session_token(persona: Persona, session_id: str | None = None) -> SessionToken:
    try:
        with provider_call("simli", "avatar_token", session_id):
            key = os.environ.get("SIMLI_API_KEY")
            if not key:
                raise ProviderUnavailable("SIMLI_API_KEY not configured")
            res = httpx.post(
                TOKEN_URL,
                headers={"x-simli-api-key": key},
                json={
                    "faceId": face_for(persona),
                    "handleSilence": True,
                    "maxSessionLength": MAX_SESSION_SECONDS,
                    "maxIdleTime": MAX_IDLE_SECONDS,
                },
                timeout=15,
            )
            res.raise_for_status()
            body = res.json()
            token = body.get("session_token") if isinstance(body, dict) else None
            if not isinstance(token, str) or not token or token == "FAIL TOKEN":
                raise ProviderUnavailable("no Simli session token")
    except (httpx.HTTPError, ValueError) as exc:
        # Only the type: the response body could echo request details.
        raise ProviderUnavailable(type(exc).__name__) from None
    expires = datetime.now(UTC) + timedelta(seconds=MAX_SESSION_SECONDS)
    return SessionToken(
        provider="simli",
        token=token,
        url=None,
        expires_at=expires.isoformat().replace("+00:00", "Z"),
    )
