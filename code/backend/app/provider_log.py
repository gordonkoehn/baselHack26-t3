"""One structured log line per provider call, so a failed demo call can be traced on Vercel.

Only fixed fields and the exception's class name are logged, never its message: provider errors
can echo request content, and prompts, transcripts and keys must stay out of the logs.
"""

import json
import logging
import sys
import time
from collections.abc import Iterator
from contextlib import contextmanager
from contextvars import ContextVar

# Set per request in main.py and returned as a response header, to match an error to its log line.
request_id: ContextVar[str | None] = ContextVar("request_id", default=None)

logger = logging.getLogger("app.provider")
# The root logger stays at WARNING under uvicorn, which would silently drop these lines. An own
# handler without propagation prints exactly one line, whatever the host configures on root.
logger.setLevel(logging.INFO)
logger.addHandler(logging.StreamHandler(sys.stdout))
logger.propagate = False


@contextmanager
def provider_call(provider: str, operation: str, session_id: str | None = None) -> Iterator[None]:
    """Log one line when the block ends. Wrap the raw call, inside any mapping of its errors."""
    start = time.perf_counter()
    error = http_status = None
    try:
        yield
    except Exception as exc:
        error = type(exc).__name__
        # openai.APIStatusError and httpx.HTTPStatusError both carry the response.
        http_status = getattr(getattr(exc, "response", None), "status_code", None)
        raise
    finally:
        logger.info(
            json.dumps(
                {
                    "event": "provider_call",
                    "provider": provider,
                    "operation": operation,
                    "status": "error" if error else "ok",
                    "error": error,
                    "http_status": http_status,
                    "latency_ms": round((time.perf_counter() - start) * 1000),
                    "session_id": session_id,
                    "request_id": request_id.get(),
                }
            )
        )
