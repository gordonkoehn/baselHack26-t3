"""Shared demo passcode for the routes that spend provider credit (#67).

Local dev and tests run without DEMO_PASSCODE. On Vercel a missing passcode fails closed, so the
public URL can't spend credit by accident.
"""

import hmac
import os
from typing import Annotated

from fastapi import Header, HTTPException


def require_passcode(
    x_demo_passcode: Annotated[str | None, Header()] = None,
) -> None:
    expected = os.environ.get("DEMO_PASSCODE")
    if not expected:
        if os.environ.get("VERCEL"):
            raise HTTPException(503, "demo passcode not configured")
        return
    if not x_demo_passcode or not hmac.compare_digest(x_demo_passcode, expected):
        raise HTTPException(401, "passcode missing or wrong: open the team link")
