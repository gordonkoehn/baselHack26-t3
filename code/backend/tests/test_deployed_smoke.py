"""Exercise smoke orchestration without sockets, deployments, providers or subprocess servers."""

import json
import signal
import subprocess
import sys
from pathlib import Path
from types import SimpleNamespace

import pytest

ROOT = Path(__file__).resolve().parents[3]
SCRIPT = ROOT / "code/scripts/smoke.sh"
WORKFLOW = ROOT / ".github/workflows/deployed-smoke.yml"
GUIDE = ["Synthetic deployment smoke check; no interview or provider calls."]
SESSION = {"id": "s_test", "personaId": "p_smoke", "status": "created", "interviewGuide": GUIDE}


@pytest.fixture
def harness(monkeypatch):
    for key in (
        "SMOKE_ALLOWED_ORIGIN",
        "SMOKE_PERSONA_ID",
        "SMOKE_AUTH_HEADER_NAME",
        "SMOKE_AUTH_HEADER_VALUE",
        "SMOKE_VERCEL_BYPASS_TOKEN",
    ):
        monkeypatch.delenv(key, raising=False)
    monkeypatch.setenv("SMOKE_ALLOWED_ORIGIN", "http://127.0.0.1:9999")
    monkeypatch.setenv("SMOKE_PERSONA_ID", "p_smoke")
    calls, processes, killed = [], [], []
    replies = {}
    failures = []

    def run(command, **kwargs):
        calls.append((command, kwargs))
        path = command[-1].split(":9999")[-1].split(":3000")[-1]
        if failures:
            effect = failures.pop(0)
            if isinstance(effect, Exception):
                raise effect
            if effect:
                return SimpleNamespace(returncode=effect, stdout="", stderr="private credential")
        status, body = replies.get(path, (None, None))
        if status is None:
            status = 201 if path == "/api/sessions" else 200
            body = SESSION if path.startswith("/api/sessions") else {"status": "ok"}
        return SimpleNamespace(
            returncode=0,
            stdout=(body if isinstance(body, str) else json.dumps(body)) + f"\n{status}",
            stderr="private credential",
        )

    def popen(command, **kwargs):
        process = SimpleNamespace(pid=10000 + len(processes), command=command, options=kwargs)
        process.poll = lambda: None
        process.wait = lambda **kwargs: 0
        processes.append(process)
        return process

    class Socket:
        def __enter__(self):
            return self

        def __exit__(self, *args):
            pass

        def bind(self, address):
            pass

    monkeypatch.setattr(subprocess, "run", run)
    monkeypatch.setattr(subprocess, "Popen", popen)
    monkeypatch.setattr("os.killpg", lambda pid, sig: killed.append((pid, sig)))
    monkeypatch.setattr("socket.socket", Socket)
    monkeypatch.setattr("time.sleep", lambda _: None)
    monkeypatch.setattr(signal, "signal", lambda *args: None)

    def execute(*args):
        monkeypatch.setattr(sys, "argv", ["-", *args])
        source = SCRIPT.read_text().split("<<'PY'\n", 1)[1].rsplit("\nPY", 1)[0]
        exec(compile(source, str(SCRIPT), "exec"), {})  # noqa: S102 - execute trusted repo script with fakes

    return SimpleNamespace(
        execute=execute,
        calls=calls,
        replies=replies,
        failures=failures,
        processes=processes,
        killed=killed,
    )


def remote(harness):
    harness.execute("http://127.0.0.1:9999")


def test_remote_roundtrip_and_no_local_processes(harness, capsys):
    remote(harness)
    assert capsys.readouterr().out == "smoke OK\n"
    assert len(harness.calls) == 4
    assert not harness.processes and not harness.killed
    create = harness.calls[2][0]
    assert json.loads(create[create.index("--data-binary") + 1]) == {
        "personaId": "p_smoke",
        "interviewGuide": GUIDE,
    }
    for command, options in harness.calls:
        assert command[:2] == ["curl", "-q"]
        assert command[command.index("--connect-timeout") + 1] == "3"
        assert command[command.index("--max-time") + 1] == "10"
        assert command[command.index("--retry") + 1] == "0"
        assert command[command.index("--max-redirs") + 1] == "0"
        assert "--location" not in command and options["timeout"] == 12


