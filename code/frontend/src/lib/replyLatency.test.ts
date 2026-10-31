import { describe, expect, it } from "vitest";
import { describeLatency, summarizeLatency } from "./replyLatency";

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
