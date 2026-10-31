import json
import re
import threading

from app.store import (
    APPEND_EVENTS,
    COUNT_HIT,
    INDEX_PERSONA,
    SAVE_COVERAGE,
    TRANSITION_SESSION,
)


class FakeRedis:
    """The few Upstash commands the store uses, atomic like Redis (one lock)."""

    def __init__(self):
        self.data: dict = {}
        self.ttl: dict = {}
        self.lock = threading.Lock()

    def set(self, key, value, ex=None, xx=False, keepttl=False):
        with self.lock:
            if xx and key not in self.data:
                return
            self.data[key] = value
            if not keepttl:
                self.ttl[key] = ex

    def get(self, key):
        return self.data.get(key)

    def delete(self, *keys):
        with self.lock:
            for key in keys:
                self.data.pop(key, None)

    def mget(self, *keys):
        if not keys:
            raise ValueError("wrong number of arguments for 'mget'")  # as real Redis
        return [self.data.get(key) for key in keys]

    def zrange(self, key, start, stop, rev=False, withscores=False):
        assert stop >= 0
        ranked = sorted(self.data.get(key, {}).items(), key=lambda kv: (kv[1], kv[0]), reverse=rev)
        ranked = ranked[start : stop + 1]
        return ranked if withscores else [member for member, _ in ranked]

    def hgetall(self, key):
        return dict(self.data.get(key, {}))

    def eval(self, script, keys, args):
        """Model the supported scripts atomically; only INDEX_PERSONA really runs its commands."""
        if script == INDEX_PERSONA:
            return self._run_commands(script, keys, args)
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
            if script == SAVE_COVERAGE:
                raw = self.data.get(keys[0])
                if raw is None or json.loads(raw)["version"] != int(args[0]):
                    return 0
                self.data[keys[1]] = args[1]
                self.ttl[keys[1]] = int(args[2])
                return 1
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

    def _run_commands(self, script, keys, args):
        """Runs a script of plain redis.call lines, so its real commands and arguments get tested."""

        def value(token):
            if ref := re.fullmatch(r"(KEYS|ARGV)\[(\d+)\]", token):
                return (keys if ref[1] == "KEYS" else args)[int(ref[2]) - 1]
            quoted = re.fullmatch(r"'(.*)'", token)
            assert quoted or token.isdecimal(), f"fake can't read {token}"
            return quoted[1] if quoted else token

        with self.lock:
            for line in filter(None, map(str.strip, script.splitlines())):
                call = re.fullmatch(r"redis\.call\((.+)\)", line)
                assert call, f"fake can't run: {line}"
                name, key, *rest = [value(token) for token in call[1].split(", ")]
                if name == "ZADD":
                    self._zadd(key, *rest)
                elif name == "ZREMRANGEBYRANK":
                    self._zremrangebyrank(key, *rest)
                else:
                    assert name == "EXPIRE", f"fake doesn't know {name}"
                    self.ttl[key] = int(*rest)

    def _zadd(self, key, *flags_score_member):
        *flags, score, member = flags_score_member
        z = self.data.setdefault(key, {})
        if flags == ["NX"]:
            z.setdefault(member, float(score))
        else:
            assert not flags
            z[member] = float(score)

    def _zremrangebyrank(self, key, start, stop):
        z = self.data.get(key, {})
        start, stop = (int(rank) + len(z) if int(rank) < 0 else int(rank) for rank in (start, stop))
        # A negative stop past the start of the set removes nothing.
        for old in sorted(z, key=lambda m: (z[m], m))[max(start, 0) : max(stop + 1, 0)]:
            del z[old]

    def _count_hit(self, keys, args):
        with self.lock:
            self.data[keys[0]] = self.data.get(keys[0], 0) + 1
            if self.data[keys[0]] == 1:
                self.ttl[keys[0]] = int(args[0])
            return [self.data[keys[0]], self.ttl[keys[0]]]
