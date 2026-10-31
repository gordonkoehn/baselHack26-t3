import threading

from app.store import APPEND_EVENTS, COUNT_HIT, TRANSITION_SESSION


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
        """Model the supported scripts atomically; this does not execute Lua."""
        if script == COUNT_HIT:
            return self._count_hit(keys, args)
        with self.lock:
            if script == TRANSITION_SESSION:
                raw = self.data.get(keys[0])
                if raw is None:
                    return ["missing", ""]
                if raw != args[0]:
                    return ["retry", raw]
                if raw != args[1]:
                    self.data[keys[0]] = args[1]
                    self.ttl[keys[0]] = int(args[2])
                return ["ok", args[1]]
            assert script == APPEND_EVENTS
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

    def _count_hit(self, keys, args):
        with self.lock:
            self.data[keys[0]] = self.data.get(keys[0], 0) + 1
            if self.data[keys[0]] == 1:
                self.ttl[keys[0]] = int(args[0])
            return [self.data[keys[0]], self.ttl[keys[0]]]
