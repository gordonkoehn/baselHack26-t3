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

/**
 * Pairs the end of each interviewer turn with the persona's first audio and the avatar's first
 * movement. The avatar side only runs while an avatar is live, so a late first "speaking" after
 * joining can't be paired with an older turn or call.
 */
export class ReplyTimer {
  private voiceAt: number | null = null;
  private avatarAt: number | null = null;

  asked(now: number, avatarLive: boolean) {
    this.voiceAt = now;
    this.avatarAt = avatarLive ? now : null;
  }

  /** ms since the turn ended, once per turn; null when no turn is waiting. */
  voice(now: number): number | null {
    const ms = this.voiceAt === null ? null : now - this.voiceAt;
    this.voiceAt = null;
    return ms;
  }

  avatar(now: number): number | null {
    const ms = this.avatarAt === null ? null : now - this.avatarAt;
    this.avatarAt = null;
    return ms;
  }

  avatarGone() {
    this.avatarAt = null;
  }

  /** New call, teardown, or a rejected ask whose reply never comes. */
  reset() {
    this.voiceAt = this.avatarAt = null;
  }
}
