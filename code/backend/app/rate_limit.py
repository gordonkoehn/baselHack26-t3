"""Per-IP and global limits for the routes that spend provider credit (#67).

The global cap is the real credit guarantee. The per-IP limit is best effort: it trusts the first
X-Forwarded-For entry, which may not be the visitor behind the frontend's rewrite and may be
spoofable on direct calls. Store trouble is a 503: without counting we can't protect the credit.
"""

import hashlib
import math
import os
from collections.abc import Callable
from typing import Annotated

from fastapi import Depends, HTTPException, Request

from app.store import Store, get_store

WINDOW_SECONDS = 3600

# bucket: (per IP, all visitors together), per window. Generous on purpose: a venue shares one
# public IP and every reconnect fetches fresh tokens.
LIMITS = {
    "personas": (60, 150),
    "sources": (120, 300),
    "tokens": (120, 300),  # token + avatar-token: an interview start uses one of each
    "debrief": (60, 150),
}


def _multiplier() -> float:
    """RATE_LIMIT_MULTIPLIER loosens every limit on demo day. A typo keeps the normal limits."""
    try:
        value = float(os.environ.get("RATE_LIMIT_MULTIPLIER") or 1)
    except ValueError:
        return 1.0
    return value if math.isfinite(value) and value > 0 else 1.0


def _client_ip(request: Request) -> str:
    forwarded = request.headers.get("x-forwarded-for", "").split(",")[0].strip()
    return forwarded or (request.client.host if request.client else "unknown")


def _too_many(scope: str, seconds_left: int) -> HTTPException:
    wait = max(1, seconds_left)
    return HTTPException(
        429,
        f"Too many requests {scope}. Try again in {math.ceil(wait / 60)} min.",
        headers={"Retry-After": str(wait)},
    )


def rate_limit(bucket: str) -> Callable[[Request, Store], None]:
    """A route dependency. List it after require_passcode so wrong passcodes aren't counted."""

    def check(request: Request, store: Annotated[Store, Depends(get_store)]) -> None:
        per_ip, overall = (max(1, int(n * _multiplier())) for n in LIMITS[bucket])
        ip_hash = hashlib.sha256(_client_ip(request).encode()).hexdigest()[:16]
        # IP first: a client already over its own limit must not use up everyone's budget.
        count, seconds_left = store.count_hit(f"{bucket}:ip:{ip_hash}", WINDOW_SECONDS)
        if count > per_ip:
            raise _too_many("from this network", seconds_left)
        count, seconds_left = store.count_hit(f"{bucket}:all", WINDOW_SECONDS)
        if count > overall:
            raise _too_many("to this demo right now", seconds_left)

    return check
