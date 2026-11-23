import type { CompletedResults, PersonalScores, RunStats } from '../platform/personalScores';

export const GAME_OVER_LEAD_IN_MS = 250;
export const GAME_OVER_CUE_MS = 500;
export const GAME_OVER_REVEAL_MS = 4500;
export const GAME_OVER_RECORD_LIMIT_MS = 3500;

export class GameOverPresentation {
  private phase: 'settling' | 'lead-in' | 'cue' | 'inspection' | 'complete' = 'settling';
  private visibleElapsed = 0;
  private visibleSince: number | null = null;
  private cueStartedAt = 0;
  private recorded?: CompletedResults;
  private recordLimit: number | undefined;
  private readonly fallback: CompletedResults;

  constructor(run: RunStats, private readonly scores: Pick<PersonalScores, 'record'>, private readonly onRecorded: () => void) {
    // An unavailable score history cannot establish a rank or a personal best.
    this.fallback = { run, rows: [], isPersonalBest: false };
  }

  get ready(): boolean { return this.phase === 'complete' && this.visibleSince !== null; }
  get run(): RunStats { return this.fallback.run; }

  finalize(now: number): boolean {
    if (this.recordLimit !== undefined) return false;
    this.recordLimit = now + GAME_OVER_RECORD_LIMIT_MS;
    void Promise.resolve().then(() => this.scores.record(this.run)).catch(() => this.fallback).then(results => {
      this.recorded = results;
      if (this.phase === 'complete') this.onRecorded();
    });
    return true;
  }

  setVisible(visible: boolean, now: number): void {
    if (visible === (this.visibleSince !== null)) return;
    if (visible) this.visibleSince = now;
    else {
      this.visibleElapsed = this.elapsed(now);
      this.visibleSince = null;
    }
  }

  advance(now: number, boardSettled: boolean): CompletedResults | undefined {
    if (this.visibleSince === null) return;
    if (this.phase === 'settling') {
      if (boardSettled) {
        this.phase = 'lead-in';
        this.visibleElapsed = 0;
        this.visibleSince = now;
      }
      return;
    }

    const elapsed = this.elapsed(now);
    if (this.phase === 'lead-in' && elapsed >= GAME_OVER_LEAD_IN_MS) {
      this.phase = 'cue';
      this.cueStartedAt = elapsed;
    } else if (this.phase === 'cue' && elapsed >= this.cueStartedAt + GAME_OVER_CUE_MS) {
      this.phase = 'inspection';
    }
    if (this.phase === 'inspection' && elapsed >= GAME_OVER_REVEAL_MS) this.phase = 'complete';
    if (this.ready) return this.recorded ?? (this.recordLimit !== undefined && now >= this.recordLimit ? this.fallback : undefined);
  }

  cueProgress(now: number): number | null {
    return this.phase === 'cue' ? Math.min(1, (this.elapsed(now) - this.cueStartedAt) / GAME_OVER_CUE_MS) : null;
  }

  get cueAnimating(): boolean {
    return this.phase === 'cue' && this.visibleSince !== null;
  }

  deadline(reduced: boolean): number {
    if (this.visibleSince === null) return 0;
    const origin = this.visibleSince - this.visibleElapsed;
    if (this.phase === 'lead-in') return origin + GAME_OVER_LEAD_IN_MS;
    if (this.phase === 'cue' && reduced) return origin + this.cueStartedAt + GAME_OVER_CUE_MS;
    if (this.phase === 'inspection') return origin + GAME_OVER_REVEAL_MS;
    if (this.phase === 'complete' && !this.recorded) return this.recordLimit ?? 0;
    return 0;
  }

  private elapsed(now: number): number {
    return this.visibleElapsed + (this.visibleSince === null ? 0 : now - this.visibleSince);
  }
}
