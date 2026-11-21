import { EventEmitter } from 'node:events';
import type { Application } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame, type DoughInsert, type GameState, move } from '../game';
import type { Point } from './gestures';
import { mountGame } from './index';
import { refillDuration, refillPlan } from './movePlayback';
import type { ScoreDisplay } from './scoreBar';

const scene = vi.hoisted(() => ({
  root: { once: vi.fn() },
  toLocal: (point: Point) => point,
  hit: vi.fn(),
  draw: vi.fn<(state: GameState, pressureLimit: number) => void>(),
  drawScore: vi.fn<(display: ScoreDisplay) => void>(),
  creditScore: vi.fn(), reachScoreGoal: vi.fn(), startLevelCelebration: vi.fn(),
  showScoreEffects: vi.fn(), cancelScoreEffects: vi.fn(),
  resize: vi.fn(), startMatch: vi.fn(), showMatch: vi.fn(), showMatchTail: vi.fn(), cancelMatch: vi.fn(),
  startMove: vi.fn(), showMove: vi.fn(), finishMove: vi.fn(), moveAnimating: false,
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
  let refillEnds = 0;
  scene.moveAnimating = false;
  scene.startMove.mockImplementation((inserts: readonly DoughInsert[], started: number, reduced: boolean) => {
    const { stacks } = scene.draw.mock.lastCall![0];
    const duration = refillDuration(refillPlan(stacks.map(stack => stack.length), inserts).duration, reduced);
    refillEnds = started + duration;
    scene.moveAnimating = duration > 0;
  });
  scene.showMove.mockImplementation((now: number) => {
    if (now >= refillEnds) scene.moveAnimating = false;
  });
  scene.finishMove.mockImplementation(() => { scene.moveAnimating = false; });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const motion = { matches: reduced };
  const window = Object.assign(new EventTarget(), { matchMedia: () => motion });
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: { defaultView: window }, style: {}, setPointerCapture: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 700 }),
  });
  const renderer = new EventEmitter();
  const ticker = { add: vi.fn<(tick: () => void) => void>(), remove: vi.fn() };
  const app = { canvas, renderer, ticker, stage: { addChild: vi.fn(), once: vi.fn() }, screen: { width: 400, height: 700 } };
  await mountGame(app as unknown as Application);

  const pointer = (type: string, clientX: number, pointerId = 1, pointerType = 'mouse', buttons = 0) => {
    const event = Object.assign(new Event(type), { button: 0, buttons, pointerId, pointerType, clientX, clientY: 200 });
    (['pointerdown', 'pointerleave', 'lostpointercapture'].includes(type) ? canvas : window).dispatchEvent(event);
  };
  const tap = (x: number) => { pointer('pointerdown', x); pointer('pointerup', x); };
  const match = () => { tap(50); tap(150); };
  const tick = (age: number) => { now = age; ticker.add.mock.lastCall![0](); };
  return { window, renderer, pointer, tap, match, tick, motion, get refillEnds() { return refillEnds; } };
}

