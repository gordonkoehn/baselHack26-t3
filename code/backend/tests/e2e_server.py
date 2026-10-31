"""Explicit browser-test entrypoint: uvicorn tests.e2e_server:app.

Real routes, validation and Store; only provider results and the Redis transport are fake.
Never imported by app.main. No provider credentials or outbound connections are allowed.
"""

import json
import os
import socket
import time
from pathlib import Path
from types import SimpleNamespace

from app import realtime
from app.extract import DebriefDraft, PersonaDraft, ProbeAnswer
from app.main import app
from app.routers.insights import get_debriefer
from app.routers.personas import get_extractor, get_prober
from app.store import Store, get_store
from tests.fakes import FakeRedis

for key in list(os.environ):
    if key.startswith(("OPENAI_", "SIMLI_", "UPSTASH_", "REDIS_")):
        del os.environ[key]


def deny_connection(*_args, **_kwargs):
    raise RuntimeError("Outbound connections are disabled in the browser test server")


# Covers sync/async HTTP clients, including any accidentally unmocked provider or store.
socket.socket.connect = deny_connection
socket.socket.connect_ex = deny_connection

EXAMPLES = Path(__file__).parents[2] / "shared" / "examples"
persona = json.loads((EXAMPLES / "persona.json").read_text())
report = json.loads((EXAMPLES / "insight-report.json").read_text())
store = Store(FakeRedis())


def extract_persona(_request):
    return PersonaDraft.model_validate(
        {
            **{
                key: value
                for key, value in persona.items()
                if key in PersonaDraft.model_fields or key == "speechStyle"
            },
            "face": "Sophie",
            "gender": "f",
        }
    )


def answer_probe(_instructions, _question):
    # Always the same, so both runs agree. F1 is the first fact, whatever its label ended up as.
    return ProbeAnswer(answer="Ja.", position="yes", fact_ids=["F1"])


def extract_debrief(_session, _persona, _events):
    # Fixed provider output, independent of stored events: real quote validation must reject
    # missing/altered transcript content instead of the fake inventing matching evidence.
    return DebriefDraft.model_validate({"questions": report["questions"]})


class FakeSecrets:
    def create(self, **_kwargs):
        return SimpleNamespace(value="e2e-not-a-credential", expires_at=int(time.time()) + 600)


# Keep the real token route and persona instruction construction too.
realtime._client = lambda: SimpleNamespace(realtime=SimpleNamespace(client_secrets=FakeSecrets()))
app.dependency_overrides[get_store] = lambda: store
app.dependency_overrides[get_extractor] = lambda: extract_persona
app.dependency_overrides[get_prober] = lambda: answer_probe
app.dependency_overrides[get_debriefer] = lambda: extract_debrief
