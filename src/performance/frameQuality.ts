export type QualityTier = 2 | 1.5 | 1;

const TIERS: readonly QualityTier[] = [2, 1.5, 1];
export interface FrameQualityPolicy {
  slowIntervalMs: number;
  slowFraction: number;
  windowMs: number;
  discontinuityMs: number;
  staleAfterMs: number;
  windowTimeoutMs: number;
}

const DEFAULT_POLICY: FrameQualityPolicy = {
  slowIntervalMs: 25,
  slowFraction: 0.10,
  windowMs: 4000,
  discontinuityMs: 250,
  staleAfterMs: 1500,
  windowTimeoutMs: 12000,
};

export function normalizeNativeDpr(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 1;
}

export class FrameQuality {
  private lastTime: number | undefined;
  private pausedAt: number | undefined;
  private windowStarted: number | undefined;
  private elapsed = 0;
  private intervals = 0;
  private slow = 0;
  private slowWindows = 0;
  private nativeDpr: number;
  private tier: QualityTier;
  private pending: QualityTier | undefined;
  private readonly policy: FrameQualityPolicy;

  constructor(nativeDpr: number, initialTier: QualityTier = 2, policy: Partial<FrameQualityPolicy> = {}) {
    this.nativeDpr = normalizeNativeDpr(nativeDpr);
    this.tier = initialTier;
    this.policy = { ...DEFAULT_POLICY, ...policy };
  }

  get resolution(): number {
    return Math.min(this.tier, this.nativeDpr);
  }

  setNativeDpr(value: number): void {
    const nativeDpr = normalizeNativeDpr(value);
    if (nativeDpr === this.nativeDpr) return;
    this.nativeDpr = nativeDpr;
    this.pending = undefined;
    this.interrupt();
  }

  // Interruptions discard timing evidence. A decision already made waits for a safe apply point.
  interrupt(): void {
    this.lastTime = this.pausedAt = undefined;
    this.slowWindows = 0;
    this.resetWindow();
  }

  pause(): void {
    this.pausedAt = this.lastTime ?? this.pausedAt;
    this.lastTime = undefined;
  }

  sample(time: number): void {
    if (this.pending !== undefined || this.resolution <= 1) return;
    if (!Number.isFinite(time)) {
      this.interrupt();
      return;
    }
    if (this.pausedAt !== undefined && time - this.pausedAt >= this.policy.staleAfterMs) this.interrupt();
    this.pausedAt = undefined;
    const previous = this.lastTime;
    this.lastTime = time;
    if (previous === undefined) return;
    const interval = time - previous;
    if (interval <= 0 || interval >= this.policy.discontinuityMs) {
      this.interrupt();
      this.lastTime = time;
      return;
    }
    this.windowStarted ??= previous;
    if (time - this.windowStarted >= this.policy.windowTimeoutMs) {
      this.interrupt();
      this.lastTime = time;
      return;
    }

    this.elapsed += interval;
    this.intervals++;
    if (interval >= this.policy.slowIntervalMs) this.slow++;
    if (this.elapsed < this.policy.windowMs) return;

    this.slowWindows = this.slow / this.intervals > this.policy.slowFraction ? this.slowWindows + 1 : 0;
    this.resetWindow();
    if (this.slowWindows === 2) {
      this.pending = TIERS.find(tier => Math.min(tier, this.nativeDpr) < this.resolution);
    }
  }

  applyPending(): QualityTier | undefined {
    const next = this.pending;
    if (next === undefined) return;
    this.pending = undefined;
    this.tier = next;
    this.interrupt();
    return next;
  }

  private resetWindow(): void {
    this.windowStarted = undefined;
    this.elapsed = this.intervals = this.slow = 0;
  }
}