describe('game view match playback', () => {
  it('guides idle mouse hover and clears on the source, offboard, canvas leave, blur, resize and explicit cancel', async () => {
    vi.mocked(createGame).mockReturnValueOnce({ ...initial, stacks: [...initial.stacks.slice(0, 2), Array<string>(6).fill('blue')] });
    scene.hit.mockImplementation(({ x }: Point) => x > 400 ? 'outside' : x === 190 ? null : Math.floor(x / 100));
    const { pointer, tap, window, renderer } = await setup();
    const last = () => scene.showInteraction.mock.lastCall!;
    const preview = () => last()[1];
    const hover = (x: number) => pointer('pointermove', x);
    hover(150);
    expect(preview()).toBeNull();
    tap(50);
    hover(150);
    expect(preview()).toEqual({ point: { x: 150, y: 200 }, destination: 1, blocked: false });
    hover(190);
    expect(preview()).toEqual({ point: { x: 190, y: 200 }, destination: null, blocked: false });
    hover(250);
    expect(preview()).toMatchObject({ destination: 2, blocked: true });
    pointer('pointermove', 250, 1, 'mouse', 2);
    expect(preview()).toBeNull();
    hover(50);
    expect(preview()).toBeNull();
    hover(150);
    expect(preview()).not.toBeNull();
    hover(450);
    expect(preview()).toBeNull();
    hover(150);
    pointer('pointerleave', 450);
    expect(preview()).toBeNull();
    expect(last()[0].source).toBe(0);
    hover(150);
    window.dispatchEvent(new Event('blur'));
    expect(preview()).toBeNull();
    hover(150);
    tap(50);
    expect(preview()).toBeNull();
    expect(last()[0].source).toBeNull();
    tap(50);
    hover(150);
    expect(preview()).not.toBeNull();
    renderer.emit('resize');
    expect(preview()).toBeNull();
    expect(last()[0].source).toBeNull();
    expect(move).not.toHaveBeenCalled();
  });

  it('hides the held touch arrow on release, pointer cancellation and lost capture', async () => {
    scene.hit.mockImplementation(({ x }: Point) => x > 400 ? 'outside' : Math.floor(x / 100));
    const { pointer } = await setup(true);
    const touch = (type: string, x: number) => pointer(type, x, 1, 'touch');
    const last = () => scene.showInteraction.mock.lastCall!;
    touch('pointerdown', 50);
    touch('pointerup', 50);
    expect(last()[0].source).toBe(0);
    expect(last()[1]).toBeNull();
    for (const event of ['pointerup', 'pointercancel', 'lostpointercapture']) {
      touch('pointerdown', 50);
      touch('pointermove', 55);
      expect(last()[1]).toBeNull();
      touch('pointermove', 150);
      expect(last()[1]).toMatchObject({ destination: 1 });
      touch(event, 450);
      expect(last()[1]).toBeNull();
      expect(last()[0].source).toBe(0);
    }
    expect(move).not.toHaveBeenCalled();
  });

  it('keeps a touch tap pressed through 11 CSS pixels even if release hits an adjacent stack', async () => {
    scene.hit.mockImplementation(({ x }: Point) => x < 100 ? 0 : x <= 150 ? 1 : 2);
    const { pointer } = await setup();
    pointer('pointerdown', 50, 1, 'touch');
    pointer('pointerup', 50, 1, 'touch');
    pointer('pointerdown', 150, 1, 'touch');
    pointer('pointermove', 160, 1, 'touch');
    expect(scene.showInteraction.mock.lastCall?.[0].pressedStack).toBe(1);
    pointer('pointerup', 161, 1, 'touch');
    expect(move).toHaveBeenCalledTimes(1);
    expect(vi.mocked(move).mock.lastCall?.slice(1, 3)).toEqual([0, 1]);
  });

  it('uses the same touch snap at preview and release while ignoring another pointer', async () => {
    scene.hit.mockImplementation(({ x }: Point, mode: string) => {
      if (x === 132) return mode === 'swipe' ? 1 : null;
      return Math.floor(x / 100);
    });
    const { pointer } = await setup();
    pointer('pointerdown', 50, 1, 'touch');
    pointer('pointerdown', 250, 2, 'touch');
    pointer('pointerup', 250, 2, 'touch');
    expect(move).not.toHaveBeenCalled();
    pointer('pointermove', 132, 1, 'touch');
    expect(scene.showInteraction.mock.lastCall?.[0].destination).toBe(1);
    expect(scene.showInteraction.mock.lastCall?.[1]).toMatchObject({ destination: 1, blocked: false });
    pointer('pointermove', 250, 2);
    expect(scene.showInteraction.mock.lastCall?.[1]).toMatchObject({ destination: 1 });
    pointer('pointerup', 132, 1, 'touch');
    expect(vi.mocked(move).mock.lastCall?.slice(1, 3)).toEqual([0, 1]);
    expect(scene.hit.mock.calls.filter(([point]) => point.x === 132).map(([, mode]) => mode)).toEqual(['swipe', 'swipe']);
  });

  it('plays a four-donut tap match and locks input only until the board reveals', async () => {
    const { match, tap, pointer, tick } = await setup();
    match();
    expect(scene.startMatch).toHaveBeenCalledWith(expect.objectContaining({ color: 'red', runLength: 4, points: 165 }));
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
    const [resolved] = scene.draw.mock.lastCall!;
    expect(resolved).toMatchObject({ score: 1555, level: 3 });
    expect(resolved.stacks).toHaveLength(4);
    expect(resolved.stacks[1].some((color, index, stack) => color === 'red' && stack[index + 1] === 'green')).toBe(true);
    expect(scene.drawScore.mock.lastCall?.[0]).toMatchObject({ score: 1390, level: 2, nextLevelScore: 1500 });
    expect(scene.startMove).toHaveBeenCalledExactlyOnceWith(
      expect.arrayContaining([expect.objectContaining({ stack: 3, depth: 0 })]), 540, false,
    );
    pointer('pointerup', 150, 2);
    expect(move).toHaveBeenCalledTimes(1);
    tap(350);
    tap(50);
    expect(move).toHaveBeenCalledTimes(2);
  });

  it('passes the full award and streak from consecutive matches, then resets the streak on a miss', async () => {
    vi.mocked(createGame).mockReturnValueOnce({
      ...initial, score: 0, nextLevelScore: 1500,
      stacks: [['blue', 'red'], ['green', 'red', 'red'], ['yellow', 'blue'], ['gold', 'blue', 'blue']],
    });
    const { match, tap, tick } = await setup();
    match();
    expect(scene.startMatch).toHaveBeenLastCalledWith(expect.objectContaining({ points: 110, combo: 1 }));
    tick(540);
    tap(250);
    tap(350);
    expect(scene.startMatch).toHaveBeenLastCalledWith(expect.objectContaining({ points: 121, combo: 2 }));
    tick(1080);
    expect(scene.draw.mock.lastCall?.[0]).toMatchObject({ score: 231, combo: 2 });

    tap(150);
    tap(350);
    expect(scene.startMatch).toHaveBeenCalledTimes(2);
    expect(scene.draw.mock.lastCall?.[0]).toMatchObject({ score: 231, combo: 0 });
  });

  it('credits the old bar at impact, then reveals the new rank and stack only after refills settle', async () => {
    const game = await setup();
    game.match();
    game.tick(540);
    expect(game.refillEnds).toBeGreaterThan(1005);
    game.tick(849);
    expect(scene.drawScore.mock.lastCall?.[0].score).toBe(1390);
    expect(scene.creditScore).not.toHaveBeenCalled();

    game.tick(850);
    expect(scene.drawScore.mock.lastCall?.[0]).toMatchObject({ score: 1555, level: 2, nextLevelScore: 1500 });
    expect(scene.creditScore).toHaveBeenCalledExactlyOnceWith(850, false);
    expect(scene.reachScoreGoal).toHaveBeenCalledExactlyOnceWith(850, false);
    game.tick(game.refillEnds - 1);
    expect(scene.startLevelCelebration).not.toHaveBeenCalled();

    game.tick(game.refillEnds);
    expect(scene.drawScore.mock.lastCall?.[0]).toEqual({
      score: 1555, level: 3, rank: 'Fryer Fighter', nextLevelScore: 2500, levelStartScore: 1500,
    });
    expect(scene.startLevelCelebration).toHaveBeenCalledExactlyOnceWith({
      level: 3, rank: 'Fryer Fighter', upgrade: { kind: 'stack', firstNewStack: 3, stackCount: 4 },
    }, game.refillEnds, false);
    game.tap(350);
    game.tap(50);
    expect(move).toHaveBeenCalledTimes(2);
  });

  it('keeps both credits ordered when a quick reduced-motion match resolves before the prior flight', async () => {
    const board = { ...initial, nextLevelScore: 2500 };
    vi.mocked(createGame).mockReturnValueOnce(board);
    vi.mocked(move).mockReturnValueOnce({ ...board, score: 1555, combo: 1 })
      .mockReturnValueOnce({ ...board, score: 1736, combo: 2 });
    const { match, tick, motion } = await setup();
    match();
    tick(540);
    motion.matches = true;
    match();
    tick(770);
    expect(scene.draw.mock.lastCall?.[0].score).toBe(1736);
    expect(scene.drawScore.mock.calls.map(([display]) => display.score)).toEqual([1390]);
    tick(850);
    expect(scene.drawScore.mock.lastCall?.[0].score).toBe(1555);
    tick(905);
    expect(scene.drawScore.mock.calls.map(([display]) => display.score)).toEqual([1390, 1555, 1736]);
    expect(scene.creditScore.mock.calls).toEqual([[850, false], [905, true]]);
    expect(scene.startLevelCelebration).not.toHaveBeenCalled();
    expect(move).toHaveBeenCalledTimes(2);
  });

  it('plays the same run from a reduced-motion swipe and reveals it in 230 ms', async () => {
    const { pointer, tick } = await setup(true);
    pointer('pointerdown', 50);
    pointer('pointermove', 150);
    pointer('pointerup', 150);
    expect(scene.startMatch).toHaveBeenCalledOnce();
    expect(scene.startMatch).toHaveBeenCalledWith(expect.objectContaining({ runLength: 4, points: 165, reduced: true }));
    expect(scene.showMatch.mock.lastCall?.[0].phase).toBe('clear');
    tick(229);
    expect(scene.draw).toHaveBeenCalledTimes(1);
    tick(230);
    expect(scene.draw.mock.lastCall?.[0].score).toBe(1555);
    expect(scene.drawScore.mock.lastCall?.[0]).toMatchObject({ score: 1555, level: 2 });
    expect(scene.creditScore).toHaveBeenCalledExactlyOnceWith(230, true);
    expect(scene.reachScoreGoal).toHaveBeenCalledExactlyOnceWith(230, true);
    tick(384);
    expect(scene.startLevelCelebration).not.toHaveBeenCalled();
    tick(385);
    expect(scene.startLevelCelebration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ level: 3 }), 385, true);
    expect(move).toHaveBeenCalledOnce();
  });

  it('attributes a capacity upgrade to the committed slot count', async () => {
    vi.mocked(createGame).mockReturnValueOnce({
      ...initial, score: 480, level: 1, capacity: 5, nextLevelScore: 500,
      stacks: [['blue', 'red'], ['green', 'red', 'red'], ['yellow', 'blue']],
    });
    const { match, tick } = await setup(true);
    match();
    tick(230);
    tick(385);
    expect(scene.startLevelCelebration).toHaveBeenCalledExactlyOnceWith({
      level: 2, rank: 'Pastry Pupil', upgrade: { kind: 'slots', previousCapacity: 5, capacity: 6 },
    }, 385, true);
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

  it.each([['resize', 300], ['blur', 300], ['resize', 700], ['blur', 700]] as const)(
    'settles the committed board and score if interrupted by %s at %i ms', async (interruption, time) => {
      const { match, tick, window, renderer } = await setup();
      match();
      tick(time);
      if (interruption === 'resize') renderer.emit('resize');
      else window.dispatchEvent(new Event('blur'));
      expect(scene.cancelMatch).toHaveBeenCalledTimes(2);
      expect(scene.draw.mock.lastCall?.[0]).toMatchObject({ score: 1555, level: 3 });
      expect(scene.drawScore.mock.lastCall?.[0]).toMatchObject({ score: 1555, level: 3, levelStartScore: 1500 });
      tick(1800);
      expect(scene.creditScore).not.toHaveBeenCalled();
      expect(scene.startLevelCelebration).not.toHaveBeenCalled();
      expect(move).toHaveBeenCalledTimes(1);
    },
  );

  it('ignores a canceled swipe and restarts after revealing a settled game over', async () => {
    const { pointer, match, tap, tick } = await setup(true);
    pointer('pointerdown', 50);
    pointer('pointermove', 150);
    pointer('pointercancel', 150);
    pointer('pointerup', 150);
    expect(move).not.toHaveBeenCalled();

    vi.mocked(move).mockReturnValueOnce({ ...initial, score: 1555, gameOver: true });
    match();
    expect(scene.showMatch.mock.lastCall?.[0].phase).toBe('clear');
    tap(300);
    expect(createGame).toHaveBeenCalledTimes(1);
    tick(230);
    expect(scene.draw.mock.lastCall?.[0].gameOver).toBe(true);
    expect(scene.drawScore.mock.lastCall?.[0].score).toBe(1555);
    tap(300);
    expect(createGame).toHaveBeenCalledTimes(2);
    expect(scene.draw.mock.lastCall?.[0]).toBe(initial);
    expect(scene.drawScore.mock.lastCall?.[0].score).toBe(1390);
    expect(scene.cancelMatch).toHaveBeenCalledTimes(3);
  });
});
