import { describe, expect, it, vi } from 'vitest';
import { canMove, canRequestSetupHint, createGame, type DoughInsert, findSetupHint, type GameState, JOKER, matchedRunLength, move, resolveMatch } from './index';

const lowest = () => 0;
const highest = () => 0.999;

function board(stacks: string[][], overrides: Partial<GameState> = {}): GameState {
  return {
    stacks,
    score: 0,
    level: 1,
    rank: 'Dough Enthusiast',
    capacity: 5,
    nextLevelScore: 500,
    movesLeft: 7,
    gameOver: false,
    ...overrides,
  };
}

function bruteCanScore(
  stacks: string[][], capacity: number, movesLeft: number,
  afterMisses?: (stacks: string[][]) => boolean, seen = new Set<string>(),
): boolean {
  const key = JSON.stringify([movesLeft, stacks]);
  if (seen.has(key)) return false;
  seen.add(key);
  if (movesLeft === 0) return afterMisses?.(stacks) ?? false;
  for (let from = 0; from < stacks.length; from++) {
    for (let to = 0; to < stacks.length; to++) {
      if (from === to || stacks[from].length === 0 || stacks[to].length >= capacity) continue;
      const after = stacks.map((stack) => stack.slice());
      const top = after[from].pop()!;
      after[to].push(top);
      const topThree = after[to].slice(-3);
      const ordinary = topThree.filter((donut) => donut !== JOKER);
      if (topThree.length === 3 && ordinary.length >= 2 && ordinary.every((donut) => donut === ordinary[0])) return true;
      if (bruteCanScore(after, capacity, movesLeft - 1, afterMisses, seen)) return true;
    }
  }
  return false;
}

describe('Setup hints', () => {
  it('finds the shortest four-transfer route on the reported level 11 board', () => {
    const game = board([
      ['purple', 'yellow', 'purple', 'purple', 'blue', 'purple', 'gray', 'green'],
      ['yellow', 'green', 'gray', 'yellow', 'blue', 'purple', 'gray', 'gray'],
      ['gold', 'purple', 'blue', 'choco', 'gray', 'blue', 'green', 'green'],
      ['green', 'green', 'gray', 'blue', 'blue', 'choco', 'gray'],
      ['yellow', 'purple', 'yellow', 'choco', 'yellow', 'gold', 'gold'],
      ['purple', 'green', 'gold', 'purple', 'choco', 'gold', 'blue', 'blue'],
    ], { capacity: 8, level: 11, score: 17500, nextLevelScore: 19400, movesLeft: 6 });
    game.stacks.forEach((stack) => Object.freeze(stack));
    Object.freeze(game.stacks);
    Object.freeze(game);
    expect(bruteCanScore(game.stacks, game.capacity, 3)).toBe(false);
    expect(findSetupHint({ ...game, movesLeft: 3 })).toBeNull();
    expect(findSetupHint({ ...game, movesLeft: 4 })).toEqual({ from: 2, to: 3 });

    const rng = vi.fn(lowest);
    const onDough = vi.fn();
    let next = game;
    for (const [from, to] of [[2, 3], [2, 4], [5, 2]]) {
      expect(canRequestSetupHint(next)).toBe(true);
      expect(findSetupHint(next)).toEqual({ from, to });
      expect(findSetupHint(next)).toEqual({ from, to });
      expect(canMove(next, from, to)).toBe(true);
      next = move(next, from, to, rng, onDough);
      expect(next.score).toBe(17500);
    }
    expect(next.movesLeft).toBe(3);
    expect(canRequestSetupHint(next)).toBe(false);
    expect(findSetupHint(next)).toBeNull();
    expect(rng).not.toHaveBeenCalled();
    expect(onDough).not.toHaveBeenCalled();
    expect(move(next, 5, 2, lowest)).toMatchObject({ score: 17700, combo: 1, movesLeft: 3 });
  });

  it('handles an existing Joker in a one-vacancy setup', () => {
    const game = board([
      ['red', 'yellow', 'red'], [JOKER, 'blue', 'blue', 'gold'], ['yellow', 'red', 'gold', 'blue'],
    ], { capacity: 4, movesLeft: 2 });
    expect(canRequestSetupHint(game)).toBe(true);
    expect(findSetupHint(game)).toEqual({ from: 1, to: 0 });
    const ready = move(game, 1, 0, lowest);
    expect(move(ready, 2, 1, lowest).score).toBe(150);
  });

  it('does not use a refill-only rescue as a hint', () => {
    const game = board([
      ['blue', 'gold', 'gold', 'gold', 'blue'], ['red', 'yellow', 'yellow'], ['yellow', 'blue', 'gold', 'gold', 'blue'],
    ], { level: 2, score: 500, nextLevelScore: 1500, movesLeft: 2 });
    expect(canRequestSetupHint(game)).toBe(true);
    expect(bruteCanScore(game.stacks, game.capacity, game.movesLeft)).toBe(false);
    expect(findSetupHint(game)).toBeNull();

    const miss = move(game, 0, 1, lowest);
    expect(miss).toMatchObject({ gameOver: false, movesLeft: 1, score: 500 });
    const refilled = move(miss, 0, 1, lowest);
    expect(refilled).toMatchObject({ gameOver: false, movesLeft: 6, score: 500 });
    expect(move(refilled, 1, 0, lowest).score).toBe(610);
  });

  it('limits requests to nonterminal boards with one to three vacancies and enough pressure budget', () => {
    const game = board([
      ['blue', 'gold', 'gold', 'blue'], ['red', 'yellow', 'yellow'], ['yellow', 'blue', 'gold', 'gold', 'blue'],
    ]);
    expect(canRequestSetupHint(game)).toBe(true);
    for (const state of [
      { ...game, gameOver: true }, { ...game, movesLeft: 1 },
      { ...game, stacks: [game.stacks[0].slice(1), ...game.stacks.slice(1)] },
      { ...game, stacks: game.stacks.map((stack) => ['gold', 'yellow', ...stack].slice(-5)) },
    ]) {
      expect(canRequestSetupHint(state)).toBe(false);
      expect(findSetupHint(state)).toBeNull();
    }
  });

  it('returns null for a dense search that exceeds its position budget', () => {
    const core = ['blue', 'green', 'blue', 'green', 'blue', 'green', 'blue', 'green'];
    const stacks = ['gold', 'red', 'yellow', 'choco', 'gray', 'purple', 'blue'].map((color) => [...core, color, color]);
    stacks.push(core.slice());
    const game = board(stacks, { capacity: 10, level: 16, movesLeft: 8 });
    expect(canRequestSetupHint(game)).toBe(true);
    expect(findSetupHint(game)).toBeNull();
    expect(game.gameOver).toBe(false);
  });
});

