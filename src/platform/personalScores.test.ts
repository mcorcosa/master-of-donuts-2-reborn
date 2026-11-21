import { describe, expect, it, vi } from 'vitest';
import { PERSONAL_SCORES_KEY, PersonalScores, type RunStats } from './personalScores';

function run(score: number, level = 1, bestCombo = 0): RunStats {
  return { score, level, bestCombo };
}

function mockStorage(initial: string | null = null) {
  let value = initial;
  return { getItem: vi.fn(() => value), setItem: vi.fn((_key: string, stored: string) => { value = stored; }) };
}

describe('personal scores', () => {
  it('keeps the top five with stable ties across reloads and highlights only the just-completed row', () => {
    const storage = mockStorage();
    const scores = new PersonalScores(() => storage);
    expect(storage.setItem).not.toHaveBeenCalled();
    for (const completed of [run(100), run(300), run(400), run(300, 2), run(500), run(50)]) scores.record(completed);

    const reloaded = new PersonalScores(() => storage);
    expect(reloaded.record(run(300, 3, 2))).toEqual({
      run: run(300, 3, 2), isPersonalBest: false, rows: [
        { rank: 1, score: 500, current: false }, { rank: 2, score: 400, current: false },
        { rank: 3, score: 300, current: false }, { rank: 4, score: 300, current: false }, { rank: 5, score: 300, current: true },
      ],
    });
    expect(storage.setItem).toHaveBeenLastCalledWith(PERSONAL_SCORES_KEY,
      JSON.stringify([run(500), run(400), run(300), run(300, 2), run(300, 3, 2)]));
    expect(reloaded.record(run(300, 4)).rows.every(row => !row.current)).toBe(true);
  });

  it('celebrates only a strictly higher positive score', () => {
    const storage = mockStorage();
    const scores = new PersonalScores(() => storage);
    expect(scores.record(run(0)).isPersonalBest).toBe(false);
    expect(scores.record(run(1)).isPersonalBest).toBe(true);
    expect(scores.record(run(1, 2, 3)).isPersonalBest).toBe(false);
    expect(scores.record(run(0, 2, 3)).isPersonalBest).toBe(false);
    expect(new PersonalScores(() => storage).record(run(2)).isPersonalBest).toBe(true);
  });

  it('recovers from broken JSON and filters malformed stored rows', () => {
    const broken = mockStorage('{');
    expect(new PersonalScores(() => broken).record(run(20)).rows).toEqual([{ rank: 1, score: 20, current: true }]);
    expect(broken.setItem).toHaveBeenLastCalledWith(PERSONAL_SCORES_KEY, JSON.stringify([run(20)]));

    const mixed = mockStorage(JSON.stringify([null, run(-1), run(900, 0), run(800, 1, -1), run(10), run(45)]));
    expect(new PersonalScores(() => mixed).record(run(20)).rows.map(row => row.score)).toEqual([45, 20, 10]);
  });

  it('keeps ranking new runs in memory when access, reading or writing is denied', () => {
    const deny = () => { throw new Error('Storage denied'); };
    const writeDenied = { ...mockStorage(JSON.stringify([run(50)])), setItem: vi.fn(deny) };
    for (const scores of [new PersonalScores(deny), new PersonalScores(() => ({ getItem: deny, setItem: deny })),
      new PersonalScores(() => writeDenied)]) {
      expect(scores.record(run(100)).isPersonalBest).toBe(true);
      expect(scores.record(run(90)).rows.slice(0, 2).map(row => row.score)).toEqual([100, 90]);
    }
    expect(writeDenied.setItem).toHaveBeenCalledTimes(1);
    expect(writeDenied.getItem).toHaveBeenCalledTimes(1);
  });
});
