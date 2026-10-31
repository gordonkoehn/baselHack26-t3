import { describe, expect, it } from "vitest";
import { ReplyTimer, describeLatency, summarizeLatency } from "./replyLatency";

describe("summarizeLatency", () => {
  it("returns null without turns", () => {
    expect(summarizeLatency([])).toBeNull();
    expect(describeLatency("Avatar", null)).toBe("Avatar: no turns");
  });

  it("uses nearest-rank percentiles on unsorted input", () => {
    const s = summarizeLatency([3000, 1000, 800, 1200, 900, 1100, 1300, 1400, 1500, 2600]);
    expect(s).toEqual({ turns: 10, p50: 1200, p90: 2600, underTarget: 0.8 });
  });

  it("handles a single turn and counts the target as exclusive", () => {
    expect(summarizeLatency([2500.4])).toEqual({ turns: 1, p50: 2500, p90: 2500, underTarget: 0 });
  });

  it("formats a readable line", () => {
    expect(describeLatency("Voice", summarizeLatency([1000, 2000]))).toBe(
      "Voice: p50 1000 ms · p90 2000 ms · 100% under 2.5 s (2 turns)",
    );
  });
});

describe("ReplyTimer", () => {
  it("measures each turn once", () => {
    const t = new ReplyTimer();
    t.asked(1000, true);
    expect(t.voice(1800)).toBe(800);
    expect(t.avatar(2100)).toBe(1100);
    expect(t.voice(2500)).toBeNull();
    expect(t.avatar(2600)).toBeNull();
  });

  it("ignores the first movement of an avatar that joined after the turn ended", () => {
    const t = new ReplyTimer();
    t.asked(1000, false);
    expect(t.avatar(9000)).toBeNull();
    t.asked(10_000, true);
    expect(t.avatar(11_200)).toBe(1200);
  });

  it("drops a pending avatar turn when the avatar goes away", () => {
    const t = new ReplyTimer();
    t.asked(1000, true);
    t.avatarGone();
    expect(t.avatar(5000)).toBeNull();
    expect(t.voice(1500)).toBe(500);
  });

  it("does not carry a pending turn into the next call", () => {
    const t = new ReplyTimer();
    t.asked(1000, true);
    t.reset();
    expect(t.voice(60_000)).toBeNull();
    expect(t.avatar(60_000)).toBeNull();
  });
});
