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

    def mget(self, *keys):
        return [self.data.get(key) for key in keys]

    def zrange(self, key, start, stop, rev=False, withscores=False):
        assert stop >= 0
        ranked = sorted(self.data.get(key, {}).items(), key=lambda kv: (kv[1], kv[0]), reverse=rev)
        ranked = ranked[start : stop + 1]
        return ranked if withscores else [member for member, _ in ranked]

    def hgetall(self, key):
        return dict(self.data.get(key, {}))

    def eval(self, script, keys, args):
        """Runs the store's scripts' semantics in one locked step, like Redis would."""
        assert "EXPIRE" in script
        if "ZADD" in script:
            return self._index_persona(keys[0], *args)
        assert "HSETNX" in script
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

    def _index_persona(self, key, score, member, stop, ttl):
        with self.lock:
            z = self.data.setdefault(key, {})
            z.setdefault(member, float(score))
            oldest_first = sorted(z, key=lambda m: (z[m], m))
            # stop is a negative, inclusive Redis rank; past the start of the set it removes nothing.
            for old in oldest_first[: max(0, len(z) + int(stop) + 1)]:
                del z[old]
            self.ttl[key] = int(ttl)
