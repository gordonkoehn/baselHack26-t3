#!/usr/bin/env bash
# No arguments: boot the local stack. One origin: check an existing deployment.
set -euo pipefail
cd "$(dirname "$0")/.."
exec python3 - "$@" <<'PY'
import json
import os
import re
import signal
import socket
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from urllib.parse import urlsplit


class SmokeFailure(Exception):
    pass


def fail(message):
    raise SmokeFailure(message)


def origin(value):
    parsed = urlsplit(value)
    if (
        parsed.scheme not in {"http", "https"}
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.path not in {"", "/"}
        or parsed.query
        or parsed.fragment
        or any(ord(c) <= 32 or ord(c) >= 127 for c in value)
    ):
        fail("target must be a plain HTTP(S) origin")
    if parsed.scheme != "https" and parsed.hostname not in {"localhost", "127.0.0.1", "::1"}:
        fail("remote targets require HTTPS")
    # Accessing port also rejects malformed port numbers before making requests.
    parsed.port
    return value.rstrip("/")


def header(name, value):
    if not re.fullmatch(r"[A-Za-z0-9-]+", name) or any(ord(c) < 32 or ord(c) == 127 for c in value):
        fail("invalid authentication header configuration")
    escaped = (name + ": " + value).replace("\\", "\\\\").replace('"', '\\"')
    return f'header = "{escaped}"\n'


def request(base, path, expected, config, payload=None):
    # No redirects, curlrc, verbose errors or inherited retry policy. Never retry writes.
    command = [
        "curl", "-q", "--silent", "--config", "-", "--connect-timeout", "3",
        "--max-time", "10", "--retry", "0", "--proto", "=http,https",
        "--max-redirs", "0", "--write-out", "\n%{http_code}",
    ]
    if payload is not None:
        command += ["--request", "POST", "--header", "Content-Type: application/json",
                    "--data-binary", json.dumps(payload)]
    command += ["--url", base + path]
    try:
        result = subprocess.run(command, input=config, capture_output=True, text=True, timeout=12)
    except subprocess.TimeoutExpired:
        fail(f"{path}: request exceeded overall timeout")
    if result.returncode:
        fail(f"{path}: transport failure (curl exit {result.returncode})")
    body, separator, status = result.stdout.rpartition("\n")
    if not separator or status != str(expected):
        # Do not echo response bodies, curl stderr, target URLs or auth headers.
        fail(f"{path}: unexpected HTTP status (expected {expected})")
    return body


def document(body, label):
    try:
        result = json.loads(body)
    except ValueError:
        fail(f"{label}: invalid JSON")
    if not isinstance(result, dict):
        fail(f"{label}: expected JSON object")
    return result


def health(base, config):
    if document(request(base, "/api/health", 200, config), "health").get("status") != "ok":
        fail("/api/health: status is not ok")


def remote(base):
    allowed = os.environ.get("SMOKE_ALLOWED_ORIGIN", "")
    if not allowed or origin(allowed) != base:
        fail("SMOKE_ALLOWED_ORIGIN must match the explicitly trusted target")
    persona = os.environ.get("SMOKE_PERSONA_ID", "")
    if not re.fullmatch(r"[A-Za-z0-9_-]{1,128}", persona):
        fail("SMOKE_PERSONA_ID must name a pre-existing synthetic persona")
    name = os.environ.get("SMOKE_AUTH_HEADER_NAME", "")
    value = os.environ.get("SMOKE_AUTH_HEADER_VALUE", "")
    if bool(name) != bool(value):
        fail("both SMOKE_AUTH_HEADER_NAME and SMOKE_AUTH_HEADER_VALUE are required for auth")
    config = header(name, value) if name else ""
    bypass = os.environ.get("SMOKE_VERCEL_BYPASS_TOKEN", "")
    if bypass:
        config += header("x-vercel-protection-bypass", bypass)
    health(base, config)
    request(base, "/", 200, config)
    guide = ["Synthetic deployment smoke check; no interview or provider calls."]
    created = document(request(base, "/api/sessions", 201, config,
                               {"personaId": persona, "interviewGuide": guide}), "session create")
    sid = created.get("id", "")
    if not isinstance(sid, str) or not re.fullmatch(r"s_[A-Za-z0-9_-]+", sid):
        fail("session create: invalid session ID")
    if (created.get("personaId") != persona or created.get("status") != "created"
            or created.get("interviewGuide") != guide):
        fail("session create: unexpected stored fields")
    read = document(request(base, "/api/sessions/" + sid, 200, config), "session read")
    if read != created:
        fail("session read: persisted session differs from create response")


def local():
    # Refuse occupied local ports rather than accidentally validating another dev server.
    for port in (8000, 3000):
        try:
            with socket.socket() as probe:
                probe.bind(("127.0.0.1", port))
        except OSError:
            fail("local port already occupied or unavailable; stop the existing stack first")
    processes = []
    # Private per-invocation logs; never dump logs that might contain sensitive values.
    with tempfile.TemporaryDirectory(prefix="smoke-") as logs:
        try:
            for folder, command in [
                ("backend", ["uv", "run", "uvicorn", "app.main:app", "--port", "8000"]),
                ("frontend", ["npx", "next", "start", "-p", "3000"]),
            ]:
                with (Path(logs) / (folder + ".log")).open("w") as output:
                    processes.append(subprocess.Popen(command, cwd=folder, stdout=output,
                                                       stderr=output, start_new_session=True))
            # Fixed budget: at most 30 requests, each at most 12 seconds, plus 29 sleeps.
            for attempt in range(30):
                if any(p.poll() is not None for p in processes):
                    fail("local server exited during startup; check build and port availability")
                try:
                    health("http://localhost:3000", "")
                    break
                except SmokeFailure:
                    if attempt == 29:
                        raise
                    time.sleep(1)
            request("http://localhost:3000", "/", 200, "")
        finally:
            # Each group was created by this invocation; never search/kill by command name.
            for process in processes:
                try:
                    os.killpg(process.pid, signal.SIGTERM)
                except ProcessLookupError:
                    pass
            for process in processes:
                try:
                    process.wait(timeout=3)
                except subprocess.TimeoutExpired:
                    try:
                        os.killpg(process.pid, signal.SIGKILL)
                    except ProcessLookupError:
                        pass
                    process.wait(timeout=3)


def interrupted(signum, frame):
    fail("interrupted")


signal.signal(signal.SIGTERM, interrupted)
signal.signal(signal.SIGINT, interrupted)
try:
    if len(sys.argv) == 1:
        local()
    elif len(sys.argv) == 2:
        remote(origin(sys.argv[1]))
    else:
        fail("usage: smoke.sh [base-origin]")
except (SmokeFailure, OSError, ValueError) as error:
    # OS/URL parser exceptions may carry user-supplied text; print only controlled diagnostics.
    print("smoke FAILED: " + (str(error) if isinstance(error, SmokeFailure) else "invalid configuration or command unavailable"), file=sys.stderr)
    sys.exit(1)
print("smoke OK")
PY
