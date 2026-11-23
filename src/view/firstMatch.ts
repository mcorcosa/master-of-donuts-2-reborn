import type { Persistence } from '@playbridge/core';
import { canMove, type GameState, resolveMatch } from '../game';
import { PERSONAL_SCORES_KEY } from '../platform/personalScores';

const FIRST_MATCH_KEY = 'master-of-donuts-2-reborn.first-match.v1';

export interface FirstMatchProgress {
  complete(): Promise<void>;
}

export async function loadFirstMatch(persistence: Persistence): Promise<FirstMatchProgress | null> {
  async function read(key: string): Promise<unknown> {
    try { return await persistence.get(key); }
    catch { return undefined; }
  }

  if (await read(FIRST_MATCH_KEY) === true) return null;
  const scores = await read(PERSONAL_SCORES_KEY);
  if (Array.isArray(scores) && scores.length > 0) return null;

  return {
    async complete() {
      try { await persistence.set(FIRST_MATCH_KEY, true); }
      catch { /* The active run can continue without local storage. */ }
    },
  };
}

export function arrangeFirstMatch(opening: GameState): GameState {
  const [first, second, third] = new Set(opening.stacks.flat());
  // Keep the run's palette and three copies of each color. The left top donut
  // completes the center pair without starting with a monochrome stack.
  return { ...opening, stacks: [[second, third, first], [third, first, first], [second, second, third]] };
}

export function findFirstMatch(state: GameState): { from: number; to: number } | null {
  for (const [from, stack] of state.stacks.entries()) {
    const color = stack.at(-1);
    if (color === undefined) continue;
    for (const [to, destination] of state.stacks.entries()) {
      if (canMove(state, from, to) && resolveMatch(destination, color)) return { from, to };
    }
  }
  return null;
}
