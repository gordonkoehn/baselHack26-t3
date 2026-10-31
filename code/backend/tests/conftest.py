import pytest

from app.main import app
from app.store import Store, get_store
from tests.fakes import FakeRedis


@pytest.fixture(autouse=True)
def fresh_store():
    """Paid routes count hits in the store: tests never reach Upstash and start uncounted."""
    store = Store(FakeRedis())
    app.dependency_overrides[get_store] = lambda: store
    yield
    app.dependency_overrides.pop(get_store, None)
