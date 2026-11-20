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
  resize: vi.fn(), startMatch: vi.fn(), showMatch: vi.fn(), showAward: vi.fn(), cancelMatch: vi.fn(),
  showInteraction: vi.fn(), topPosition: vi.fn(),
}));

vi.mock('./scene', () => ({ GameScene: class { constructor() { return scene; } }, loadArt: async () => new Map() }));
vi.mock('./matchEffect', () => ({ preloadScoreFont: async () => {} }));
vi.mock('../game', async importOriginal => {
  const game = await importOriginal<typeof import('../game')>();
  return { ...game, createGame: vi.fn(), move: vi.fn(game.move) };
});

const initial: GameState = {
  stacks: [['blue', 'red'], ['green', 'red', 'red'], ['yellow', 'blue']],
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
  it('applies the actual level multiplier once, locks input and reveals the new layout at 540 ms', async () => {
    const { match, tap, pointer, tick } = await setup();
    match();
    expect(scene.startMatch).toHaveBeenCalledWith(expect.objectContaining({ color: 'red', points: 110 }));
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
    expect(levelStart).toBe(1500);
    pointer('pointerup', 150, 2);
    expect(move).toHaveBeenCalledTimes(1);
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
