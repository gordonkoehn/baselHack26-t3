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
    # Personas carry a stock id until faces are chosen per persona; only a Simli UUID is used,
    # or a face Simli built from the persona's photo (its id format isn't documented).
    custom = persona.custom_face
    if UUID.match(persona.face_id) or (
        custom and custom.status == "completed" and custom.face_id == persona.face_id
    ):
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


FACES_URL = "https://api.simli.ai/faces/trinity"


class FaceQuotaExceeded(Exception):
    """Simli refused a new face: the account has no Trinity-2 generations left. Maps to 409."""


class FaceRejected(Exception):
    """Simli could not use the photo (e.g. no clear face). Maps to 422."""


def _key() -> str:
    key = os.environ.get("SIMLI_API_KEY")
    if not key:
        raise ProviderUnavailable("SIMLI_API_KEY not configured")
    return key


def generate_face(image: bytes, mime: str, name: str) -> tuple[str, int | None]:
    """Queue a Trinity-2 face built from a portrait. Returns (face id, dispatch_after or None).

    Uses one of the account's paid generations; Simli frames the photo itself (~25 s).
    """
    try:
        with provider_call("simli", "generate_face"):
            res = httpx.post(
                FACES_URL,
                headers={"x-simli-api-key": _key()},
                params={"face_name": name},
                files={"image": ("photo", image, mime)},
                timeout=90,
            )
            if res.status_code == 403:
                raise FaceQuotaExceeded()
            if res.status_code in (400, 422):
                raise FaceRejected()
            res.raise_for_status()
            body = res.json()
            face_id = body.get("face_id") if isinstance(body, dict) else None
            if not isinstance(face_id, str) or not face_id:
                raise ProviderUnavailable("no Simli face id")
    except (httpx.HTTPError, ValueError) as exc:
        raise ProviderUnavailable(type(exc).__name__) from None
    after = body.get("dispatch_after")
    return face_id, after if isinstance(after, int) else None


def face_status(face_id: str) -> tuple[str, int | None]:
    """(status, dispatch_after) of one generation; status is pending/processing/completed/failed."""
    try:
        with provider_call("simli", "face_status"):
            res = httpx.get(
                f"{FACES_URL}/generation_status",
                headers={"x-simli-api-key": _key()},
                params={"face_id": face_id},
                timeout=15,
            )
            res.raise_for_status()
            body = res.json()
    except (httpx.HTTPError, ValueError) as exc:
        raise ProviderUnavailable(type(exc).__name__) from None
    mine = next(
        (g for g in body.get("generations", []) if g.get("face_id") == face_id),
        body if body.get("face_id") == face_id else {},
    )
    status = mine.get("status")
    # Simli forgets generations 24 h after they finish; "not_found" then means nothing usable.
    if status not in ("pending", "processing", "completed", "failed"):
        status = "failed"
    after = mine.get("dispatch_after")
    return status, after if isinstance(after, int) else None
