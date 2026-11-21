import { describe, expect, it, vi } from 'vitest';
import { canMove, createGame, matchedRunLength, move, type GameState } from './index';

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
      expect(game).toMatchObject({ score: 0, combo: 0, level: 1, capacity: 5, nextLevelScore: 500, movesLeft: 7, gameOver: false });
    }
    expect(another.stacks).not.toEqual(opening.stacks);
    expect(createGame(lowest)).toEqual(opening);
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
    ], { capacity: 10, level: 16, score: 30000, nextLevelScore: 34500 });

    expect(game.combo).toBeUndefined();
    const first = move(game, 0, 1, lowest);
    expect(first).toMatchObject({ score: 30250, combo: 1 });
    const second = move(first, 2, 3, lowest);
    expect(second).toMatchObject({ score: 30525, combo: 2 });
    expect(move(second, 2, 2, lowest)).toBe(second);
    expect(move(second, -1, 0, lowest)).toBe(second);
    const third = move(second, 4, 5, lowest);
    expect(third).toMatchObject({ score: 30825, combo: 3 });
    expect(move(third, 6, 7, lowest)).toMatchObject({ score: 30825, combo: 0, movesLeft: 6 });
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
    ], { combo: 4, capacity: 10, level: 16, score: 30000, nextLevelScore: 34500 });

    const fifth = move(game, 0, 1, lowest);
    expect(fifth).toMatchObject({ score: 30350, combo: 5 });
    const sixth = move(fifth, 2, 3, lowest);
    expect(sixth).toMatchObject({ score: 30725, combo: 6 });
    expect(move(sixth, 4, 5, lowest)).toMatchObject({ score: 31100, combo: 7 });
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
    ], { capacity: 7, level: 5, score: 3500, nextLevelScore: 4500, movesLeft: 1 });
    const next = move(game, 0, 1, lowest);

    expect(next.stacks[1]).toEqual(['red', 'gold', 'yellow', 'yellow']);
    expect(next.stacks.flat()).toHaveLength(game.stacks.flat().length - 5 + 3);
    expect(next.score).toBe(3780);
    expect(canMove(next, 0, 1)).toBe(true);
    expect(move(next, 0, 1, highest).score).toBe(3934);
  });

  it('clears a ten-donut run at maximum capacity, scores once, and preserves an existing scoring move', () => {
    const game = board([
      ['gold', 'red'], Array(9).fill('red'), ['gold', 'gold'], ['blue'], ['blue'], ['purple'], ['choco'], ['yellow'],
    ], { capacity: 10, level: 16, score: 30000, nextLevelScore: 34500 });
    const next = move(game, 0, 1, lowest);

    expect(next.stacks).toEqual([
      ['red', 'gold'], ['gold', 'red'], ['gold', 'gold'], ['blue'], ['blue'], ['purple'], ['choco'], ['yellow'],
    ]);
    expect(next).toMatchObject({ score: 31125, gameOver: false });
    expect(canMove(next, 0, 2)).toBe(true);
    expect(move(next, 0, 2, highest).score).toBe(31400);
  });

  it('uses the top-placement rescue against fatal pressure on a dense high-level board', () => {
    const covered = ['blue', 'gold', 'yellow', 'gold', 'yellow', 'gold'];
    const full = ['gold', 'yellow', 'gold', 'yellow', 'gold', 'yellow', 'gold', 'yellow', 'gold', 'yellow'];
    const game = board([
      [...full.slice(1), 'red'], [...covered, 'red', 'red', 'red'], ...Array.from({ length: 6 }, () => [...full]),
    ], { capacity: 10, level: 25, score: 58500, nextLevelScore: 61500, movesLeft: 1 });
    const onDough = vi.fn();
    const next = move(game, 0, 1, lowest, onDough);

    expect(next.stacks).toEqual([[...full.slice(1), 'yellow'], [...covered, 'yellow', 'yellow'], ...game.stacks.slice(2)]);
    expect(next).toMatchObject({ score: 59010, movesLeft: 1, gameOver: false });
    expect(onDough).toHaveBeenCalledExactlyOnceWith([
      { stack: 1, depth: covered.length, color: 'yellow' },
      { stack: 1, depth: covered.length + 1, color: 'yellow' },
      { stack: 0, depth: full.length - 1, color: 'yellow' },
    ]);
    expect(canMove(next, 0, 1)).toBe(true);
    expect(move(next, 0, 1, highest)).toMatchObject({ score: 59384, movesLeft: 1, gameOver: false });
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

  it('spends pressure on misses and inserts a donut on the seventh miss', () => {
    let game = board([['gold'], ['red'], ['yellow']]);
    const rng = vi.fn(lowest);
    for (let i = 0; i < 6; i++) {
      game = move(game, i % 2, 1 - i % 2, rng);
      expect(game.movesLeft).toBe(6 - i);
    }
    expect(rng).not.toHaveBeenCalled();

    const next = move(game, 0, 1, rng);
    expect(next.stacks).toEqual([['gold'], ['red', 'gold'], ['yellow']]);
    expect(next).toMatchObject({ movesLeft: 7, score: 0, gameOver: false });
    expect(rng).toHaveBeenCalledTimes(1);
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
    expect(restart).toMatchObject({ level: 1, score: 0, movesLeft: 7, gameOver: false });
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
    expect(rng).toHaveBeenCalledTimes(2);
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
    expect(rng).toHaveBeenCalledTimes(1);
    expect(onDough.mock.lastCall?.[0]).toHaveLength(1);
  });

  it('adds a 75%-filled stack with no triple, then enables a new color at the following level', () => {
    const game = board([['gold'], ['gold', 'gold'], ['yellow', 'red']], {
      level: 2, score: 1390, capacity: 6, nextLevelScore: 1500,
    });
    const level3 = move(game, 0, 1, lowest);
    expect(level3).toMatchObject({ score: 1500, level: 3, rank: 'Fryer Fighter', capacity: 6, nextLevelScore: 2500 });
    expect(level3.stacks).toHaveLength(4);
    expect(level3.stacks[3]).toEqual(['gold', 'gold', 'yellow', 'gold']);

    const level4 = move({ ...level3, stacks: [...game.stacks, ['red']], score: 2380 }, 0, 1, lowest);
    expect(level4).toMatchObject({ score: 2512, level: 4, rank: 'Batter Boss', capacity: 6, nextLevelScore: 3500 });
    const pressure = move({ ...level4, stacks: [['gold'], ['yellow'], ['red'], []], movesLeft: 1 }, 0, 1, highest);
    expect(pressure.stacks[0]).toEqual(['choco']);
  });

  it('preserves level 16’s legacy target and keeps the fallback geometry and rank', () => {
    const stacks = [['gold'], ['gold', 'gold'], ['yellow'], ['red'], [], [], [], []];
    const game = board(stacks, { level: 15, score: 29260, capacity: 10, nextLevelScore: 29500 });
    const level16 = move(game, 0, 1, lowest);
    expect(level16).toMatchObject({ score: 29500, level: 16, capacity: 10, rank: 'Master of Donuts', nextLevelScore: 34500 });

    const level17 = move({ ...level16, score: 34250, stacks }, 0, 1, lowest);
    expect(level17).toMatchObject({ score: 34525, level: 17, capacity: 10, rank: 'Master of Donuts', nextLevelScore: 37500 });
    expect(level17.stacks).toHaveLength(8);
  });

  it('continues increasing match awards and pressure refill counts in fallback levels', () => {
    const stacks = [['gold'], ['gold', 'gold'], ['yellow'], ['red'], [], [], [], []];
    const lateGame = board(stacks, {
      level: 25, score: 61160, rank: 'Master of Donuts', capacity: 10, nextLevelScore: 61500,
    });
    const lateMatch = move(lateGame, 0, 1, lowest);
    expect(lateMatch.score - lateGame.score).toBe(340);
    expect(lateMatch).toMatchObject({ score: 61500, level: 26, nextLevelScore: 64500, capacity: 10 });

    const latePressure = move({ ...lateGame, movesLeft: 1 }, 2, 3, lowest);
    expect(latePressure.stacks.flat()).toHaveLength(stacks.flat().length + 6);
    expect(latePressure).toMatchObject({ movesLeft: 7, gameOver: false });
  });

  it('advances one fallback level per scoring move even with enough points to pass multiple goals', () => {
    const game = board([
      ['gold', 'red'], Array(9).fill('red'), ['gold', 'gold'], ['blue'], ['blue'], ['purple'], ['choco'], ['yellow'],
    ], { capacity: 10, level: 100, score: 286499, nextLevelScore: 286500, rank: 'Master of Donuts' });

    const largeClear = move(game, 0, 1, lowest);
    expect(largeClear).toMatchObject({ score: 291404, level: 101, nextLevelScore: 289500 });
    expect(move(largeClear, 0, 2, highest)).toMatchObject({ score: 292614, level: 102, nextLevelScore: 292500 });
  });
});
