// Reply delay per turn (#159): end of the interviewer's turn to the persona's first sound or avatar
// movement. Target: 90% of turns under 2.5 s.
export const TARGET_MS = 2500;

export type LatencySummary = { turns: number; p50: number; p90: number; underTarget: number };

/** Nearest-rank percentiles in whole ms; null when there is nothing to summarize. */
export function summarizeLatency(ms: number[]): LatencySummary | null {
  if (ms.length === 0) return null;
  const sorted = [...ms].sort((a, b) => a - b);
  const at = (p: number) => Math.round(sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)]);
  return {
    turns: sorted.length,
    p50: at(50),
    p90: at(90),
    underTarget: sorted.filter((x) => x < TARGET_MS).length / sorted.length,
  };
}

export function describeLatency(label: string, s: LatencySummary | null): string {
  if (!s) return `${label}: no turns`;
  return `${label}: p50 ${s.p50} ms · p90 ${s.p90} ms · ${Math.round(s.underTarget * 100)}% under ${TARGET_MS / 1000} s (${s.turns} turns)`;
}
