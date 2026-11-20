import { EventEmitter } from 'node:events';
import type { Application } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame, type GameState, move } from '../game';
import type { Point } from './gestures';
import { mountGame } from './index';

const scene = vi.hoisted(() => ({
  root: { once: vi.fn() },
  toLocal: (point: Point) => point,
  hit: vi.fn(),
  draw: vi.fn<(state: GameState, levelStartScore: number, pressureLimit: number) => void>(),
  resize: vi.fn(), startMatch: vi.fn(), showMatch: vi.fn(), showMatchTail: vi.fn(), cancelMatch: vi.fn(),
  startMove: vi.fn(), showMove: vi.fn(), finishMove: vi.fn(),
  showInteraction: vi.fn(), topPosition: vi.fn(),
}));

vi.mock('./scene', () => ({ GameScene: class { constructor() { return scene; } }, loadArt: async () => new Map() }));
vi.mock('./matchEffect', () => ({ preloadScoreFont: async () => {} }));
vi.mock('../game', async importOriginal => {
  const game = await importOriginal<typeof import('../game')>();
  return { ...game, createGame: vi.fn(), move: vi.fn(game.move) };
});

const initial: GameState = {
  stacks: [['blue', 'red'], ['red', 'green', 'red', 'red', 'red'], ['yellow', 'blue']],
  score: 1390, level: 2, rank: 'Pastry Pupil', capacity: 6, nextLevelScore: 1500, movesLeft: 7, gameOver: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createGame).mockReturnValue(initial);
  scene.hit.mockImplementation(({ x }: Point) => {
    if (scene.draw.mock.lastCall?.[0].gameOver) return x === 300 ? 'restart' : null;
    return Math.floor(x / 100);
  });
});
afterEach(() => vi.restoreAllMocks());

async function setup(reduced = false) {
  let now = 0;
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const window = Object.assign(new EventTarget(), { matchMedia: () => ({ matches: reduced }) });
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: { defaultView: window }, style: {}, setPointerCapture: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 700 }),
  });
  const renderer = new EventEmitter();
  const ticker = { add: vi.fn<(tick: () => void) => void>(), remove: vi.fn() };
  const app = { canvas, renderer, ticker, stage: { addChild: vi.fn(), once: vi.fn() }, screen: { width: 400, height: 700 } };
  await mountGame(app as unknown as Application);

  const pointer = (type: string, clientX: number, pointerId = 1) => {
    const event = Object.assign(new Event(type), { button: 0, pointerId, clientX, clientY: 200 });
    (type === 'pointerdown' ? canvas : window).dispatchEvent(event);
  };
  const tap = (x: number) => { pointer('pointerdown', x); pointer('pointerup', x); };
  const match = () => { tap(50); tap(150); };
  const tick = (age: number) => { now = age; ticker.add.mock.lastCall![0](); };
  return { window, renderer, pointer, tap, match, tick };
}

