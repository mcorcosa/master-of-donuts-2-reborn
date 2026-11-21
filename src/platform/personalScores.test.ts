import { createBrowserPersistence, scopedBrowserStorage } from '@playbridge/web';
import { describe, expect, it, vi } from 'vitest';
import { browserScoreStorage, isLegacyFacebookScoreOrigin, PERSONAL_SCORES_KEY, PersonalScores, type RunStats } from './personalScores';

function run(score: number, level = 1, bestCombo = 0): RunStats {
  return { score, level, bestCombo };
}

function mockStorage(initial: string | null = null) {
  const entries = new Map<string, string>();
  if (initial !== null) entries.set(PERSONAL_SCORES_KEY, initial);
  return {
    entries,
    getItem: vi.fn((key: string) => entries.get(key) ?? null),
    setItem: vi.fn((key: string, stored: string) => { entries.set(key, stored); }),
  };
}

describe('personal scores', () => {
  it('keeps the top five with stable ties across reloads and highlights only the just-completed row', async () => {
    const storage = mockStorage();
    const persistence = createBrowserPersistence(storage);
    const scores = new PersonalScores(persistence);
    expect(storage.setItem).not.toHaveBeenCalled();
    for (const completed of [run(100), run(300), run(400), run(300, 2), run(500), run(50)]) await scores.record(completed);

    const reloaded = new PersonalScores(persistence);
    expect(await reloaded.record(run(300, 3, 2))).toEqual({
      run: run(300, 3, 2), isPersonalBest: false, rows: [
        { rank: 1, score: 500, current: false }, { rank: 2, score: 400, current: false },
        { rank: 3, score: 300, current: false }, { rank: 4, score: 300, current: false }, { rank: 5, score: 300, current: true },
      ],
    });
    expect(storage.setItem).toHaveBeenLastCalledWith(PERSONAL_SCORES_KEY,
      JSON.stringify([run(500), run(400), run(300), run(300, 2), run(300, 3, 2)]));
    expect((await reloaded.record(run(300, 4))).rows.every(row => !row.current)).toBe(true);
  });

  it('celebrates only a strictly higher positive score', async () => {
    const persistence = createBrowserPersistence(mockStorage());
    const scores = new PersonalScores(persistence);
    expect((await scores.record(run(0))).isPersonalBest).toBe(false);
    expect((await scores.record(run(1))).isPersonalBest).toBe(true);
    expect((await scores.record(run(1, 2, 3))).isPersonalBest).toBe(false);
    expect((await scores.record(run(0, 2, 3))).isPersonalBest).toBe(false);
    expect((await new PersonalScores(persistence).record(run(2))).isPersonalBest).toBe(true);
  });

  it('recovers from broken JSON and filters malformed stored rows', async () => {
    const broken = mockStorage('{');
    expect((await new PersonalScores(createBrowserPersistence(broken)).record(run(20))).rows)
      .toEqual([{ rank: 1, score: 20, current: true }]);
    expect(broken.setItem).toHaveBeenLastCalledWith(PERSONAL_SCORES_KEY, JSON.stringify([run(20)]));

    const mixed = mockStorage(JSON.stringify([null, run(-1), run(900, 0), run(800, 1, -1), run(10), run(45)]));
    expect((await new PersonalScores(createBrowserPersistence(mixed)).record(run(20))).rows.map(row => row.score))
      .toEqual([45, 20, 10]);
  });

  it('keeps ranking new runs in memory when access, reading or writing is denied', async () => {
    const deny = () => { throw new Error('Storage denied'); };
    const writeDenied = { ...mockStorage(JSON.stringify([run(50)])), setItem: vi.fn(deny) };
    for (const storage of [scopedBrowserStorage('', deny), scopedBrowserStorage('', () => ({ getItem: deny, setItem: deny })),
      scopedBrowserStorage('', () => writeDenied)]) {
      const scores = new PersonalScores(createBrowserPersistence(storage));
      expect((await scores.record(run(100))).isPersonalBest).toBe(true);
      expect((await scores.record(run(90))).rows.slice(0, 2).map(row => row.score)).toEqual([100, 90]);
    }
    expect(writeDenied.setItem).toHaveBeenCalledTimes(1);
    expect(writeDenied.getItem).toHaveBeenCalledTimes(1);
  });

  it('serializes overlapping completed runs so no write loses a run', async () => {
    const storage = mockStorage();
    const scores = new PersonalScores(createBrowserPersistence(storage));
    await Promise.all([scores.record(run(10)), scores.record(run(20)), scores.record(run(30))]);
    expect(storage.entries.get(PERSONAL_SCORES_KEY)).toBe(JSON.stringify([run(30), run(20), run(10)]));
  });

  it.each(['https://mcorcosa.github.io', 'http://localhost:5173', 'https://example.com'])(
    'keeps the old web key on %s and isolates Facebook on the same origin', async origin => {
      const legacyFacebook = isLegacyFacebookScoreOrigin(new URL(origin));
      const storage = mockStorage(JSON.stringify([run(80)]));
      const web = new PersonalScores(createBrowserPersistence(browserScoreStorage(() => storage, 'web', legacyFacebook)));
      const facebook = new PersonalScores(createBrowserPersistence(browserScoreStorage(() => storage, 'facebook', legacyFacebook)));

      expect((await facebook.record(run(60))).rows.map(row => row.score)).toEqual([60]);
      expect((await web.record(run(40))).rows.map(row => row.score)).toEqual([80, 40]);
      expect(storage.entries.get(PERSONAL_SCORES_KEY)).toBe(JSON.stringify([run(80), run(40)]));
      expect(storage.entries.get(`facebook.${PERSONAL_SCORES_KEY}`)).toBe(JSON.stringify([run(60)]));
    },
  );

  it.each([
    { origin: 'https://game.fbsbx.com', configured: undefined },
    { origin: 'https://shared.example.com', configured: 'https://shared.example.com' },
  ])('migrates legacy Facebook rows on $origin without importing them to the web scope', async ({ origin, configured }) => {
    const storage = mockStorage(JSON.stringify([run(80, 2, 3)]));
    const legacyFacebook = isLegacyFacebookScoreOrigin(new URL(origin), configured);
    const web = new PersonalScores(createBrowserPersistence(browserScoreStorage(() => storage, 'web', legacyFacebook)));
    const facebook = () => new PersonalScores(
      createBrowserPersistence(browserScoreStorage(() => storage, 'facebook', legacyFacebook)),
    );

    expect((await web.record(run(40))).rows.map(row => row.score)).toEqual([40]);
    expect((await facebook().record(run(60))).rows.map(row => row.score)).toEqual([80, 60]);
    expect((await facebook().record(run(50))).rows.map(row => row.score)).toEqual([80, 60, 50]);
    expect(storage.entries.get(PERSONAL_SCORES_KEY)).toBe(JSON.stringify([run(80, 2, 3)]));
    expect(storage.entries.get(`web.${PERSONAL_SCORES_KEY}`)).toBe(JSON.stringify([run(40)]));
    expect(storage.entries.get(`facebook.${PERSONAL_SCORES_KEY}`))
      .toBe(JSON.stringify([run(80, 2, 3), run(60), run(50)]));
  });
});
