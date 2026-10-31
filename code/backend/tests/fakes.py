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

    def hgetall(self, key):
        return dict(self.data.get(key, {}))

    def eval(self, script, keys, args):
        """Runs the APPEND_EVENTS script's semantics in one locked step, like Redis would."""
        assert "HSETNX" in script and "EXPIRE" in script
        with self.lock:
            h = self.data.setdefault(keys[0], {})
            out = []
            for field, value in zip(args[1::2], args[2::2], strict=True):
                if field in h:
                    out.append(h[field])
                else:
                    h[field] = value
                    out.append("")
            self.ttl[keys[0]] = int(args[0])
            return out
