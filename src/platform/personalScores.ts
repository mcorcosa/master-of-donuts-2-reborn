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

type ScoreStorage = Pick<Storage, 'getItem' | 'setItem'>;

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

function readScores(raw: string | null): RunStats[] {
  if (raw === null) return [];
  try {
    const data: unknown = JSON.parse(raw);
    return Array.isArray(data) ? topScores(data.filter(validRun)) : [];
  } catch {
    return [];
  }
}

export class PersonalScores {
  private storage?: ScoreStorage;
  private scores: RunStats[] = [];

  constructor(getStorage: () => ScoreStorage) {
    try {
      this.storage = getStorage();
    } catch {
      // Some embedded contexts deny access to localStorage itself.
    }
  }

  record(run: RunStats): CompletedResults {
    if (this.storage) {
      try {
        this.scores = readScores(this.storage.getItem(PERSONAL_SCORES_KEY));
      } catch {
        this.storage = undefined;
      }
    }

    const current = { ...run };
    const isPersonalBest = current.score > (this.scores[0]?.score ?? 0);
    this.scores = topScores([...this.scores, current]);

    try {
      this.storage?.setItem(PERSONAL_SCORES_KEY, JSON.stringify(this.scores));
    } catch {
      this.storage = undefined;
    }

    const rows = this.scores.map((entry, index) => ({ rank: index + 1, score: entry.score, current: entry === current }));
    return { run, rows, isPersonalBest };
  }
}