describe('Joker', () => {
  it('leaves a scoring move when a Joker triple would refill to two donuts of each flavor', () => {
    const before = board([[JOKER, 'blue'], ['red'], ['gold', 'gold', 'blue']], { movesLeft: 1 });
    const rng = vi.fn(lowest);
    const onDough = vi.fn<(inserts: readonly DoughInsert[]) => void>();
    const after = move(before, 2, 0, rng, onDough);
    expect(after).toMatchObject({ score: 100, combo: 1, movesLeft: 1, gameOver: false });
    expect(after.stacks.flat()).toHaveLength(6);
    expect(bruteCanScore(after.stacks, after.capacity, after.movesLeft), JSON.stringify(after.stacks)).toBe(true);
    expect(onDough.mock.lastCall?.[0]).toHaveLength(3);
    expect(rng).toHaveBeenCalledTimes(1);
  });

  it('leaves a scoring move using only two inserts on a nearly full board after a Joker triple', () => {
    const before = board([
      ['gold', 'red', JOKER, 'blue'],
      ['red', 'gold', 'red', 'gold', 'blue'],
      ['gold', 'red', 'gold', 'red', 'red'],
    ], { movesLeft: 1 });
    const onDough = vi.fn();
    const after = move(before, 1, 0, lowest, onDough);
    expect(onDough).toHaveBeenCalledExactlyOnceWith([
      { stack: 0, depth: 2, color: 'gold' }, { stack: 0, depth: 3, color: 'gold' },
    ]);
    expect(after).toMatchObject({ score: 100, movesLeft: 1, gameOver: false });
    expect(move(after, 1, 0, lowest).score).toBe(210);
  });

  it('keeps the standard bottom inserts when the Joker triple already leaves a scoring move', () => {
    const before = board([['blue'], [JOKER, 'blue'], ['red', 'red'], ['red']], { movesLeft: 1 });
    const onDough = vi.fn();
    const after = move(before, 0, 1, lowest, onDough);
    expect(onDough).toHaveBeenCalledExactlyOnceWith([
      { stack: 0, depth: 0, color: 'blue' }, { stack: 1, depth: 0, color: 'blue' }, { stack: 0, depth: 0, color: 'red' },
    ]);
    expect(move(after, 3, 2, lowest).score).toBe(210);
  });

  it('spends a miss on the first Blue and stays free to score Blue or another flavor', () => {
    const opening = board([[JOKER], ['red', 'blue'], ['red', 'blue']]);
    const covered = move(opening, 1, 0, lowest);
    expect(covered).toMatchObject({ stacks: [[JOKER, 'blue'], ['red'], ['red', 'blue']], score: 0, combo: 0, movesLeft: 6 });
    const onDough = vi.fn();
    expect(move(covered, 2, 0, lowest, onDough)).toMatchObject({ score: 100, combo: 1, movesLeft: 6 });
    expect(onDough.mock.lastCall?.[0].slice(0, 2).map((dough: DoughInsert) => dough.color)).toEqual(['blue', 'blue']);

    const uncovered = move(covered, 0, 2, lowest);
    const withRed = move(uncovered, 1, 0, lowest);
    const ready = move(move(withRed, 2, 1, lowest), 2, 1, lowest);
    expect(ready.stacks).toEqual([[JOKER, 'red'], ['blue', 'blue'], ['red']]);
    expect(move(ready, 2, 0, lowest, onDough)).toMatchObject({ score: 100, movesLeft: 2 });
    expect(onDough.mock.lastCall?.[0].slice(0, 2).map((dough: DoughInsert) => dough.color)).toEqual(['red', 'red']);
    expect(opening.stacks[0]).toEqual([JOKER]);
  });

  it('uses the first natural from the top and stops at a competing donut or second Joker', () => {
    expect(resolveMatch(['blue', JOKER], 'blue')).toEqual({ color: 'blue', runLength: 3, jokerIndex: 1 });
    expect(resolveMatch(['red', 'red', 'blue'], JOKER)).toBeNull();
    expect(resolveMatch(['blue', JOKER], JOKER)).toBeNull();
    expect(resolveMatch([JOKER, 'blue', 'blue', 'red', 'red'], JOKER))
      .toEqual({ color: 'red', runLength: 3, jokerIndex: 2 });
    expect(resolveMatch([JOKER, 'blue', 'blue', JOKER, 'blue'], 'blue'))
      .toEqual({ color: 'blue', runLength: 5, jokerIndex: 2 });
  });

  it('clears the whole qualifying run at capacity and preserves the donuts below it', () => {
    const initial = board([['blue'], ['red', 'blue', JOKER, 'blue'], ['gold', 'red']], { combo: 1 });
    expect(move(initial, 0, 1, lowest)).toMatchObject({
      stacks: expect.arrayContaining([expect.arrayContaining(['red'])]), score: 165, combo: 2, movesLeft: 7,
    });
    const next = move(initial, 0, 1, lowest);
    expect(next.stacks[1].at(-1)).toBe('red');
    expect(next.stacks.flat()).not.toContain(JOKER);
    const full = board([['blue'], ['red', 'blue', JOKER, 'blue', 'blue']]);
    expect(move(full, 0, 1, lowest)).toBe(full);
  });

  it('rescues the last vacancy by exposing a resident Joker or moving in a Joker', () => {
    const resident = board([
      ['red', 'yellow', 'red', 'gold'], [JOKER, 'blue', 'blue'], ['yellow', 'red', 'gold', 'blue'],
    ], { capacity: 4, movesLeft: 3 });
    const oneVacancy = move(resident, 0, 1, lowest);
    expect(oneVacancy).toMatchObject({ movesLeft: 2, score: 0, gameOver: false });
    expect(move({ ...resident, movesLeft: 2 }, 0, 1, lowest).gameOver).toBe(true);
    expect(move(move(oneVacancy, 1, 0, lowest), 2, 1, lowest).score).toBe(150);

    const incoming = board([
      ['red', 'blue', 'blue', 'gold'], ['yellow', 'red', 'gold', JOKER], ['red', 'gold', 'red'],
    ], { capacity: 4, movesLeft: 2 });
    const rescue = move(incoming, 0, 2, lowest);
    expect(rescue).toMatchObject({ movesLeft: 1, score: 0, gameOver: false });
    expect(move(rescue, 1, 0, lowest).score).toBe(100);
  });

  it('finds a two-setup pressure rescue with only two natural copies of the scoring flavor', () => {
    const initial = board([
      [JOKER, 'blue', 'green'], ['yellow', 'blue'], ['gold', 'red'],
    ], { capacity: 3, level: 5, movesLeft: 4 });
    const afterMiss = move(initial, 2, 1, lowest);
    expect(afterMiss).toMatchObject({ movesLeft: 3, score: 0, gameOver: false });
    expect(move({ ...initial, movesLeft: 3 }, 2, 1, lowest).gameOver).toBe(true);
    const ready = move(move(afterMiss, 0, 2, lowest), 1, 2, lowest);
    expect(move(ready, 1, 0, lowest)).toMatchObject({ score: 140, movesLeft: 1 });
  });

  it('keeps bottom refills when the Joker already gives a quick score and stays unique in the rescue refill', () => {
    const onDough = vi.fn();
    const initial = board([['red'], ['red', 'red', 'red'], ['blue', JOKER], ['blue']], { movesLeft: 1 });
    const next = move(initial, 0, 1, highest, onDough);
    expect(onDough.mock.lastCall?.[0]).toHaveLength(3);
    expect(onDough.mock.lastCall?.[0].every((dough: DoughInsert) => dough.depth === 0)).toBe(true);
    expect(move(next, 3, 2, lowest).score).toBe(260);

    const rescue = move({ ...initial, stacks: [['red'], ['red', 'red', 'red'], [JOKER]] }, 0, 1, highest, onDough);
    expect(rescue.stacks.flat().filter(color => color === JOKER)).toHaveLength(1);
    expect(onDough.mock.lastCall?.[0].map((dough: DoughInsert) => dough.depth)).toEqual([0, 1, 2]);
    expect(move(rescue, 2, 0, lowest).score).toBe(260);
  });

  it('replaces only the 45th eligible third insert after level six and retains the natural RNG draw', () => {
    const ordinary = [['blue'], ['blue', 'blue'], ['red', 'gold']];
    const rng = vi.fn(lowest);
    const onDough = vi.fn<(inserts: readonly DoughInsert[]) => void>();
    let game = board(ordinary, { capacity: 7, level: 6, nextLevelScore: 100_000 });
    const scoreTriple = (stacks = ordinary, overrides: Partial<GameState> = {}) => {
      rng.mockClear();
      onDough.mockClear();
      game = move({ ...game, stacks, ...overrides, gameOver: false }, 0, 1, rng, onDough);
      return onDough.mock.lastCall![0];
    };

    for (let i = 0; i < 45; i++) expect(scoreTriple().map(dough => dough.color)).not.toContain(JOKER);
    for (let i = 0; i < 44; i++) expect(scoreTriple(ordinary, { level: 7 }).map(dough => dough.color)).not.toContain(JOKER);
    expect(scoreTriple([['red', 'gold', 'blue'], ['blue', 'blue']], { capacity: 3 })).toHaveLength(2);
    expect(scoreTriple([['blue'], ['blue', 'blue', 'blue'], ['red', 'gold']], { capacity: 7 })
      .map(dough => dough.color)).not.toContain(JOKER);
    expect(scoreTriple([['blue'], ['red'], ['gold']], { movesLeft: 1 }).map(dough => dough.color)).not.toContain(JOKER);
    expect(scoreTriple([['blue'], ['blue', 'blue'], [JOKER, 'red', 'gold']]).map(dough => dough.color))
      .not.toContain(JOKER);
    expect(game.stacks.flat().filter(color => color === JOKER)).toHaveLength(1);

    expect(scoreTriple()).toEqual([
      { stack: 0, depth: 0, color: 'blue' }, { stack: 1, depth: 0, color: 'blue' }, { stack: 0, depth: 0, color: JOKER },
    ]);
    expect(rng).toHaveBeenCalledTimes(1);
    for (let i = 0; i < 44; i++) expect(scoreTriple().map(dough => dough.color)).not.toContain(JOKER);
    expect(scoreTriple().at(-1)?.color).toBe(JOKER);
    expect(createGame(lowest).stacks.flat()).not.toContain(JOKER);
  });
});

