import re
from pathlib import Path

APP_DIR = Path(__file__).parents[1] / "app"
ENV_EXAMPLE = Path(__file__).parents[2] / ".env.example"

# Matches os.environ.get("X"), os.environ["X"] and os.getenv("X").
ENV_READ = re.compile(r'os\.(?:environ(?:\.get\(|\[)|getenv\()"([A-Z0-9_]+)"')


def test_every_env_var_read_by_app_is_documented():
    documented = {
        line.split("=", 1)[0].strip()
        for line in ENV_EXAMPLE.read_text(encoding="utf-8").splitlines()
        if "=" in line and not line.lstrip().startswith("#")
    }

    used = set()
    for path in APP_DIR.rglob("*.py"):
        used.update(ENV_READ.findall(path.read_text(encoding="utf-8")))

    missing = sorted(used - documented)
    assert not missing, f"env vars read by app/ but missing from .env.example: {missing}"
