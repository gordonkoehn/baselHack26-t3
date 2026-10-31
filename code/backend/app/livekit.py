"""LiveKit: short-lived room tokens for the browser. No network call, the JWT is signed locally.

The persona worker runs outside Vercel. It is dispatched by name through the token's room
configuration, which LiveKit applies once, when the first participant creates the room. A refreshed
token joins the existing room, so it never starts a second worker or a second room.
"""

import json
import os
from datetime import UTC, datetime, timedelta

from livekit import api as lk

from app.contracts import SessionToken

# Long enough for a 30-minute interview plus reconnects; the browser fetches a new one after that.
TOKEN_TTL = timedelta(hours=2)
DEFAULT_AGENT = "opentwin-persona"


class LiveKitUnavailable(Exception):
    """LIVEKIT_URL / _API_KEY / _API_SECRET missing. Endpoints map this to 503."""


def room_name(session_id: str) -> str:
    return f"opentwin-{session_id}"


def livekit_url() -> str | None:
    return os.environ.get("LIVEKIT_URL") or None


def mint_token(session_id: str, persona_id: str, now: datetime | None = None) -> SessionToken:
    url = livekit_url()
    key = os.environ.get("LIVEKIT_API_KEY")
    secret = os.environ.get("LIVEKIT_API_SECRET")
    if not (url and key and secret):
        raise LiveKitUnavailable(
            "LIVEKIT_URL / LIVEKIT_API_KEY / LIVEKIT_API_SECRET not configured"
        )
    expires = (now or datetime.now(UTC)) + TOKEN_TTL
    dispatch = lk.RoomAgentDispatch(
        agent_name=os.environ.get("LIVEKIT_AGENT_NAME") or DEFAULT_AGENT,
        # The worker reads this to load the persona and to post transcript events.
        metadata=json.dumps({"sessionId": session_id, "personaId": persona_id}),
    )
    token = (
        lk.AccessToken(key, secret)
        .with_identity(f"interviewer-{session_id}")
        .with_name("Interviewer")
        .with_ttl(TOKEN_TTL)
        .with_grants(
            lk.VideoGrants(
                room_join=True,
                room=room_name(session_id),
                can_publish=True,
                can_subscribe=True,
                can_publish_data=True,
            )
        )
        .with_room_config(lk.RoomConfiguration(agents=[dispatch]))
        .to_jwt()
    )
    return SessionToken(
        provider="livekit",
        token=token,
        url=url,
        expires_at=expires.isoformat().replace("+00:00", "Z"),
    )
