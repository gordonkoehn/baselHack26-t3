"""code/.env.example must list exactly the settings the backend reads, so it can't drift."""

import re
from pathlib import Path

BACKEND = Path(__file__).resolve().parents[1]
ENV_EXAMPLE = BACKEND.parent / ".env.example"
ENV_READ = re.compile(r"""os\.(?:environ\.get\(|environ\[|getenv\()\s*["']([A-Z0-9_]+)["']""")
# Read by Redis.from_env() in store.py, not by name in our code.
READ_BY_LIBRARIES = {"UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"}
# Set by the platform, so nobody configures them.
SET_BY_PLATFORM = {"VERCEL"}


def keys_read_by_backend() -> set[str]:
    keys = set(READ_BY_LIBRARIES)
    for path in (BACKEND / "app").rglob("*.py"):
        keys.update(ENV_READ.findall(path.read_text()))
    return keys - SET_BY_PLATFORM


def example_lines() -> list[str]:
    return [
        line for line in ENV_EXAMPLE.read_text().splitlines() if line and not line.startswith("#")
    ]


def example_keys() -> set[str]:
    return {line.split("=", 1)[0].strip() for line in example_lines()}


def test_every_key_the_backend_reads_is_in_the_example() -> None:
    assert keys_read_by_backend() - example_keys() == set()


def test_the_example_has_no_unused_keys() -> None:
    assert example_keys() - keys_read_by_backend() == set()


def test_every_key_says_whether_it_is_required() -> None:
    for line in example_lines():
        assert re.search(r"#\s*(required|optional)", line), f"no required/optional note: {line}"


def test_the_example_holds_no_values() -> None:
    for line in example_lines():
        value = line.split("=", 1)[1].split("#", 1)[0].strip()
        assert value == "", f"example must not contain a value: {line}"
