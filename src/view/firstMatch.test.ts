import { createBrowserPersistence } from '@playbridge/web';
import { describe, expect, it } from 'vitest';
import { createGame, move } from '../game';
import { browserScoreStorage, PERSONAL_SCORES_KEY } from '../platform/personalScores';
import { arrangeFirstMatch, findFirstMatch, loadFirstMatch } from './firstMatch';

function localPersistence(target: 'web' | 'facebook' = 'web', legacy = false) {
  const values = new Map<string, string>();
  return {
    values,
    persistence: createBrowserPersistence(browserScoreStorage(() => ({
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    }), target, legacy)),
  };
}

describe('guided first match', () => {
  it.each([0, 0.25, 0.999])('keeps the inventory and ordinary rules with random draw %s', draw => {
    const rng = () => draw;
    const opening = createGame(rng);
    const guided = arrangeFirstMatch(opening);
    expect({ ...guided, stacks: opening.stacks }).toEqual(opening);
    expect(guided.stacks.flat().sort()).toEqual(opening.stacks.flat().sort());
    expect(guided.stacks.map(stack => stack.length)).toEqual([3, 3, 3]);
    expect(guided.stacks.every(stack => new Set(stack).size > 1)).toBe(true);
    expect(findFirstMatch(guided)).toEqual({ from: 0, to: 1 });
    expect(move(guided, 0, 1, rng)).toMatchObject({ score: 100, combo: 1, movesLeft: guided.movesLeft });
  });

  it('only points to a currently legal scoring transfer', () => {
    const state = arrangeFirstMatch(createGame(() => 0.25));
    expect(findFirstMatch({ ...state, gameOver: true })).toBeNull();
    expect(findFirstMatch({ ...state, capacity: 3 })).toBeNull();
    expect(findFirstMatch(move(state, 1, 2))).toBeNull();
    expect(findFirstMatch(move(state, 0, 2))).toEqual({ from: 2, to: 1 });
  });

  it('allows interrupted attempts and remembers actual completion across loads', async () => {
    const { persistence, values } = localPersistence();
    expect(await loadFirstMatch(persistence)).not.toBeNull();
    expect(values.size).toBe(0);
    const reloaded = await loadFirstMatch(persistence);
    await reloaded!.complete();
    expect(await loadFirstMatch(persistence)).toBeNull();
  });

  it('treats existing platform score history as a returning profile, including zero scores', async () => {
    const { persistence, values } = localPersistence('facebook', true);
    values.set(PERSONAL_SCORES_KEY, '[{"score":0,"level":1,"bestCombo":0}]');
    expect(await loadFirstMatch(persistence)).toBeNull();
    expect(values.size).toBe(1);
  });

  it('keeps the first match playable when local reads and writes fail', async () => {
    const unavailable = () => { throw new Error('Storage unavailable'); };
    const progress = await loadFirstMatch({ get: unavailable, set: unavailable, async flush() {} });
    await expect(progress!.complete()).resolves.toBeUndefined();
  });
});
