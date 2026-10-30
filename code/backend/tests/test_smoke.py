import json
from pathlib import Path

from fastapi.testclient import TestClient

from app.contracts import Item
from app.main import app

client = TestClient(app)
EXAMPLES = Path(__file__).parents[2] / "shared" / "examples"


def test_health():
    assert client.get("/api/health").json() == {"status": "ok"}


def test_create_and_list():
    r = client.post("/api/items", json={"title": "smoke"})
    assert r.status_code == 201
    assert any(i["title"] == "smoke" for i in client.get("/api/items").json())


def test_examples_match_contracts():
    Item.model_validate(json.loads((EXAMPLES / "item.json").read_text()))