describe('game view match playback', () => {
  it('plays a four-donut tap match, awards once and locks input until the new level reveals', async () => {
    const { match, tap, pointer, tick } = await setup();
    match();
    expect(scene.startMatch).toHaveBeenCalledWith(expect.objectContaining({ color: 'red', runLength: 4, points: 110 }));
    expect(scene.showMatch.mock.lastCall?.[0].phase).toBe('arrival');
    tap(250);
    tick(220);
    expect(scene.showMatch.mock.lastCall?.[0].phase).toBe('clear');
    tick(539);
    pointer('pointerdown', 250, 2);
    expect(move).toHaveBeenCalledTimes(1);
    expect(scene.draw).toHaveBeenCalledTimes(1);

    tick(540);
    expect(scene.showMatch.mock.lastCall?.[0].phase).toBe('resolved');
    const [resolved, levelStart] = scene.draw.mock.lastCall!;
    expect(resolved).toMatchObject({ score: 1500, level: 3 });
    expect(resolved.stacks).toHaveLength(4);
    expect(resolved.stacks[1].some((color, index, stack) => color === 'red' && stack[index + 1] === 'green')).toBe(true);
    expect(levelStart).toBe(1500);
    expect(scene.startMove).toHaveBeenCalledExactlyOnceWith(
      expect.arrayContaining([expect.objectContaining({ stack: 3, depth: 0 })]), 540, false,
    );
    pointer('pointerup', 150, 2);
    expect(move).toHaveBeenCalledTimes(1);
    tap(350);
    tap(50);
    expect(move).toHaveBeenCalledTimes(2);
  });

  it('plays the same run from a reduced-motion swipe and reveals it in 230 ms', async () => {
    const { pointer, tick } = await setup(true);
    pointer('pointerdown', 50);
    pointer('pointermove', 150);
    pointer('pointerup', 150);
    expect(scene.startMatch).toHaveBeenCalledOnce();
    expect(scene.startMatch).toHaveBeenCalledWith(expect.objectContaining({ runLength: 4, points: 110, reduced: true }));
    expect(scene.showMatch.mock.lastCall?.[0].phase).toBe('clear');
    tick(229);
    expect(scene.draw).toHaveBeenCalledTimes(1);
    tick(230);
    expect(scene.draw.mock.lastCall?.[0].score).toBe(1500);
    expect(move).toHaveBeenCalledOnce();
  });

  it('keeps a move ordinary when the matching colors below the top are covered', async () => {
    vi.mocked(createGame).mockReturnValueOnce({
      ...initial, stacks: [initial.stacks[0], ['red', 'red', 'green', 'red'], initial.stacks[2]],
    });
    const { match } = await setup();
    match();
    expect(scene.startMatch).not.toHaveBeenCalled();
    expect(scene.draw.mock.lastCall?.[0]).toMatchObject({ score: initial.score, movesLeft: 6 });
    expect(scene.startMove).toHaveBeenCalledWith([], 0, false, expect.objectContaining({ pressure: undefined }));
  });

  it('starts pressure playback on the triggering transfer and accepts the next move before it finishes', async () => {
    vi.mocked(createGame).mockReturnValueOnce({ ...initial, movesLeft: 1 });
    const { pointer, tap, tick } = await setup();
    pointer('pointerdown', 50);
    expect(scene.showInteraction.mock.lastCall?.[0].pressedStack).toBe(0);
    pointer('pointermove', 250);
    pointer('pointerup', 250);
    expect(scene.startMove).toHaveBeenCalledWith(
      [expect.objectContaining({ stack: 0, depth: 0 })], 0, false,
      expect.objectContaining({ to: 2, pressure: { movesLeft: 7, limit: 1 } }),
    );
    tick(50);
    scene.finishMove.mockClear();
    tap(250);
    expect(scene.finishMove).toHaveBeenCalledOnce();
    tap(150);
    expect(move).toHaveBeenCalledTimes(2);
    expect(scene.startMatch).toHaveBeenCalledOnce();
  });

  it.each(['resize', 'blur'])('settles the committed board once if interrupted by %s', async interruption => {
    const { match, tick, window, renderer } = await setup();
    match();
    tick(300);
    if (interruption === 'resize') renderer.emit('resize');
    else window.dispatchEvent(new Event('blur'));
    expect(scene.cancelMatch).toHaveBeenCalledTimes(2);
    expect(scene.draw.mock.lastCall?.[0]).toMatchObject({ score: 1500, level: 3 });
    tick(900);
    expect(scene.draw).toHaveBeenCalledTimes(2);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it('ignores a canceled swipe and restarts after revealing a settled game over', async () => {
    const { pointer, match, tap, tick } = await setup(true);
    pointer('pointerdown', 50);
    pointer('pointermove', 150);
    pointer('pointercancel', 150);
    pointer('pointerup', 150);
    expect(move).not.toHaveBeenCalled();

    vi.mocked(move).mockReturnValueOnce({ ...initial, score: 1500, gameOver: true });
    match();
    expect(scene.showMatch.mock.lastCall?.[0].phase).toBe('clear');
    tap(300);
    expect(createGame).toHaveBeenCalledTimes(1);
    tick(230);
    expect(scene.draw.mock.lastCall?.[0].gameOver).toBe(true);
    tap(300);
    expect(createGame).toHaveBeenCalledTimes(2);
    expect(scene.draw.mock.lastCall?.[0]).toBe(initial);
    expect(scene.cancelMatch).toHaveBeenCalledTimes(2);
  });
});
