from uuid import uuid4

from fastapi import FastAPI

from app.contracts import Item, ItemCreate

app = FastAPI(title="baselhack26 api")

# Fake everything non-core: in-memory store, resets on restart / per serverless instance.
ITEMS: dict[str, Item] = {
    "1": Item(id="1", title="Hello from the backend", done=False),
}


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


@app.get("/api/items")
def list_items() -> list[Item]:
    return list(ITEMS.values())


@app.post("/api/items", status_code=201)
def create_item(body: ItemCreate) -> Item:
    item = Item(id=uuid4().hex[:8], title=body.title)
    ITEMS[item.id] = item
    return item