describe('Master of Donuts 2 rules', () => {
  it('deals balanced, varied openings without an already matched stack', () => {
    const opening = createGame(lowest);
    const another = createGame(highest);

    for (const game of [opening, another]) {
      const inventory = game.stacks.flat();
      const colors = new Set(inventory);
      expect(colors.size).toBe(3);
      for (const color of colors) expect(inventory.filter((donut) => donut === color)).toHaveLength(3);
      expect(game.stacks.map((stack) => stack.length)).toEqual([3, 3, 3]);
      expect(game.stacks.every((stack) => new Set(stack).size > 1)).toBe(true);
      expect(game).toMatchObject({ score: 0, combo: 0, level: 1, capacity: 5, nextLevelScore: 500, gameOver: false });
    }
    expect(another.stacks).not.toEqual(opening.stacks);
    expect(createGame(lowest)).toEqual(opening);
  });

  it.each([[0, 6], [1 / 3, 7], [2 / 3, 8]])('rolls %s for %i misses after the opening deal', (draw, movesLeft) => {
    const rng = vi.fn(() => draw);
    for (let i = 0; i < 15; i++) rng.mockReturnValueOnce(highest());

    const game = createGame(rng);

    expect(game.stacks).toEqual([['yellow', 'yellow', 'gold'], ['red', 'red', 'yellow'], ['gold', 'gold', 'red']]);
    expect(game.movesLeft).toBe(movesLeft);
    expect(rng).toHaveBeenCalledTimes(16);
  });

  it('allows a single top donut into any different non-full stack and rejects invalid moves by identity', () => {
    const game = board([['red', 'gold'], ['yellow', 'yellow', 'red', 'red', 'gold'], []]);
    for (const [from, to] of [[0, 0], [0, 1], [2, 0], [-1, 0], [0, 3], [0.5, 2], [NaN, 2]]) {
      expect(canMove(game, from, to)).toBe(false);
      expect(move(game, from, to)).toBe(game);
    }
    expect(canMove(game, 0, 2)).toBe(true);
    const rng = vi.fn(lowest);
    const next = move(game, 0, 2, rng);
    expect(next.stacks).toEqual([['red'], game.stacks[1], ['gold']]);
    expect(next.movesLeft).toBe(6);
    expect(game.stacks[0]).toEqual(['red', 'gold']);
    expect(game.stacks[2]).toEqual([]);
    expect(rng).not.toHaveBeenCalled();
    expect(move(game, 0, 1)).toBe(game);
  });

  it('clears only the destination triple, scores, and refills the shortest stacks from the bottom', () => {
    const game = board([
      ['gold', 'red', 'red', 'red', 'gold'],
      ['yellow', 'gold', 'gold'],
      ['red', 'red'],
    ], { movesLeft: 2 });
    const onDough = vi.fn();
    const next = move(game, 0, 1, lowest, onDough);

    expect(next.stacks).toEqual([
      ['gold', 'red', 'red', 'red'],
      ['red', 'gold', 'yellow'],
      ['gold', 'red', 'red'],
    ]);
    expect(next.score).toBe(100);
    expect(next.movesLeft).toBe(2);
    expect(onDough).toHaveBeenCalledExactlyOnceWith([
      { stack: 1, depth: 0, color: 'gold' },
      { stack: 2, depth: 0, color: 'gold' },
      { stack: 1, depth: 0, color: 'red' },
    ]);
    expect(game.stacks[1]).toEqual(['yellow', 'gold', 'gold']);
  });

  it('counts a contiguous pre-move run including the incoming donut', () => {
    expect(matchedRunLength([], 'red')).toBe(0);
    expect(matchedRunLength(['gold', 'red'], 'red')).toBe(0);
    expect(matchedRunLength(['red', 'red', 'gold'], 'red')).toBe(0);
    const covered = ['red', 'gold', 'red', 'red', 'red'] as const;
    expect(matchedRunLength(covered, 'red')).toBe(4);
    expect(covered).toEqual(['red', 'gold', 'red', 'red', 'red']);
    expect(matchedRunLength(Array(9).fill('red'), 'red')).toBe(10);
  });

  it.each([
    [1, 3, 100], [1, 4, 150], [1, 5, 200],
    [2, 3, 110], [2, 4, 165], [2, 5, 220],
  ])('at level %i a %i-donut clear awards %i points', (level, runLength, award) => {
    const game = board([['red'], Array(runLength - 1).fill('red'), ['gold', 'yellow']], {
      level, capacity: level + 4,
    });
    expect(move(game, 0, 1, lowest).score).toBe(award);
  });

  it('uses the starting level’s award when a large clear immediately crosses the goal', () => {
    const game = board([['red'], ['gold', 'red', 'red', 'red'], ['yellow', 'gold']], { score: 390 });

    const next = move(game, 0, 1, lowest);
    expect(next).toMatchObject({ score: 540, combo: 1, level: 2, capacity: 6, nextLevelScore: 1500 });
    expect(move(next, 1, 0, highest)).toMatchObject({ score: 661, combo: 2, level: 2 });
  });

  it('starts a legacy fixture at zero, preserves a streak on invalid moves and resets it on a miss', () => {
    const game = board([
      ['red'], ['red', 'red'], ['gold'], ['gold', 'gold'], ['yellow'], ['yellow', 'yellow'], ['blue'], ['purple'],
    ], { capacity: 10, level: 16, score: 33000, nextLevelScore: 38300 });

    expect(game.combo).toBeUndefined();
    const first = move(game, 0, 1, lowest);
    expect(first).toMatchObject({ score: 33250, combo: 1 });
    const second = move(first, 2, 3, lowest);
    expect(second).toMatchObject({ score: 33525, combo: 2 });
    expect(move(second, 2, 2, lowest)).toBe(second);
    expect(move(second, -1, 0, lowest)).toBe(second);
    const third = move(second, 4, 5, lowest);
    expect(third).toMatchObject({ score: 33825, combo: 3 });
    expect(move(third, 6, 7, lowest)).toMatchObject({ score: 33825, combo: 0, movesLeft: 6 });
    expect(createGame(lowest).combo).toBe(0);
  });

  it('rounds down the bonus on the level-adjusted long-run award', () => {
    const game = board([['red'], ['gold', 'red', 'red', 'red'], ['yellow', 'gold']], {
      combo: 1, level: 2, capacity: 6, nextLevelScore: 1500,
    });
    expect(move(game, 0, 1, lowest)).toMatchObject({ score: 181, combo: 2 });
  });

  it('caps the bonus at 50 percent while the streak keeps counting', () => {
    const game = board([
      ['red'], ['red', 'red'], ['gold'], ['gold', 'gold'], ['yellow'], ['yellow', 'yellow'], ['blue'], ['purple'],
    ], { combo: 4, capacity: 10, level: 16, score: 33000, nextLevelScore: 38300 });

    const fifth = move(game, 0, 1, lowest);
    expect(fifth).toMatchObject({ score: 33350, combo: 5 });
    const sixth = move(fifth, 2, 3, lowest);
    expect(sixth).toMatchObject({ score: 33725, combo: 6 });
    expect(move(sixth, 4, 5, lowest)).toMatchObject({ score: 34100, combo: 7 });
  });

  it('clears all four reds above gold and makes a bottom-only continuation on the reported board', () => {
    const game = board([['red'], ['gold', 'red', 'red', 'red'], ['yellow', 'gold']]);
    const next = move(game, 0, 1, lowest);

    expect(next.stacks).toEqual([['red', 'gold', 'gold'], ['gold'], ['yellow', 'gold']]);
    expect(next).toMatchObject({ score: 150, movesLeft: 7, gameOver: false });
    expect(game.stacks[1]).toEqual(['gold', 'red', 'red', 'red']);
    expect(canMove(next, 1, 0)).toBe(true);
    expect(move(next, 1, 0, highest).score).toBe(260);
  });

  it('keeps ordinary bottom refill when a legal setup miss can unlock the next score', () => {
    const game = board([
      ['gold', 'gold', 'red'], ['yellow', 'red', 'red', 'red'], ['gold', 'yellow'],
    ], { movesLeft: 2 });
    const next = move(game, 0, 1, lowest);
    expect(next.stacks).toEqual([['red', 'gold', 'gold'], ['gold', 'red', 'yellow'], ['gold', 'yellow']]);
    expect(next.score).toBe(150);

    const setup = move(next, 2, 1, highest);
    expect(setup).toMatchObject({ score: 150, movesLeft: 1, gameOver: false });
    expect(canMove(setup, 2, 0)).toBe(true);
    expect(move(setup, 2, 0, highest).score).toBe(250);
  });

  it('creates a scoring transfer with only three new donuts when the clear empties the whole board', () => {
    const game = board([['red'], ['red', 'red', 'red'], []], { movesLeft: 1 });
    const next = move(game, 0, 1, highest);

    expect(next.stacks).toEqual([['red'], ['red', 'red'], []]);
    expect(next).toMatchObject({ score: 150, movesLeft: 1, gameOver: false });
    expect(canMove(next, 0, 1)).toBe(true);
    expect(move(next, 0, 1, lowest)).toMatchObject({ score: 260, movesLeft: 1 });
  });

  it('clears a five-donut run while preserving the same color below a blocker', () => {
    const game = board([
      ['yellow', 'red'], ['red', 'gold', 'red', 'red', 'red', 'red'], ['gold'], ['blue'],
    ], { capacity: 7, level: 5, score: 3700, nextLevelScore: 4800, movesLeft: 1 });
    const next = move(game, 0, 1, lowest);

    expect(next.stacks[1]).toEqual(['red', 'gold', 'yellow', 'yellow']);
    expect(next.stacks.flat()).toHaveLength(game.stacks.flat().length - 5 + 3);
    expect(next.score).toBe(3980);
    expect(canMove(next, 0, 1)).toBe(true);
    expect(move(next, 0, 1, highest).score).toBe(4134);
  });

  it('clears a ten-donut run at maximum capacity, scores once, and preserves an existing scoring move', () => {
    const game = board([
      ['gold', 'red'], Array(9).fill('red'), ['gold', 'gold'], ['blue'], ['blue'], ['purple'], ['choco'], ['yellow'],
    ], { capacity: 10, level: 16, score: 33000, nextLevelScore: 38300 });
    const next = move(game, 0, 1, lowest);

    expect(next.stacks).toEqual([
      ['red', 'gold'], ['gold', 'red'], ['gold', 'gold'], ['blue'], ['blue'], ['purple'], ['choco'], ['yellow'],
    ]);
    expect(next).toMatchObject({ score: 34125, gameOver: false });
    expect(canMove(next, 0, 2)).toBe(true);
    expect(move(next, 0, 2, highest).score).toBe(34400);
  });

  it('uses the top-placement rescue against fatal pressure on a dense high-level board', () => {
    const covered = ['blue', 'gold', 'yellow', 'gold', 'yellow', 'gold'];
    const full = ['gold', 'yellow', 'gold', 'yellow', 'gold', 'yellow', 'gold', 'yellow', 'gold', 'yellow'];
    const game = board([
      [...full.slice(1), 'red'], [...covered, 'red', 'red', 'red'], ...Array.from({ length: 6 }, () => [...full]),
    ], { capacity: 10, level: 25, score: 63900, nextLevelScore: 67100, movesLeft: 1 });
    const onDough = vi.fn();
    const next = move(game, 0, 1, lowest, onDough);

    expect(next.stacks).toEqual([[...full.slice(1), 'yellow'], [...covered, 'yellow', 'yellow'], ...game.stacks.slice(2)]);
    expect(next).toMatchObject({ score: 64410, movesLeft: 1, gameOver: false });
    expect(onDough).toHaveBeenCalledExactlyOnceWith([
      { stack: 1, depth: covered.length, color: 'yellow' },
      { stack: 1, depth: covered.length + 1, color: 'yellow' },
      { stack: 0, depth: full.length - 1, color: 'yellow' },
    ]);
    expect(canMove(next, 0, 1)).toBe(true);
    const followUp = move(next, 0, 1, highest);
    expect(bruteCanScore(followUp.stacks, followUp.capacity, 1)).toBe(false);
    expect(followUp).toMatchObject({ score: 64784, movesLeft: 1, gameOver: true });
  });

  it('protects top pairs and completes the match refill before a capacity upgrade', () => {
    const game = board([
      ['yellow', 'red', 'gold', 'gold', 'gold'],
      ['red', 'yellow', 'gold', 'gold'],
      ['red', 'yellow', 'red', 'yellow', 'red'],
    ], { score: 400 });
    const rng = vi.fn(lowest);
    const next = move(game, 0, 1, rng);

    expect(next.stacks).toEqual([
      ['yellow', 'yellow', 'red', 'gold', 'gold'],
      ['gold', 'red', 'yellow'],
      game.stacks[2],
    ]);
    expect(rng).toHaveBeenCalledTimes(1);
    expect(next).toMatchObject({ score: 500, level: 2, rank: 'Pastry Pupil', capacity: 6, nextLevelScore: 1500 });
  });

  it('keeps the miss countdown through a match and rolls a new interval after each pressure refill', () => {
    let game = board([['red'], ['red', 'red'], ['gold', 'yellow']]);
    const rng = vi.fn(lowest)
      .mockReturnValueOnce(0) // Match refill color.
      .mockReturnValueOnce(0).mockReturnValueOnce(0.9) // Pressure color, then eight misses.
      .mockReturnValueOnce(0.5).mockReturnValueOnce(0); // Pressure color, then six misses.
    const onDough = vi.fn();
    const miss = (index: number) => {
      const [from, to] = index % 2 === 0 ? [2, 0] : [0, 2];
      game = move(game, from, to, rng, onDough);
    };

    miss(0);
    miss(1);
    expect(game.movesLeft).toBe(5);
    expect(rng).not.toHaveBeenCalled();

    game = move(game, 0, 1, rng);
    expect(game).toMatchObject({ score: 100, movesLeft: 5 });

    for (let i = 2; i < 6; i++) {
      miss(i);
      expect(game.movesLeft).toBe(6 - i);
    }
    expect(rng).toHaveBeenCalledTimes(1);
    expect(onDough).not.toHaveBeenCalled();

    miss(6);
    expect(game).toMatchObject({ movesLeft: 8, score: 100, gameOver: false });
    expect(onDough).toHaveBeenCalledExactlyOnceWith([{ stack: 1, depth: 0, color: 'gold' }]);
    expect(rng).toHaveBeenCalledTimes(3);

    for (let i = 7; i < 14; i++) {
      miss(i);
      expect(game.movesLeft).toBe(14 - i);
    }
    expect(onDough).toHaveBeenCalledTimes(1);
    expect(rng).toHaveBeenCalledTimes(3);

    miss(14);
    expect(game).toMatchObject({ movesLeft: 6, score: 100, gameOver: false });
    expect(onDough).toHaveBeenNthCalledWith(2, [{ stack: 2, depth: 0, color: 'red' }]);
    expect(rng).toHaveBeenCalledTimes(5);
  });

  it('ends play when a refill leaves one slot without a reachable match, and supports a clean restart', () => {
    const game = board([
      ['gold', 'red', 'yellow', 'gold', 'yellow'],
      ['red', 'yellow', 'gold', 'red'],
      ['yellow', 'gold', 'red', 'yellow'],
    ], { movesLeft: 1 });
    const next = move(game, 0, 1, lowest);

    expect(next.stacks.map((stack) => stack.length)).toEqual([5, 5, 4]);
    expect(next.gameOver).toBe(true);
    expect(canMove(next, 0, 2)).toBe(false);
    expect(move(next, 0, 2)).toBe(next);
    const restart = createGame(lowest);
    expect(restart).toMatchObject({ level: 1, score: 0, movesLeft: 6, gameOver: false });
    expect(restart.stacks).not.toBe(next.stacks);
    expect(canMove(restart, 0, 1)).toBe(true);
  });

  it('reports both actual bottom inserts when pressure refills the same stack twice', () => {
    const game = board([['gold'], ['red'], ['yellow', 'red', 'gold']], { level: 5, capacity: 7, movesLeft: 1 });
    const rng = vi.fn(lowest);
    const onDough = vi.fn();
    const next = move(game, 0, 1, rng, onDough);

    expect(next.stacks).toEqual([['gold', 'gold'], ['red', 'gold'], game.stacks[2]]);
    expect(onDough).toHaveBeenCalledExactlyOnceWith([
      { stack: 0, depth: 0, color: 'gold' },
      { stack: 0, depth: 0, color: 'gold' },
    ]);
    expect(rng).toHaveBeenCalledTimes(3);
  });

  it('allows a last-slot rescue by exposing a pair, but ends play when the final slot is filled', () => {
    const game = board([
      ['gold', 'red', 'yellow', 'gold', 'yellow'],
      ['red', 'yellow', 'gold', 'gold'],
      ['yellow', 'gold', 'red', 'yellow'],
    ], { movesLeft: 1 });
    const oneSlot = move(game, 0, 1, lowest);
    expect(oneSlot.stacks.map((stack) => stack.length)).toEqual([5, 5, 4]);
    expect(oneSlot.gameOver).toBe(false);

    const exposePair = move(oneSlot, 1, 2, lowest);
    expect(exposePair.score).toBe(0);
    expect(move(exposePair, 0, 1, lowest).score).toBe(100);

    const filled = move({ ...oneSlot, movesLeft: 1 }, 1, 2, lowest);
    expect(filled.stacks.map((stack) => stack.length)).toEqual([5, 5, 5]);
    expect(filled.gameOver).toBe(true);

    const onDough = vi.fn();
    const batch = move({ ...game, level: 5 }, 0, 1, lowest, onDough);
    expect(batch.stacks.map((stack) => stack.length)).toEqual([5, 5, 5]);
    expect(batch.gameOver).toBe(true);
    expect(onDough.mock.lastCall?.[0]).toHaveLength(2);
  });

  it('stops a multi-donut pressure refill as soon as the remaining slot cannot rescue the board', () => {
    const game = board([
      ['gold', 'red', 'yellow', 'gold', 'red', 'gold', 'yellow'],
      ['red', 'yellow', 'gold', 'red', 'yellow', 'red'],
      ['yellow', 'gold', 'red', 'yellow', 'red', 'yellow'],
      ['red', 'yellow', 'gold', 'red', 'yellow', 'red', 'gold'],
    ], { level: 5, capacity: 7, movesLeft: 1 });
    const rng = vi.fn(lowest);
    const onDough = vi.fn();
    const next = move(game, 0, 1, rng, onDough);

    expect(next.stacks.map((stack) => stack.length)).toEqual([7, 7, 6, 7]);
    expect(next.gameOver).toBe(true);
    expect(rng).toHaveBeenCalledTimes(2);
    expect(onDough.mock.lastCall?.[0]).toHaveLength(1);
  });

  it('ends the level 16 repro early without drawing RNG or emitting dough', () => {
    const full = ['gold', 'red', 'gold', 'red', 'gold', 'red', 'gold', 'red', 'gold', 'red'];
    const stacks = Array.from({ length: 8 }, () => full.slice());
    stacks[1] = [...full.slice(0, 7), 'blue'];
    const game = board(stacks, { capacity: 10, level: 16, score: 33000, nextLevelScore: 38300, movesLeft: 2 });
    const rng = vi.fn(lowest);
    const onDough = vi.fn();
    const next = move(game, 0, 1, rng, onDough);

    expect(next).toMatchObject({ score: 33000, movesLeft: 1, gameOver: true });
    expect(next.stacks[0]).toEqual(full.slice(0, 9));
    expect(next.stacks[1]).toEqual([...stacks[1], 'red']);
    expect(rng).not.toHaveBeenCalled();
    expect(onDough).not.toHaveBeenCalled();
    expect(stacks[0]).toEqual(full);
  });

  it('keeps a position alive if the next pressure refill still leaves at least two vacancies', () => {
    const game = board([
      ['gold', 'red', 'gold', 'red', 'gold'], ['gold', 'red', 'blue'], ['gold', 'red', 'gold', 'red'],
    ], { movesLeft: 2 });
    const next = move(game, 0, 1, lowest);
    expect(bruteCanScore(next.stacks, next.capacity, 1)).toBe(false);
    expect(next).toMatchObject({ movesLeft: 1, score: 0, gameOver: false });
  });

  it.each([1, 2, 4, 6, 7])('proves the screenshot terminal with %i moves left before the next refill', (movesLeft) => {
    const game = board([
      ['gray', 'blue', 'purple'], ['green', 'blue', 'gray', 'gray', 'purple'], ['purple', 'green', 'purple', 'blue', 'blue'],
    ], { level: 2, score: 500, nextLevelScore: 1500, movesLeft: movesLeft + 1 });
    const rng = vi.fn(lowest);
    const onDough = vi.fn();
    const next = move(game, 1, 0, rng, onDough);
    expect(next.stacks).toEqual([
      ['gray', 'blue', 'purple', 'purple'], ['green', 'blue', 'gray', 'gray'], ['purple', 'green', 'purple', 'blue', 'blue'],
    ]);
    expect(bruteCanScore(next.stacks, 5, movesLeft, (stacks) => {
      const shortest = Math.min(...stacks.map((stack) => stack.length));
      return stacks.some((stack, i) => stack.length === shortest &&
        ['gold', 'red', 'yellow', 'choco', 'gray', 'purple', 'blue', 'green', JOKER].some((color) => {
          const filled = stacks.map((other, j) => i === j ? [color, ...other] : other);
          return bruteCanScore(filled, 5, 8);
        }));
    })).toBe(false);
    expect(next).toMatchObject({ score: 500, movesLeft, gameOver: true });
    expect(rng).not.toHaveBeenCalled();
    expect(onDough).not.toHaveBeenCalled();
  });

  it('proves the screenshot terminal after an actual refill rolls the eight-miss interval', () => {
    const game = board([
      ['blue', 'purple', 'purple', 'gray'], ['green', 'blue', 'gray'], ['purple', 'green', 'purple', 'blue', 'blue'],
    ], { level: 2, score: 500, nextLevelScore: 1500, movesLeft: 1 });
    const rng = vi.fn(highest);
    const onDough = vi.fn();
    const next = move(game, 0, 1, rng, onDough);

    expect(next.stacks).toEqual([
      ['gray', 'blue', 'purple', 'purple'], ['green', 'blue', 'gray', 'gray'], ['purple', 'green', 'purple', 'blue', 'blue'],
    ]);
    expect(next).toMatchObject({ score: 500, movesLeft: 8, gameOver: true });
    expect(rng).toHaveBeenCalledTimes(2);
    expect(onDough).toHaveBeenCalledExactlyOnceWith([{ stack: 0, depth: 0, color: 'gray' }]);
  });

  it('allows a post-refill setup that scores with an existing Joker', () => {
    const game = board([
      ['green', 'gray', 'gray', 'gray', 'gray', 'blue', 'blue'], ['gold', 'gray', 'green', 'gray'],
      ['purple', 'blue', 'green', 'green', 'green', JOKER, 'gray'],
      ['blue', 'gray', 'gold', 'gray', 'green', 'gray', 'gold'], ['purple', 'green', 'gold', 'gold', 'green', 'gray', 'green'],
    ], { capacity: 7, level: 7, score: 7000, nextLevelScore: 9200, movesLeft: 2 });
    const ready = move(game, 0, 1, lowest);
    expect(ready).toMatchObject({ score: 7000, movesLeft: 1, gameOver: false });
    expect(bruteCanScore(ready.stacks, 7, 1)).toBe(false);
    const filled = move(ready, 1, 0, lowest);
    expect(filled).toMatchObject({ score: 7000, movesLeft: 6, gameOver: false });
    const setup = move(filled, 2, 1, lowest);
    const scored = move(setup, 4, 2, lowest);
    expect(scored.score).toBe(7320);
    expect(scored.stacks.flat()).not.toContain(JOKER);
  });

  it('allows a pressure donut to become a scoring donor in a nearly empty stack', () => {
    const full = ['gold', 'red', 'blue', 'red', 'blue', 'red', 'blue', 'red', 'blue', 'red'];
    const game = board([
      [], full.slice(0, -1), full, ['gold', 'blue', 'red', 'blue', 'red', 'blue', 'red', 'gold', 'gold', 'blue'],
      ...Array.from({ length: 4 }, () => full.slice()),
    ], { capacity: 10, level: 45, score: 129000, nextLevelScore: 131100, movesLeft: 2 });
    const ready = move(game, 2, 1, lowest);
    expect(ready).toMatchObject({ score: 129000, movesLeft: 1, gameOver: false });
    expect(bruteCanScore(ready.stacks, 10, 1)).toBe(false);
    const rng = vi.fn(lowest);
    const onDough = vi.fn();
    const filled = move(ready, 3, 2, rng, onDough);
    expect(filled).toMatchObject({ score: 129000, movesLeft: 6, gameOver: false });
    expect(filled.stacks[0].at(-1)).toBe('gold');
    expect(onDough.mock.lastCall?.[0]).toHaveLength(10);
    expect(rng).toHaveBeenCalledTimes(11);
    expect(move(filled, 0, 3, lowest).score).toBe(129540);
  });

  it('keeps an actual two-setup rescue alive before a guaranteed full refill', () => {
    const game = board([
      ['gold', 'choco', 'red', 'yellow', 'yellow', 'choco', 'gold'],
      ['gold', 'yellow', 'choco', 'gold', 'choco'],
      ['choco', 'choco', 'choco', 'yellow', 'red', 'red', 'choco'],
      ['choco', 'red', 'red', 'gold', 'gold', 'choco', 'gold'],
    ], { capacity: 7, level: 5, score: 3800, nextLevelScore: 4800, movesLeft: 4 });
    const next = move(game, 0, 1, lowest);
    expect(next).toMatchObject({ score: 3800, movesLeft: 3, gameOver: false });
    expect(bruteCanScore(next.stacks, next.capacity, 2)).toBe(false);
    const setup1 = move(next, 3, 0, lowest);
    const setup2 = move(setup1, 3, 1, lowest);
    expect(setup2).toMatchObject({ score: 3800, movesLeft: 1, gameOver: false });
    expect(move(setup2, 0, 3, lowest).score).toBe(3940);
  });

  it('agrees with independent brute force on dense seeded boards and short budgets', () => {
    let seed = 29;
    const draw = () => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
      return ['gold', 'red', 'choco', 'yellow'][(seed >>> 22) & 3];
    };
    const outcomes = new Set<boolean>();
    for (const spaces of [1, 2]) {
      for (let i = 0; i < 24; i++) {
        const stacks = [7, 7 - spaces, 7, 7].map((length) => Array.from({ length }, draw));
        stacks[0][6] = 'gold';
        stacks[1][stacks[1].length - 1] = 'red';
        for (let budget = 1; budget <= 4; budget++) {
          const game = board(stacks, { capacity: 7, level: 5, movesLeft: budget + 1 });
          const next = move(game, 0, 1, lowest);
          const dead = !bruteCanScore(next.stacks, next.capacity, budget);
          outcomes.add(dead);
          expect(next.gameOver).toBe(dead);
        }
      }
    }
    expect(outcomes).toEqual(new Set([true, false]));
  });

  it('keeps a position alive when the proof exhausts its bounded search', () => {
    const core = ['blue', 'green', 'blue', 'green', 'blue', 'green', 'blue', 'green'];
    // The two vacancies cannot expose anything below these cores. Each movable
    // color occurs twice and none match the core tops, but many layouts can recur.
    const stacks = ['gold', 'red', 'yellow', 'choco', 'gray', 'purple', 'blue'].map((color) => [...core, color, color]);
    stacks.push(core.slice());
    const game = board(stacks, { capacity: 10, level: 16, movesLeft: 8 });
    expect(move(game, 0, 7, lowest).gameOver).toBe(false);
    expect(move({ ...game, movesLeft: 2 }, 0, 7, lowest).gameOver).toBe(true);
  });

  it('unlocks a half-filled fourth stack at level 3 with only the standard match refill', () => {
    const game = board([['gold'], ['gold', 'gold'], ['yellow', 'red']], {
      level: 2, score: 1390, capacity: 6, nextLevelScore: 1500,
    });
    const rng = vi.fn(lowest);
    const onDough = vi.fn();
    const level3 = move(game, 0, 1, rng, onDough);
    expect(level3).toMatchObject({ score: 1500, level: 3, rank: 'Fryer Fighter', capacity: 6, nextLevelScore: 2600 });
    expect(level3.stacks).toEqual([['yellow', 'gold'], ['gold'], ['yellow', 'red'], ['gold', 'gold', 'yellow']]);
    expect(rng).toHaveBeenCalledTimes(4);
    expect(onDough).toHaveBeenCalledExactlyOnceWith([
      { stack: 0, depth: 0, color: 'gold' },
      { stack: 1, depth: 0, color: 'gold' },
      { stack: 0, depth: 0, color: 'yellow' },
    ]);
    expect(canMove(level3, 0, 3)).toBe(true);
    expect(move(level3, 0, 3, lowest).stacks[3]).toEqual(['gold', 'gold', 'yellow', 'gold']);
  });

  it('advances from level 3 to level 4 by unlocking a color while keeping four stacks', () => {
    const game = board([['gold'], ['gold', 'gold'], ['yellow', 'red'], ['red']], {
      level: 3, score: 2468, combo: 1, capacity: 6, nextLevelScore: 2600,
    });
    const level4 = move(game, 0, 1, lowest);
    expect(move({ ...game, score: 2368 }, 0, 1, lowest)).toMatchObject({ score: 2500, level: 3 });
    expect(level4).toMatchObject({ score: 2600, level: 4, rank: 'Batter Boss', capacity: 6, nextLevelScore: 3700 });
    expect(level4.stacks).toHaveLength(4);
    const pressure = move({ ...level4, stacks: [['gold'], ['yellow'], ['red'], []], movesLeft: 1 }, 0, 1, highest);
    expect(pressure.stacks[0]).toEqual(['choco']);
  });

  it('rounds the fifth stack down to three donuts on a board one miss from defeat', () => {
    const game = board([
      ['red', 'yellow', 'gold', 'red', 'yellow', 'red', 'gold'],
      ['yellow', 'red', 'gold', 'yellow', 'gold', 'gold'],
      ['red', 'yellow', 'gold', 'red', 'yellow', 'gold', 'red'],
      ['yellow', 'gold', 'red', 'yellow', 'gold', 'red', 'yellow'],
    ], { level: 5, score: 4646, combo: 1, capacity: 7, nextLevelScore: 4800, movesLeft: 1 });

    expect(move(game, 2, 1, lowest)).toMatchObject({ gameOver: true, score: 4646, level: 5 });
    expect(move({ ...game, score: 4645 }, 0, 1, lowest)).toMatchObject({ gameOver: true, score: 4799, level: 5 });

    const rng = vi.fn(lowest);
    const onDough = vi.fn();
    const level6 = move(game, 0, 1, rng, onDough);
    expect(level6).toMatchObject({ score: 4800, combo: 2, level: 6, capacity: 7, nextLevelScore: 7000, gameOver: false });
    expect(level6.stacks.map((stack) => stack.length)).toEqual([7, 5, 7, 7, 3]);
    expect(level6.stacks[4]).toEqual(['red', 'red', 'yellow']);
    expect(rng).toHaveBeenCalledTimes(3);
    expect(onDough).toHaveBeenCalledExactlyOnceWith([
      { stack: 1, depth: 0, color: 'gold' },
      { stack: 0, depth: 0, color: 'gold' },
    ]);
    expect(canMove(level6, 2, 4)).toBe(true);
    const firstDrop = move(level6, 2, 4, lowest);
    expect(firstDrop.stacks[4]).toEqual(['gold', 'red', 'red', 'yellow', 'red']);
    expect(firstDrop).toMatchObject({ gameOver: false, score: 4800, movesLeft: 6 });
  });

  it('unlocks a half-filled sixth stack at the level 8 goal with refill confined to the old board', () => {
    const game = board([
      ['gold'], ['gold', 'gold'], ['yellow', 'red'], ['choco', 'gray'], ['red', 'yellow'],
    ], { level: 8, score: 11230, capacity: 8, nextLevelScore: 11400 });
    const oldGoal = move({ ...game, score: 10330 }, 0, 1, lowest);
    expect(oldGoal).toMatchObject({ score: 10500, level: 8 });
    expect(oldGoal.stacks).toHaveLength(5);

    const rng = vi.fn(lowest);
    const onDough = vi.fn();
    const level9 = move(game, 0, 1, rng, onDough);

    expect(level9).toMatchObject({ score: 11400, level: 9, capacity: 8, nextLevelScore: 13700 });
    expect(level9.stacks).toEqual([['yellow', 'gold'], ['gold'], ...game.stacks.slice(2), ['gold', 'gold', 'yellow', 'gold']]);
    expect(rng).toHaveBeenCalledTimes(5);
    expect(onDough).toHaveBeenCalledExactlyOnceWith([
      { stack: 0, depth: 0, color: 'gold' },
      { stack: 1, depth: 0, color: 'gold' },
      { stack: 0, depth: 0, color: 'yellow' },
    ]);
    expect(canMove(level9, 0, 5)).toBe(true);
    expect(move(level9, 0, 5, lowest).stacks[5]).toEqual(['gold', 'gold', 'yellow', 'gold', 'gold']);
  });

  it('seeds five donuts at level 15 from the active palette even with constant high RNG', () => {
    const game = board([
      ['gold'], ['gold', 'gold'], ['yellow', 'red'], ['choco', 'gray'], ['purple', 'blue'], ['red', 'yellow'], ['red', 'gold'],
    ], { level: 14, score: 29370, capacity: 10, nextLevelScore: 29600 });
    const rng = vi.fn(() => 1 - Number.EPSILON);
    const onDough = vi.fn();
    const next = move(game, 0, 1, rng, onDough);

    expect(next).toMatchObject({ level: 15, score: 29600, capacity: 10, gameOver: false });
    expect(next.stacks[7]).toEqual(['blue', 'blue', 'purple', 'blue', 'purple']);
    expect(rng).toHaveBeenCalledTimes(6);
    expect(onDough).toHaveBeenCalledExactlyOnceWith([
      { stack: 0, depth: 0, color: 'gold' },
      { stack: 1, depth: 0, color: 'gold' },
      { stack: 0, depth: 0, color: 'blue' },
    ]);
  });

  it.each([
    { firstOrder: 'HSC', firstDraw: 0.1 },
    { firstOrder: 'HCS', firstDraw: 0.2 },
    { firstOrder: 'SHC', firstDraw: 0.4 },
    { firstOrder: 'SCH', firstDraw: 0.6 },
    { firstOrder: 'CHS', firstDraw: 0.7 },
    { firstOrder: 'CSH', firstDraw: 0.9 },
  ])('applies the $firstOrder opening order and shuffles the four later blocks', ({ firstOrder, firstDraw }) => {
    const openingRng = vi.fn(highest);
    let game = createGame(openingRng);
    expect(openingRng).toHaveBeenCalledTimes(16);
    expect(game.stacks).toEqual([['yellow', 'yellow', 'gold'], ['red', 'red', 'yellow'], ['gold', 'gold', 'red']]);

    const pendingDraws = [firstDraw, 0.7, 0.4, 0.2, 0.6];
    const lastActiveColors = ['yellow', 'choco', 'gray', 'purple', 'blue', 'green'];
    let lastActiveIndex = 0;
    const progression = firstOrder + 'CHS' + 'SHC' + 'HCS' + 'SCH' + '-';
    for (const [index, upgrade] of [...progression].entries()) {
      const level = index + 2;
      const { capacity, nextLevelScore, stacks: { length: stackCount } } = game;
      const stacks = [['gold'], ['gold', 'gold'], ...Array.from({ length: stackCount - 2 }, () => ['red'])];
      const score = nextLevelScore - (100 + 10 * (game.level - 1));
      const onDough = vi.fn();
      const rng = vi.fn(highest);
      const startsBlock = [2, 5, 8, 11, 14].includes(level);
      if (startsBlock) rng.mockReturnValueOnce(highest()).mockReturnValueOnce(pendingDraws.shift()!);
      const before = { ...game, stacks, score, combo: 0 };
      game = move(before, 0, 1, rng, onDough);

      expect(game).toMatchObject({ level, score: nextLevelScore, capacity: capacity + Number(upgrade === 'H') });
      expect(game.stacks).toHaveLength(stackCount + Number(upgrade === 'S'));
      const lastActiveColor = lastActiveColors[lastActiveIndex];
      expect(onDough).toHaveBeenCalledExactlyOnceWith([
        { stack: 0, depth: 0, color: 'gold' },
        { stack: 1, depth: 0, color: 'gold' },
        { stack: 0, depth: 0, color: lastActiveColor },
      ]);
      if (upgrade === 'S') {
        const newStack = game.stacks[stackCount];
        expect(newStack).toHaveLength([3, 3, 4, 4, 5][Math.floor((level - 2) / 3)]);
        expect(newStack[0]).toBe(lastActiveColor);
        expect(newStack.at(-1)).not.toBe(newStack.at(-2));
      }
      expect(rng).toHaveBeenCalledTimes(1 + Number(startsBlock) + (game.stacks[stackCount]?.length ?? 0));
      if (upgrade === 'C') lastActiveIndex++;
      if (level === 2) {
        // Replaying the threshold with a different draw leaves the first branch's order intact.
        const other = move(before, 0, 1, highest);
        expect(other.capacity).toBe(capacity);
        expect(other.stacks).toHaveLength(stackCount);
      }
      if (level === 16) expect(game.nextLevelScore).toBe(38300);
    }

    expect(game).toMatchObject({ level: 17, capacity: 10, rank: 'Master of Donuts', nextLevelScore: 41500 });
    expect(game.stacks).toHaveLength(8);
  });

  it('uses the calibrated level 16 target and the 3200-point fallback gap', () => {
    const stacks = [['gold'], ['gold', 'gold'], ['yellow'], ['red'], [], [], [], []];
    const game = board(stacks, { level: 15, score: 32760, capacity: 10, nextLevelScore: 33000 });
    const level16 = move(game, 0, 1, lowest);
    expect(level16).toMatchObject({ score: 33000, level: 16, capacity: 10, rank: 'Master of Donuts', nextLevelScore: 38300 });

    expect(move({ ...level16, score: 34225, stacks }, 0, 1, lowest)).toMatchObject({ score: 34500, level: 16 });
    const level17 = move({ ...level16, score: 38025, stacks }, 0, 1, lowest);
    expect(level17).toMatchObject({ score: 38300, level: 17, capacity: 10, rank: 'Master of Donuts', nextLevelScore: 41500 });
    expect(level17.stacks).toHaveLength(8);
    expect(move({ ...level17, score: 40988, stacks }, 0, 1, lowest)).toMatchObject({ score: 41300, level: 17 });
    expect(move({ ...level17, score: 41188, stacks }, 0, 1, lowest)).toMatchObject({ score: 41500, level: 18, nextLevelScore: 44700 });
  });

  it('continues increasing match awards and pressure refill counts in fallback levels', () => {
    const stacks = [['gold'], ['gold', 'gold'], ['yellow'], ['red'], [], [], [], []];
    const lateGame = board(stacks, {
      level: 25, score: 66760, rank: 'Master of Donuts', capacity: 10, nextLevelScore: 67100,
    });
    const lateMatch = move(lateGame, 0, 1, lowest);
    expect(lateMatch.score - lateGame.score).toBe(340);
    expect(lateMatch).toMatchObject({ score: 67100, level: 26, nextLevelScore: 70300, capacity: 10 });

    const latePressure = move({ ...lateGame, movesLeft: 1 }, 2, 3, lowest);
    expect(latePressure.stacks.flat()).toHaveLength(stacks.flat().length + 6);
    expect(latePressure).toMatchObject({ movesLeft: 6, gameOver: false });
  });

  it('advances one fallback level per scoring move even with enough points to pass multiple goals', () => {
    const game = board([
      ['gold', 'red'], Array(9).fill('red'), ['gold', 'gold'], ['blue'], ['blue'], ['purple'], ['choco'], ['yellow'],
    ], { capacity: 10, level: 200, score: 627099, nextLevelScore: 627100, rank: 'Master of Donuts' });

    const largeClear = move(game, 0, 1, lowest);
    expect(largeClear).toMatchObject({ score: 636504, level: 201, nextLevelScore: 630300 });
    expect(move(largeClear, 0, 2, highest)).toMatchObject({ score: 638814, level: 202, nextLevelScore: 633500 });
  });
});
