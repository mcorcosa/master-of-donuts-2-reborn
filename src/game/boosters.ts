export type BoosterKind = 'joker' | 'sweep';
export type BoosterSource = 'ad' | 'free';

const CLAIM_DELAYS = [45_000, 75_000, 105_000] as const;

export class RunBoosters {
  private readonly inventory: Partial<Record<BoosterKind, BoosterSource>> = {};
  private claims = 0;
  private freeGranted = false;
  private started = false;
  private elapsed = 0;
  private runningSince: number | null = null;
  private pending: BoosterKind | null = null;

  get claiming(): BoosterKind | null { return this.pending; }
  get hasOffersLeft(): boolean { return this.claims < CLAIM_DELAYS.length; }

  start(): void { this.started = true; }

  setActive(active: boolean, now: number): void {
    const running = active && this.started && this.hasOffersLeft && this.pending === null;
    if (running && this.runningSince === null) this.runningSince = now;
    if (!running && this.runningSince !== null) {
      this.elapsed = this.playedTime(now);
      this.runningSince = null;
    }
  }

  source(kind: BoosterKind): BoosterSource | undefined { return this.inventory[kind]; }

  progress(now: number): number {
    if (!this.hasOffersLeft) return 0;
    return Math.min(1, this.playedTime(now) / CLAIM_DELAYS[this.claims]);
  }

  nextRefresh(now: number): number {
    if (this.runningSince === null) return 0;
    const remaining = CLAIM_DELAYS[this.claims] - this.playedTime(now);
    return remaining > 0 ? now + Math.min(remaining, 250) : 0;
  }

  canClaim(kind: BoosterKind, now: number): boolean {
    return !this.source(kind) && this.pending === null && this.progress(now) === 1;
  }

  beginClaim(kind: BoosterKind, now: number): boolean {
    if (!this.canClaim(kind, now)) return false;
    this.pending = kind;
    this.setActive(false, now);
    return true;
  }

  finishClaim(completed: boolean): void {
    const kind = this.pending;
    this.pending = null;
    if (kind === null || !completed) return;
    this.inventory[kind] = 'ad';
    this.claims++;
    this.elapsed = 0;
  }

  grantComboDrop(combo: number, usable: Readonly<Record<BoosterKind, boolean>>, rng = Math.random): BoosterKind | undefined {
    if (combo !== 5 || this.freeGranted) return;
    const jokerAvailable = !this.source('joker') && this.pending !== 'joker';
    const sweepAvailable = !this.source('sweep') && this.pending !== 'sweep';
    if (!jokerAvailable && !sweepAvailable) return;

    let kind: BoosterKind;
    if (jokerAvailable && usable.joker && sweepAvailable && usable.sweep) {
      kind = rng() < 0.5 ? 'joker' : 'sweep';
    } else if (jokerAvailable && (usable.joker || !sweepAvailable)) {
      kind = 'joker';
    } else {
      // Keep the earned credit even when the player has to wait for a legal board.
      kind = 'sweep';
    }
    this.inventory[kind] = 'free';
    this.freeGranted = true;
    return kind;
  }

  spend(kind: BoosterKind): boolean {
    if (!this.source(kind)) return false;
    delete this.inventory[kind];
    return true;
  }

  private playedTime(now: number): number {
    return this.elapsed + (this.runningSince === null ? 0 : Math.max(0, now - this.runningSince));
  }
}
