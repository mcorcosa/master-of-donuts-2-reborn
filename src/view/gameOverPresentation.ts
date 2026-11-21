import type { CompletedResults, PersonalScores, RunStats } from '../platform/personalScores';

export const GAME_OVER_HOLD_MS = 2000;
export const GAME_OVER_CUE_MS = 500;
export const GAME_OVER_RECORD_LIMIT_MS = 3500;

export class GameOverPresentation {
  private phase: 'settling' | 'hold' | 'cue' | 'complete' = 'settling';
  private phaseElapsed = 0;
  private visibleSince: number | null = null;
  private recorded?: CompletedResults;
  private readonly recordLimit: number;
  private readonly fallback: CompletedResults;

  constructor(run: RunStats, now: number, scores: Pick<PersonalScores, 'record'>, onRecorded: () => void) {
    this.recordLimit = now + GAME_OVER_RECORD_LIMIT_MS;
    // An unavailable score history cannot establish a rank or a personal best.
    this.fallback = { run, rows: [], isPersonalBest: false };
    void Promise.resolve().then(() => scores.record(run)).catch(() => this.fallback).then(results => {
      this.recorded = results;
      if (this.phase === 'complete') onRecorded();
    });
  }

  setVisible(visible: boolean, now: number): void {
    if (visible === (this.visibleSince !== null)) return;
    if (visible) this.visibleSince = now;
    else {
      this.phaseElapsed = this.elapsed(now);
      this.visibleSince = null;
    }
  }

  advance(now: number, boardSettled: boolean): CompletedResults | undefined {
    if (this.visibleSince === null) return;
    const elapsed = this.elapsed(now);
    if (this.phase === 'settling' && boardSettled) this.start('hold', now);
    else if (this.phase === 'hold' && elapsed >= GAME_OVER_HOLD_MS) this.start('cue', now);
    else if (this.phase === 'cue' && elapsed >= GAME_OVER_CUE_MS) this.start('complete', now);
    if (this.phase === 'complete') return this.recorded ?? (now >= this.recordLimit ? this.fallback : undefined);
  }

  cueProgress(now: number): number | null {
    return this.phase === 'cue' ? Math.min(1, this.elapsed(now) / GAME_OVER_CUE_MS) : null;
  }

  get cueAnimating(): boolean {
    return this.phase === 'cue' && this.visibleSince !== null;
  }

  deadline(reduced: boolean): number {
    if (this.visibleSince === null) return 0;
    if (this.phase === 'hold') return this.visibleSince + GAME_OVER_HOLD_MS - this.phaseElapsed;
    if (this.phase === 'cue' && reduced) return this.visibleSince + GAME_OVER_CUE_MS - this.phaseElapsed;
    if (this.phase === 'complete' && !this.recorded) return this.recordLimit;
    return 0;
  }

  private elapsed(now: number): number {
    return this.phaseElapsed + (this.visibleSince === null ? 0 : now - this.visibleSince);
  }

  private start(phase: typeof this.phase, now: number): void {
    this.phase = phase;
    this.phaseElapsed = 0;
    this.visibleSince = now;
  }
}
