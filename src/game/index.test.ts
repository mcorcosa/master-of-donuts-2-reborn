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
    expect(move(next, 0, 1, highest)).toMatchObject({ score: 64784, movesLeft: 1, gameOver: false });
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
    expect(firstDrop).toMatchObject({ gameOver: false, score: 4800, movesLeft: 7 });
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
    expect(latePressure).toMatchObject({ movesLeft: 7, gameOver: false });
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