@pytest.mark.parametrize(
    "path,status",
    [
        ("/", 500),
        ("/api/health", 503),
        ("/api/sessions", 404),
        ("/api/sessions", 503),
        ("/api/sessions/s_test", 404),
        ("/", 302),
        ("/", 401),
    ],
)
def test_route_failures_are_red(harness, path, status, capsys):
    harness.replies[path] = (status, "private credential")
    with pytest.raises(SystemExit, match="1"):
        remote(harness)
    assert "private credential" not in str(capsys.readouterr())
    assert not harness.processes and not harness.killed


@pytest.mark.parametrize("body", [{"status": "bad"}, [], "not JSON"])
def test_unhealthy_or_invalid_health(harness, body):
    harness.replies["/api/health"] = (200, body)
    with pytest.raises(SystemExit):
        remote(harness)
    assert len(harness.calls) == 1


@pytest.mark.parametrize(
    "body",
    [
        {**SESSION, "id": "../../token"},
        {**SESSION, "personaId": "wrong"},
        {**SESSION, "status": "live"},
        {**SESSION, "interviewGuide": []},
    ],
)
def test_create_response_validation(harness, body):
    harness.replies["/api/sessions"] = (201, body)
    with pytest.raises(SystemExit):
        remote(harness)
    assert len(harness.calls) == 3


def test_read_must_match_created_session(harness):
    harness.replies["/api/sessions/s_test"] = (200, {**SESSION, "personaId": "wrong"})
    with pytest.raises(SystemExit):
        remote(harness)


