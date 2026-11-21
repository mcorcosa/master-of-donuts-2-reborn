import type { Persistence } from '@playbridge/core';
import { scopedBrowserStorage, type StringStorage } from '@playbridge/web';

export const PERSONAL_SCORES_KEY = 'master-of-donuts-2-reborn.personal-scores.v1';
const SCORE_LIMIT = 5;

export interface RunStats {
  score: number;
  level: number;
  bestCombo: number;
}

export interface CompletedResults {
  run: RunStats;
  rows: { rank: number; score: number; current: boolean }[];
  isPersonalBest: boolean;
}

type ScoreTarget = 'web' | 'facebook';

export function isLegacyFacebookScoreOrigin(
  { hostname, origin }: Pick<Location, 'hostname' | 'origin'>,
  configuredOrigin?: string,
): boolean {
  return origin === configuredOrigin ||
    (origin === `https://${hostname}` && /(^|\.)(facebook\.com|fbcdn\.net|fbsbx\.com)$/.test(hostname));
}

export function browserScoreStorage(
  getStorage: () => StringStorage,
  target: ScoreTarget,
  legacyFacebookOrigin = false,
): StringStorage {
  // Keep the original web key unless the origin's existing scores belong to Facebook.
  if (target === 'web') return scopedBrowserStorage(legacyFacebookOrigin ? 'web.' : '', getStorage);
  const prefix = 'facebook.';
  return scopedBrowserStorage(prefix, () => {
    const storage = getStorage();
    return {
      getItem(key) {
        const scoped = storage.getItem(key);
        // Old scores have no platform marker. Only a known Facebook origin can seed this scope.
        if (scoped === null && legacyFacebookOrigin && key === prefix + PERSONAL_SCORES_KEY) {
          return storage.getItem(PERSONAL_SCORES_KEY);
        }
        return scoped;
      },
      setItem: (key, value) => storage.setItem(key, value),
    };
  });
}

function validRun(value: unknown): value is RunStats {
  if (typeof value !== 'object' || value === null) return false;
  const { score, level, bestCombo } = value as RunStats;
  return Number.isSafeInteger(score) && score >= 0 && Number.isSafeInteger(level) && level >= 1 &&
    Number.isSafeInteger(bestCombo) && bestCombo >= 0;
}

function topScores(runs: RunStats[]): RunStats[] {
  // Stable sorting keeps the earlier completed run ahead when scores tie.
  return runs.sort((first, second) => second.score - first.score).slice(0, SCORE_LIMIT);
}

export class PersonalScores {
  private scores: RunStats[] = [];
  private pending = Promise.resolve();

  constructor(private persistence?: Persistence) {}

  record(run: RunStats): Promise<CompletedResults> {
    const current = { ...run };
    const next = this.pending.then(() => this.recordRun(current));
    this.pending = next.then(() => {}, () => {});
    return next;
  }

  private async recordRun(current: RunStats): Promise<CompletedResults> {
    if (this.persistence) {
      try {
        const data = await this.persistence.get(PERSONAL_SCORES_KEY);
        this.scores = Array.isArray(data) ? topScores(data.filter(validRun)) : [];
      } catch (error) {
        if (error instanceof SyntaxError) this.scores = [];
        else this.persistence = undefined;
      }
    }

    const isPersonalBest = current.score > (this.scores[0]?.score ?? 0);
    this.scores = topScores([...this.scores, current]);

    try {
      await this.persistence?.set(PERSONAL_SCORES_KEY, this.scores);
    } catch {
      this.persistence = undefined;
    }

    const rows = this.scores.map((entry, index) => ({ rank: index + 1, score: entry.score, current: entry === current }));
    return { run: current, rows, isPersonalBest };
  }
}
