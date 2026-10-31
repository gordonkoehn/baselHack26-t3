import threading


class FakeRedis:
    """The few Upstash commands the store uses, atomic like Redis (one lock)."""

    def __init__(self):
        self.data: dict = {}
        self.ttl: dict = {}
        self.lock = threading.Lock()

    def set(self, key, value, ex=None):
        with self.lock:
            self.data[key] = value
            self.ttl[key] = ex

    def get(self, key):
        return self.data.get(key)

    def hsetnx(self, key, field, value):
        with self.lock:
            h = self.data.setdefault(key, {})
            if field in h:
                return False
            h[field] = value
            return True

    def hget(self, key, field):
        return self.data.get(key, {}).get(field)

    def hgetall(self, key):
        return dict(self.data.get(key, {}))

    def expire(self, key, seconds):
        self.ttl[key] = seconds