@pytest.mark.parametrize(
    "key,value",
    [
        ("SMOKE_PERSONA_ID", ""),
        ("SMOKE_PERSONA_ID", "bad\nvalue"),
        ("SMOKE_ALLOWED_ORIGIN", ""),
        ("SMOKE_ALLOWED_ORIGIN", "https://other.invalid"),
        ("SMOKE_AUTH_HEADER_NAME", "Cookie"),
        ("SMOKE_AUTH_HEADER_VALUE", "unpaired"),
    ],
)
def test_missing_or_invalid_configuration_fails_before_requests(harness, monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    with pytest.raises(SystemExit):
        remote(harness)
    assert not harness.calls


@pytest.mark.parametrize(
    "target",
    [
        "http://example.invalid",
        "https://user:secret@example.invalid",
        "https://example.invalid/x",
        "https://example.invalid?token=secret",
        "https://example.invalid/#fragment",
        "https://example.invalid\n",
        "--help",
    ],
)
def test_unsafe_origins_rejected(harness, target, monkeypatch):
    monkeypatch.setenv("SMOKE_ALLOWED_ORIGIN", target)
    with pytest.raises(SystemExit):
        harness.execute(target)
    assert not harness.calls


def test_auth_config_stdin_and_sanitized_diagnostics(harness, monkeypatch, capsys):
    monkeypatch.setenv("SMOKE_AUTH_HEADER_NAME", "Cookie")
    monkeypatch.setenv("SMOKE_AUTH_HEADER_VALUE", 'demo=private"credential\\value')
    monkeypatch.setenv("SMOKE_VERCEL_BYPASS_TOKEN", "private-bypass")
    harness.failures.append(28)
    with pytest.raises(SystemExit):
        remote(harness)
    command, options = harness.calls[0]
    assert "private" not in " ".join(command)
    assert 'header = "Cookie: demo=private\\"credential\\\\value"' in options["input"]
    assert "x-vercel-protection-bypass: private-bypass" in options["input"]
    assert "private" not in str(capsys.readouterr())
    assert len(harness.calls) == 1


def test_header_injection_rejected(harness, monkeypatch):
    monkeypatch.setenv("SMOKE_AUTH_HEADER_NAME", "Cookie")
    monkeypatch.setenv("SMOKE_AUTH_HEADER_VALUE", "value\nurl = https://other.invalid")
    with pytest.raises(SystemExit):
        remote(harness)
    assert not harness.calls


@pytest.mark.parametrize("failure", [28, subprocess.TimeoutExpired("curl", 12)])
def test_remote_timeout_is_bounded_without_retries(harness, failure):
    harness.failures.append(failure)
    with pytest.raises(SystemExit):
        remote(harness)
    assert len(harness.calls) == 1 and not harness.killed


def test_local_only_root_health_and_owned_groups(harness):
    harness.execute()
    assert len(harness.processes) == 2
    assert all(p.options["start_new_session"] for p in harness.processes)
    assert [cmd[-1] for cmd, _ in harness.calls] == [
        "http://localhost:3000/api/health",
        "http://localhost:3000/",
    ]
    assert harness.killed == [(p.pid, signal.SIGTERM) for p in harness.processes]


def test_local_retries_are_finite_and_cleanup_preserves_failure(harness):
    harness.failures.extend([28] * 30)
    with pytest.raises(SystemExit, match="1"):
        harness.execute()
    assert len(harness.calls) == 30
    assert harness.killed == [(p.pid, signal.SIGTERM) for p in harness.processes]


def test_local_failure_after_startup_cleans_only_owned_processes(harness):
    harness.replies["/"] = (500, "private server log")
    with pytest.raises(SystemExit):
        harness.execute()
    assert len(harness.killed) == 2


def test_local_busy_ports_fail_without_starting_or_killing(harness, monkeypatch):
    def unavailable(*args):
        raise OSError("address in use")

    monkeypatch.setattr("socket.socket", unavailable)
    with pytest.raises(SystemExit):
        harness.execute()
    assert not harness.calls and not harness.processes and not harness.killed


@pytest.fixture
def deployment(monkeypatch, tmp_path):
    event = {
        "repository": {"full_name": "owner/repo"},
        "deployment": {
            "creator": {"id": 123},
            "environment": "Preview",
            "repository_url": "https://api.github.com/repos/owner/repo",
        },
        "deployment_status": {
            "creator": {"id": 123},
            "environment": "Preview",
            "environment_url": "https://approved-project.invalid",
        },
    }
    event_path, output = tmp_path / "event.json", tmp_path / "env"
    monkeypatch.setenv("GITHUB_EVENT_PATH", str(event_path))
    monkeypatch.setenv("GITHUB_ENV", str(output))
    monkeypatch.setenv("GITHUB_REPOSITORY", "owner/repo")
    monkeypatch.setenv("TRUSTED_CREATOR_ID", "123")
    monkeypatch.setenv(
        "TRUSTED_TARGETS",
        json.dumps(
            {
                "Preview": {
                    "origin": "https://approved-project.invalid",
                    "persona_id": "p_smoke",
                }
            }
        ),
    )

    def validate():
        event_path.write_text(json.dumps(event))
        source = WORKFLOW.read_text().split("python3 - <<'PY'\n", 1)[1].split("          PY", 1)[0]
        source = "\n".join(line[10:] for line in source.splitlines())
        exec(compile(source, str(WORKFLOW), "exec"), {})  # noqa: S102 - execute trusted workflow validator

    return SimpleNamespace(event=event, validate=validate, output=output)


def test_workflow_accepts_exact_approved_identity_and_origin(deployment):
    deployment.validate()
    assert deployment.output.read_text() == (
        "SMOKE_BASE_URL=https://approved-project.invalid\n"
        "SMOKE_ALLOWED_ORIGIN=https://approved-project.invalid\nSMOKE_PERSONA_ID=p_smoke\n"
    )


@pytest.mark.parametrize(
    "section,key,value",
    [
        ("repository", "full_name", "fork/repo"),
        ("deployment", "creator", {"id": 999}),
        ("deployment_status", "creator", {"id": 999}),
        ("deployment", "repository_url", "https://api.github.com/repos/fork/repo"),
        ("deployment", "environment", "unknown"),
        ("deployment_status", "environment", "Production"),
        ("deployment_status", "environment_url", "https://attacker.vercel.app"),
        ("deployment_status", "environment_url", "https://approved-project.invalid/redirect"),
        ("deployment_status", "environment_url", "https://approved-project.invalid\nEVIL=value"),
    ],
)
def test_workflow_rejects_untrusted_event_before_secret_step(deployment, section, key, value):
    deployment.event[section][key] = value
    with pytest.raises(SystemExit):
        deployment.validate()
    assert not deployment.output.exists()


@pytest.mark.parametrize(
    "key,value",
    [
        ("TRUSTED_CREATOR_ID", ""),
        ("TRUSTED_TARGETS", ""),
        ("TRUSTED_TARGETS", "{}"),
    ],
)
def test_workflow_missing_configuration_is_red(deployment, monkeypatch, key, value):
    monkeypatch.setenv(key, value)
    with pytest.raises(SystemExit):
        deployment.validate()
    assert not deployment.output.exists()


def test_real_shell_remote_entrypoint_with_fake_curl(tmp_path):
    """Run the actual shell/Python boundary; the only HTTP command is a local fake."""
    import os

    fake = tmp_path / "curl"
    trace = tmp_path / "requests.jsonl"
    fake.write_text(
        f"#!{sys.executable}\n"
        "import json, os, sys\n"
        "args = sys.argv[1:]\n"
        "config = sys.stdin.read()\n"
        "with open(os.environ['SMOKE_TEST_TRACE'], 'a') as f:\n"
        "    f.write(json.dumps({'args': args, 'config': config}) + '\\n')\n"
        "url = args[-1]\n"
        "if url.endswith('/api/health'):\n"
        "    print('{\"status\":\"ok\"}\\n200', end='')\n"
        "elif url.endswith('/'):\n"
        "    print('<html>synthetic</html>\\n200', end='')\n"
        "else:\n"
        f"    print(json.dumps({SESSION!r}) + ('\\n201' if url.endswith('/api/sessions') "
        "else '\\n200'), end='')\n"
    )
    fake.chmod(0o755)
    env = {key: value for key, value in os.environ.items() if not key.startswith("SMOKE_")}
    env.update(
        PATH=str(tmp_path) + os.pathsep + os.environ["PATH"],
        SMOKE_TEST_TRACE=str(trace),
        SMOKE_ALLOWED_ORIGIN="http://127.0.0.1:9999",
        SMOKE_PERSONA_ID="p_smoke",
        SMOKE_AUTH_HEADER_NAME="Cookie",
        SMOKE_AUTH_HEADER_VALUE="synthetic-secret",
    )
    result = subprocess.run(
        ["bash", str(SCRIPT), "http://127.0.0.1:9999"],
        cwd=tmp_path,
        check=False,
        env=env,
        capture_output=True,
        text=True,
        timeout=10,
    )
    assert result.returncode == 0, result.stderr
    assert result.stdout == "smoke OK\n"
    assert "synthetic-secret" not in result.stdout + result.stderr
    calls = [json.loads(line) for line in trace.read_text().splitlines()]
    assert len(calls) == 4
    assert all('header = "Cookie: synthetic-secret"' in call["config"] for call in calls)
    assert all("synthetic-secret" not in " ".join(call["args"]) for call in calls)


def test_write_timeout_is_not_retried(harness):
    harness.failures.extend([0, 0, subprocess.TimeoutExpired("curl", 12)])
    with pytest.raises(SystemExit):
        remote(harness)
    assert len(harness.calls) == 3
    assert "--request" in harness.calls[-1][0]
    assert not harness.processes and not harness.killed
