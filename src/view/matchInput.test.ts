import { EventEmitter } from 'node:events';
import { createBrowserPersistence } from '@playbridge/web';
import type { Application } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame, type DoughInsert, findSetupHint, type GameState, JOKER, move } from '../game';
import { BrowserQuality } from '../performance/browserQuality';
import type { FriendScore, FriendsScores } from '../platform/friendsScores';
import { browserScoreStorage, type CompletedResults, PERSONAL_SCORES_KEY, PersonalScores } from '../platform/personalScores';
import { GAME_OVER_CUE_MS, GAME_OVER_HOLD_MS, GAME_OVER_RECORD_LIMIT_MS } from './gameOverPresentation';
import type { Point, StackGestures } from './gestures';
import { mountGame } from './index';
import { layoutStacks, stackHit, stackTarget } from './layout';
import { refillDuration, refillPlan } from './movePlayback';
import type { ResultsView } from './resultsSession';
import type { ScoreDisplay } from './scoreBar';
import { STACK_UNLOCK_MS } from './stackUnlock';

const scene = vi.hoisted(() => ({
  root: { once: vi.fn() },
  toLocal: (point: Point) => point,
  hit: vi.fn(),
  draw: vi.fn<(state: GameState) => void>(),
  showResults: vi.fn<(view: ResultsView | null) => void>(),
  showGameOverCue: vi.fn<(progress: number | null, reduced: boolean) => void>(),
  drawScore: vi.fn<(display: ScoreDisplay) => void>(),
  creditScore: vi.fn(), reachScoreGoal: vi.fn(), startLevelCelebration: vi.fn(),
  showScoreEffects: vi.fn(), cancelScoreEffects: vi.fn(),
  resize: vi.fn(), startMatch: vi.fn(), showMatch: vi.fn(), showMatchTail: vi.fn(), cancelMatch: vi.fn(),
  startMove: vi.fn(), showMove: vi.fn(), finishMove: vi.fn(), moveAnimating: false,
  startStackUnlock: vi.fn<(state: GameState, inserts: readonly DoughInsert[], now: number, reduced: boolean) => void>(),
  finishStackUnlock: vi.fn(), stackUnlockAnimating: false,
  selectionAnimating: false, effectsAnimating: false,
  warmup: function* () {}, releasePreparedText: vi.fn(),
  showInteraction: vi.fn(), showJoker: vi.fn(), topPosition: vi.fn(),
  setHintAvailable: vi.fn(), showHint: vi.fn(), clearHint: vi.fn(),
}));

vi.mock('./scene', () => ({ GameScene: class { constructor() { return scene; } }, loadArt: async () => new Map() }));
vi.mock('./matchEffect', () => ({ preloadScoreFont: async () => {} }));
vi.mock('../game', async importOriginal => {
  const game = await importOriginal<typeof import('../game')>();
  return { ...game, createGame: vi.fn(), move: vi.fn(game.move), findSetupHint: vi.fn(game.findSetupHint) };
});

const initial: GameState = {
  stacks: [['blue', 'red'], ['red', 'green', 'red', 'red', 'red'], ['yellow', 'blue']],
  score: 1390, level: 2, rank: 'Pastry Pupil', capacity: 6, nextLevelScore: 1500, movesLeft: 7, gameOver: false,
};
const getFriendsScores = vi.fn<() => FriendsScores | null>();
const settleResults = () => new Promise<void>(resolve => setImmediate(resolve));

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createGame).mockReturnValue(initial);
  getFriendsScores.mockReturnValue(null);
  scene.hit.mockImplementation(({ x }: Point, _mode: string, duringUnlock: boolean) => {
    const last = scene.draw.mock.lastCall?.[0];
    if (last?.gameOver) return x === 300 ? 'restart' : null;
    const stack = Math.floor(x / 100);
    if (scene.stackUnlockAnimating && (!duringUnlock || stack >= (last?.stacks.length ?? 0))) return null;
    return x === 398 ? 'hint' : stack;
  });
});
afterEach(() => vi.restoreAllMocks());

async function setup(reduced = false, search = '', devicePixelRatio = 1, scores?: Pick<PersonalScores, 'record'>) {
  let now = 0;
  let refillEnds = 0;
  let unlockEnds = 0;
  scene.moveAnimating = false;
  scene.stackUnlockAnimating = false;
  scene.selectionAnimating = false;
  scene.effectsAnimating = false;
  scene.showInteraction.mockImplementation((gestures: StackGestures, _preview, _feedback, _now, reduced: boolean) => {
    scene.selectionAnimating = gestures.source !== null && !reduced;
  });
  const startRefills = ({ stacks }: GameState, inserts: readonly DoughInsert[], started: number, reduced: boolean) => {
    const duration = refillDuration(refillPlan(stacks.map(stack => stack.length), inserts).duration, reduced);
    refillEnds = started + duration;
    scene.moveAnimating = duration > 0;
  };
  scene.startMove.mockImplementation((inserts: readonly DoughInsert[], started: number, reduced: boolean) =>
    startRefills(scene.draw.mock.lastCall![0], inserts, started, reduced));
  scene.startStackUnlock.mockImplementation((state, inserts, now, reduced) => {
    unlockEnds = now + (reduced ? 0 : STACK_UNLOCK_MS);
    scene.stackUnlockAnimating = !reduced;
    startRefills(state, inserts, now, reduced);
  });
  scene.showMove.mockImplementation((now: number) => {
    if (now >= refillEnds) scene.moveAnimating = false;
    if (now >= unlockEnds) scene.stackUnlockAnimating = false;
  });
  scene.finishMove.mockImplementation(() => { scene.moveAnimating = false; });
  scene.finishStackUnlock.mockImplementation(() => { scene.stackUnlockAnimating = false; });
  vi.spyOn(performance, 'now').mockImplementation(() => now);
  const motion = Object.assign(new EventTarget(), { matches: reduced });
  const localStorage = { getItem: vi.fn((): string | null => null), setItem: vi.fn() };
  const sessionStorage = { getItem: vi.fn((): string | null => null), setItem: vi.fn() };
  const callbacks = new Map<number, FrameRequestCallback>();
  const timers = new Map<number, { callback: () => void; at: number }>();
  let requestId = 0;
  let timerId = 0;
  let pause = () => {};
  const window = Object.assign(new EventTarget(), {
    matchMedia: (query: string) => query.includes('prefers-reduced-motion') ? motion : new EventTarget(),
    innerWidth: 400, innerHeight: 700, devicePixelRatio, location: { search }, localStorage, sessionStorage,
    requestAnimationFrame(callback: FrameRequestCallback) {
      callbacks.set(++requestId, callback);
      return requestId;
    },
    cancelAnimationFrame: (id: number) => { callbacks.delete(id); },
    setTimeout(callback: () => void, delay = 0) {
      timers.set(++timerId, { callback, at: now + delay });
      return timerId;
    },
    clearTimeout: (id: number) => { timers.delete(id); },
  });
  const document = Object.assign(new EventTarget(), { defaultView: window, hidden: false });
  const canvas = Object.assign(new EventTarget(), {
    ownerDocument: document, style: {}, setPointerCapture: vi.fn(),
    getBoundingClientRect: () => ({ left: 0, top: 0, width: 400, height: 700 }),
  });
  const screen = { width: window.innerWidth, height: window.innerHeight };
  const rendererEvents = new EventEmitter();
  const renderer = Object.assign(rendererEvents, {
    resolution: Math.min(devicePixelRatio, 2),
    resize(width: number, height: number, resolution: number) {
      this.resolution = resolution;
      Object.assign(screen, { width, height });
      rendererEvents.emit('resize');
    },
  });
  const app = { canvas, renderer, render: vi.fn(), stage: { addChild: vi.fn(), once: vi.fn() }, screen };
  const jokerPlaytest = new URLSearchParams(search).get('playtest') === 'joker';
  const personalScores = scores ?? new PersonalScores(createBrowserPersistence(
    jokerPlaytest ? sessionStorage : browserScoreStorage(() => localStorage, 'web')));
  const quality = new BrowserQuality(window as unknown as Window);
  await mountGame(app as unknown as Application, {
    jokerPlaytest, personalScores, getFriendsScores, quality,
    onPause(callback) { pause = callback; return () => { pause = () => {}; }; },
  });

  const pointer = (type: string, clientX: number, pointerId = 1, pointerType = 'mouse', buttons = 0, clientY = 200) => {
    const event = Object.assign(new Event(type), { button: 0, buttons, pointerId, pointerType, clientX, clientY });
    (['pointerdown', 'pointerleave', 'lostpointercapture'].includes(type) ? canvas : window).dispatchEvent(event);
  };
  const tap = (x: number) => { pointer('pointerdown', x); pointer('pointerup', x); };
  const match = () => { tap(50); tap(150); };
  const tick = (age: number) => {
    now = age;
    for (const [id, { callback, at }] of [...timers]) {
      if (at > now || !timers.delete(id)) continue;
      callback();
    }
    const current = [...callbacks.values()];
    callbacks.clear();
    for (const frame of current) frame(now);
  };
  const resizeViewport = (width: number, height: number) => {
    Object.assign(window, { innerWidth: width, innerHeight: height });
    window.dispatchEvent(new Event('resize'));
    tick(now);
  };
  return { window, document, renderer, render: app.render, resizeViewport, pointer, tap, match, tick,
    motion, localStorage, sessionStorage, suspendFromHost: () => pause(),
    get refillEnds() { return refillEnds; }, get unlockEnds() { return unlockEnds; } };
}

describe('game view match playback', () => {
  const hintState: GameState = {
    ...initial, movesLeft: 3, capacity: 5,
    stacks: [['green', 'red', 'blue', 'green', 'green'], ['blue', 'red', 'green', 'red'], ['blue', 'blue', 'blue', 'red']],
  };

  it('stays idle, wakes for selection and focus, and suspends while hidden or paused by the host', async () => {
    const { tap, tick, render, window, document, suspendFromHost } = await setup();
    tick(16);
    expect(render).toHaveBeenCalledTimes(1);
    tap(50);
    tick(32);
    tick(48);
    expect(render).toHaveBeenCalledTimes(3);
    document.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    tick(500);
    expect(render).toHaveBeenCalledTimes(3);

    document.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    tick(516);
    expect(render).toHaveBeenCalledTimes(4);
    suspendFromHost();
    tick(1000);
    expect(render).toHaveBeenCalledTimes(4);
    window.dispatchEvent(new Event('focus'));
    tick(1016);
    expect(render).toHaveBeenCalledTimes(5);

    tap(50);
    tick(1032);
    const settled = render.mock.calls.length;
    tick(1050);
    expect(render).toHaveBeenCalledTimes(settled);
  });

  it('defers a sustained slow-frame decision until selection settles without relaying a layout resize', async () => {
    const { tick, tap, renderer, localStorage, resizeViewport, pointer } = await setup(false, '', 2);
    tap(50);
    for (let frame = 1; frame <= 322; frame++) tick(frame * 25);
    expect(renderer.resolution).toBe(2);
    expect(localStorage.setItem).not.toHaveBeenCalled();

    tap(50);
    tick(8075);
    expect(renderer.resolution).toBe(1.5);
    expect(scene.resize).toHaveBeenCalledOnce();
    expect(localStorage.setItem).toHaveBeenCalledExactlyOnceWith(
      'master-of-donuts-2-reborn.render-quality.v1', expect.stringContaining('"tier":1.5'));

    pointer('pointerdown', 50, 1, 'touch');
    pointer('pointerup', 50, 1, 'touch');
    resizeViewport(400, 643);
    pointer('pointerdown', 250, 1, 'touch');
    pointer('pointerup', 250, 1, 'touch');
    expect(vi.mocked(move).mock.lastCall?.slice(1, 3)).toEqual([0, 2]);
  });

  it('searches only on a completed Hint press, caches the verified transfer and spends no move', async () => {
    vi.mocked(createGame).mockReturnValueOnce(hintState);
    const before = structuredClone(hintState);
    const { pointer, tap, tick, renderer, window } = await setup();
    expect(scene.setHintAvailable).toHaveBeenLastCalledWith(true);
    tick(16);
    pointer('pointerdown', 398, 1, 'touch');
    expect(findSetupHint).not.toHaveBeenCalled();
    pointer('pointerup', 150, 1, 'touch');
    expect(findSetupHint).not.toHaveBeenCalled();

    tap(398);
    expect(scene.showHint).toHaveBeenLastCalledWith({ from: 1, to: 2 });
    expect(findSetupHint).toHaveBeenCalledExactlyOnceWith(hintState);
    expect(move).not.toHaveBeenCalled();
    expect(hintState).toEqual(before);
    for (const dismiss of [() => tap(150), () => renderer.emit('resize'), () => window.dispatchEvent(new Event('blur'))]) {
      scene.clearHint.mockClear();
      dismiss();
      expect(scene.clearHint).toHaveBeenCalled();
      tap(398);
      expect(scene.showHint).toHaveBeenLastCalledWith({ from: 1, to: 2 });
    }
    expect(findSetupHint).toHaveBeenCalledTimes(1);
    tap(150);
    tap(250);
    expect(move).toHaveBeenCalledTimes(1);
    const after = scene.draw.mock.lastCall![0];
    expect(after.movesLeft).toBe(2);
    tap(398);
    expect(findSetupHint).toHaveBeenCalledTimes(2);
    expect(findSetupHint).toHaveBeenLastCalledWith(after);
  });

  it('caches a null hint and dismisses its message without spending pressure', async () => {
    const state = { ...hintState,
      stacks: [['red', 'green', 'red', 'green', 'green'], ['red', 'blue', 'red', 'blue'], ['green', 'blue', 'blue', 'red']] };
    vi.mocked(createGame).mockReturnValueOnce(state);
    const { tap, tick, render } = await setup(true);
    tap(398);
    tap(398);
    expect(findSetupHint).toHaveBeenCalledExactlyOnceWith(state);
    expect(scene.showHint).toHaveBeenLastCalledWith(null);
    scene.clearHint.mockClear();
    tick(16);
    const showing = render.mock.calls.length;
    tick(1499);
    expect(scene.clearHint).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(showing);
    tick(1500);
    expect(scene.clearHint).toHaveBeenCalledOnce();
    expect(render).toHaveBeenCalledTimes(showing + 1);
    expect(move).not.toHaveBeenCalled();
    expect(state.movesLeft).toBe(3);
  });

  it('rejects Hint while playback is active and on a board with an immediate match', async () => {
    vi.mocked(createGame).mockReturnValueOnce(hintState);
    const { tap, tick, window } = await setup();
    scene.moveAnimating = true;
    tap(398);
    expect(scene.setHintAvailable).toHaveBeenLastCalledWith(false);
    window.dispatchEvent(new Event('focus'));
    expect(findSetupHint).not.toHaveBeenCalled();
    tick(20);
    expect(scene.setHintAvailable).toHaveBeenLastCalledWith(true);
    const immediate = await setup();
    immediate.tap(398);
    expect(findSetupHint).not.toHaveBeenCalled();
  });
  it('plays the Joker fixture through the miss, morph, collect and score credit, then restarts the same fixture', async () => {
    const { tap, tick, localStorage, sessionStorage } = await setup(false, '?playtest=joker');
    const opening = scene.draw.mock.lastCall![0];
    expect(opening.stacks).toEqual([[JOKER], ['red', 'blue'], ['red', 'blue']]);
    tap(150);
    tap(50);
    expect(scene.draw.mock.lastCall?.[0]).toMatchObject({ stacks: [[JOKER, 'blue'], ['red'], ['red', 'blue']], movesLeft: 6 });
    expect(scene.startMatch).not.toHaveBeenCalled();
    tick(400);
    expect(scene.showJoker).toHaveBeenLastCalledWith(400, false);
    tap(250);
    tap(50);
    expect(scene.startMatch).toHaveBeenCalledWith(expect.objectContaining({ color: 'blue', jokerIndex: 0, points: 100 }));

    tick(620);
    expect(scene.showMatch.mock.lastCall?.[0]).toEqual({ phase: 'morph', progress: 0 });
    expect(scene.showJoker).toHaveBeenLastCalledWith(620, false);
    tap(150);
    tap(250);
    expect(move).toHaveBeenCalledTimes(2);
    tick(730);
    expect(scene.showMatch.mock.lastCall?.[0]).toEqual({ phase: 'clear', progress: 0 });
    expect(scene.drawScore.mock.lastCall?.[0].score).toBe(0);
    tick(1050);
    expect(scene.draw.mock.lastCall?.[0].stacks[0]).not.toContain(JOKER);
    tick(1359);
    expect(scene.creditScore).not.toHaveBeenCalled();
    tick(1360);
    expect(scene.creditScore).toHaveBeenCalledExactlyOnceWith(1360, false);
    expect(scene.drawScore.mock.lastCall?.[0].score).toBe(100);

    const resolved = scene.draw.mock.lastCall![0];
    vi.mocked(move).mockReturnValueOnce({ ...resolved, gameOver: true });
    tap(50);
    tap(150);
    tick(1370);
    await settleResults();
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(sessionStorage.setItem).toHaveBeenCalledTimes(1);
    tick(1370 + GAME_OVER_HOLD_MS);
    tick(1370 + GAME_OVER_HOLD_MS + GAME_OVER_CUE_MS);
    expect(getFriendsScores).not.toHaveBeenCalled();
    tap(300);
    expect(scene.draw.mock.lastCall?.[0]).toEqual(opening);
    expect(scene.draw.mock.lastCall?.[0]).not.toBe(opening);
  });

  it('settles a committed Joker match on resize during the morph', async () => {
    vi.mocked(createGame).mockReturnValueOnce({
      ...initial, score: 0, stacks: [[JOKER], ['blue', 'blue'], ['red']],
    });
    const { match, tick, renderer } = await setup();
    match();
    tick(275);
    expect(scene.showMatch.mock.lastCall?.[0].phase).toBe('morph');
    renderer.emit('resize');
    expect(scene.cancelMatch).toHaveBeenCalled();
    expect(scene.draw.mock.lastCall?.[0].stacks.flat()).not.toContain(JOKER);
    expect(scene.drawScore.mock.lastCall?.[0].score).toBe(110);
    tick(1000);
    expect(scene.creditScore).not.toHaveBeenCalled();
    expect(move).toHaveBeenCalledTimes(1);
  });

  it('keeps an idle selection through a height-only viewport change between touches', async () => {
    const { pointer, resizeViewport } = await setup();
    pointer('pointerdown', 50, 1, 'touch');
    pointer('pointerup', 50, 1, 'touch');
    resizeViewport(400, 643);
    pointer('pointerdown', 250, 1, 'touch');
    pointer('pointerup', 250, 1, 'touch');
    expect(move).toHaveBeenCalledTimes(1);
    expect(vi.mocked(move).mock.lastCall?.slice(1, 3)).toEqual([0, 2]);
  });

  it.each(['active touch', 'width change', 'large height change'])('cancels input on resize with %s', async scenario => {
    const { pointer, resizeViewport } = await setup();
    const touch = (type: string, x: number) => pointer(type, x, 1, 'touch');
    touch('pointerdown', 50);
    touch('pointerup', 50);
    if (scenario === 'active touch') touch('pointerdown', 250);
    resizeViewport(scenario === 'width change' ? 420 : 400, scenario === 'large height change' ? 580 : 643);
    expect(scene.showInteraction.mock.lastCall?.[0].source).toBeNull();
    if (scenario !== 'active touch') touch('pointerdown', 250);
    touch('pointerup', 250);
    expect(move).not.toHaveBeenCalled();
  });

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

  it.each([3, 4, 5, 6, 7, 8])('accepts two moving mouse clicks between every pair on a %i-stack board', async count => {
    const height = 540;
    const capacity = Math.min(10, count + 3);
    const { slots, donutHeight, step } = layoutStacks(height, count, capacity);
    const cells = slots.map(slot => ({ hit: stackHit(slot, capacity, donutHeight, step) }));
    scene.hit.mockImplementation((p, mode = 'exact') => stackTarget(cells, p, height, mode));
    for (let from = 0; from < count; from++) {
      for (let to = 0; to < count; to++) {
        if (from === to) continue;
        vi.mocked(createGame).mockReturnValueOnce({
          ...initial, capacity, stacks: Array.from({ length: count }, () => ['blue', 'green']),
        });
        const { pointer } = await setup(true);
        const clickAcrossCell = (index: number) => {
          const { x, y, width, height } = cells[index].hit;
          pointer('pointerdown', x + width * 0.25, 1, 'mouse', 1, y + height * 0.5);
          pointer('pointermove', x + width * 0.7, 1, 'mouse', 1, y + height * 0.55);
          pointer('pointerup', x + width * 0.75, 1, 'mouse', 0, y + height * 0.6);
        };
        vi.mocked(move).mockClear();
        clickAcrossCell(from);
        expect(scene.showInteraction.mock.lastCall?.[0].source).toBe(from);
        clickAcrossCell(to);
        expect(move).toHaveBeenCalledTimes(1);
        expect(vi.mocked(move).mock.lastCall?.slice(1, 3)).toEqual([from, to]);
      }
    }
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

  it.each([
    { label: '18.7px of same-stack drift', travel: [166, 168.7], expectedMove: [0, 1] },
    { label: '25.3px of same-stack drift', travel: [173.3, 175.3], expectedMove: [0, 1] },
    { label: 'an in-stack excursion', travel: [193, 151], expectedMove: [0, 1] },
    { label: 'a swipe that leaves the stack', travel: [183, 225, 250], expectedMove: [1, 2] },
    { label: 'a swipe that returns to its starting stack', travel: [225, 151], expectedMove: null },
  ])('handles a mouse press on a selected donut’s destination with $label', async ({ travel, expectedMove }) => {
    const { tap, pointer } = await setup();
    tap(50);
    pointer('pointerdown', 150, 1, 'mouse', 1);
    for (const x of travel.slice(0, -1)) pointer('pointermove', x, 1, 'mouse', 1);
    pointer('pointerup', travel.at(-1)!);

    if (expectedMove) {
      expect(move).toHaveBeenCalledTimes(1);
      expect(vi.mocked(move).mock.lastCall?.slice(1, 3)).toEqual(expectedMove);
    } else {
      expect(move).not.toHaveBeenCalled();
      expect(scene.showInteraction.mock.lastCall?.[0].source).toBe(0);
    }
  });

  it.each([
    { label: 'a near-left release', source: 337, down: 60.2, drift: 10.2, up: 9.8, expectedMove: [2, 0] },
    { label: 'a near-right press', source: 82, down: 391.5, drift: 387.3, up: 387.3, expectedMove: [0, 2] },
    { label: 'a release farther off-board', source: 337, down: 60.2, drift: 1, up: 0, expectedMove: null },
    { label: 'a press farther off-board', source: 82, down: 396, drift: 387.3, up: 387.3, expectedMove: null },
  ])('handles $label on a mouse destination click', async ({ source, down, drift, up, expectedMove }) => {
    scene.hit.mockImplementation(({ x }: Point) => {
      if (x < 12 || x >= 388) return 'outside';
      return x < 138 ? 0 : x < 262 ? 1 : 2;
    });
    const { tap, pointer } = await setup();
    tap(source);
    pointer('pointerdown', down, 1, 'mouse', 1);
    pointer('pointermove', drift, 1, 'mouse', 1);
    pointer('pointerup', up);

    if (expectedMove) {
      expect(move).toHaveBeenCalledTimes(1);
      expect(vi.mocked(move).mock.lastCall?.slice(1, 3)).toEqual(expectedMove);
    } else {
      expect(move).not.toHaveBeenCalled();
      expect(scene.showInteraction.mock.lastCall?.[0].source).toBe(source > 262 ? 2 : 0);
    }
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

  it('locks a four-donut tap match through reflow and accepts a move into the new index immediately afterward', async () => {
    const { match, tap, pointer, tick } = await setup();
    match();
    expect(scene.startMatch).toHaveBeenCalledWith(expect.objectContaining({ color: 'red', runLength: 4, points: 165 }));
    expect(scene.showMatch.mock.lastCall?.[0].phase).toBe('arrival');
    tick(220);
    expect(scene.showMatch.mock.lastCall?.[0].phase).toBe('clear');
    tick(539);
    pointer('pointerdown', 250, 2);
    expect(move).toHaveBeenCalledTimes(1);
    expect(scene.draw).toHaveBeenCalledTimes(1);

    tick(540);
    expect(scene.showMatch.mock.lastCall?.[0].phase).toBe('resolved');
    const [resolved, inserts, now, reduced] = scene.startStackUnlock.mock.lastCall!;
    expect(resolved).toMatchObject({ score: 1555, level: 3 });
    expect(resolved.stacks[3]).toHaveLength(Math.floor(resolved.capacity / 2));
    expect(new Set(resolved.stacks[3].slice(-2)).size).toBe(2);
    expect(resolved.stacks[1].some((color, index, stack) => color === 'red' && stack[index + 1] === 'green')).toBe(true);
    expect(scene.drawScore.mock.lastCall?.[0]).toMatchObject({ score: 1390, level: 2, nextLevelScore: 1500 });
    expect(inserts.length).toBeGreaterThan(0);
    expect(inserts.every(insert => insert.stack < 3)).toBe(true);
    expect([now, reduced]).toEqual([540, false]);
    pointer('pointerup', 150, 2);
    tick(540 + STACK_UNLOCK_MS - 1);
    tap(50);
    tap(350);
    expect(move).toHaveBeenCalledTimes(1);
    tick(540 + STACK_UNLOCK_MS);
    tap(350);
    expect(move).toHaveBeenCalledTimes(2);
    expect(vi.mocked(move).mock.lastCall?.slice(1, 3)).toEqual([0, 3]);
    expect(scene.startLevelCelebration).not.toHaveBeenCalled();
  });

  it.each([
    { phase: 'match playback', nextLevelScore: 5000, inputAt: 100, readyAt: 540 },
    { phase: 'row reflow', nextLevelScore: 1500, inputAt: 590, readyAt: 540 + STACK_UNLOCK_MS },
  ].flatMap(timing => ['mouse', 'touch'].map(pointerType => ({ ...timing, pointerType }))))(
    'applies one rapid $pointerType pair after $phase finishes',
    async ({ nextLevelScore, inputAt, readyAt, pointerType }) => {
      vi.mocked(createGame).mockReturnValueOnce({ ...initial, nextLevelScore });
      const { match, pointer, tick } = await setup();
      const tap = (x: number, id: number) => {
        pointer('pointerdown', x, id, pointerType);
        pointer('pointerup', x, id, pointerType);
      };

      match();
      if (inputAt > 540) tick(540);
      tick(inputAt);
      tap(250, 4);
      tap(50, pointerType === 'mouse' ? 4 : 5);
      expect(move).toHaveBeenCalledTimes(1);
      tick(readyAt - 1);
      expect(move).toHaveBeenCalledTimes(1);

      tick(readyAt);
      expect(move).toHaveBeenCalledTimes(2);
      expect(vi.mocked(move).mock.lastCall?.slice(1, 3)).toEqual([2, 0]);
      tick(readyAt + 1300);
      expect(move).toHaveBeenCalledTimes(2);
    },
  );

  it.each(['mouse', 'touch'])('ignores a %s drag that starts during match playback and releases after it', async type => {
    vi.mocked(createGame).mockReturnValueOnce({ ...initial, nextLevelScore: 5000 });
    const { match, pointer, tick } = await setup();
    match();
    tick(100);
    pointer('pointerdown', 250, 4, type);
    tick(540);
    if (type === 'touch') pointer('pointermove', 50, 4, type);
    pointer('pointerup', 50, 4, type);
    expect(move).toHaveBeenCalledTimes(1);
    expect(scene.showInteraction.mock.lastCall?.[0].source).toBeNull();

    pointer('pointerdown', 250, 4, type);
    pointer('pointermove', 50, 4, type);
    pointer('pointerup', 50, 4, type);
    expect(move).toHaveBeenCalledTimes(2);
    expect(vi.mocked(move).mock.lastCall?.slice(1, 3)).toEqual([2, 0]);
  });

  it('discards an enqueued touch pair when the board is resized mid-match', async () => {
    vi.mocked(createGame).mockReturnValueOnce({ ...initial, nextLevelScore: 5000 });
    const { match, pointer, tick, resizeViewport } = await setup();
    match();
    tick(100);
    pointer('pointerdown', 250, 4, 'touch');
    pointer('pointerup', 250, 4, 'touch');
    pointer('pointerdown', 50, 5, 'touch');
    pointer('pointerup', 50, 5, 'touch');

    resizeViewport(420, 700);
    tick(540);
    expect(move).toHaveBeenCalledTimes(1);
    expect(scene.showInteraction.mock.lastCall?.[0].source).toBeNull();
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
    expect(game.refillEnds).toBeLessThan(game.unlockEnds);
    game.tick(849);
    expect(scene.drawScore.mock.lastCall?.[0].score).toBe(1390);
    expect(scene.creditScore).not.toHaveBeenCalled();

    game.tick(850);
    expect(scene.drawScore.mock.lastCall?.[0]).toMatchObject({ score: 1555, level: 2, nextLevelScore: 1500 });
    expect(scene.creditScore).toHaveBeenCalledExactlyOnceWith(850, false);
    expect(scene.reachScoreGoal).toHaveBeenCalledExactlyOnceWith(850, false);
    const revealAt = Math.max(game.unlockEnds, game.refillEnds, 1005);
    game.tick(revealAt - 1);
    expect(scene.startLevelCelebration).not.toHaveBeenCalled();

    game.tick(revealAt);
    expect(scene.drawScore.mock.lastCall?.[0]).toEqual({
      score: 1555, level: 3, rank: 'Fryer Fighter', nextLevelScore: 2600, levelStartScore: 1500,
    });
    expect(scene.startLevelCelebration).toHaveBeenCalledExactlyOnceWith({
      level: 3, rank: 'Fryer Fighter', upgrade: { kind: 'stack', firstNewStack: 3, stackCount: 4 },
    }, revealAt, false);
    game.tap(50);
    game.tap(350);
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
    expect(scene.startStackUnlock.mock.lastCall?.[0].score).toBe(1555);
    expect(scene.stackUnlockAnimating).toBe(false);
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
    expect(scene.startMove).toHaveBeenCalledWith([], 0, false, expect.objectContaining({ to: 1 }));
  });

  it('starts refill playback on the triggering transfer and accepts the next move before it finishes', async () => {
    vi.mocked(createGame).mockReturnValueOnce({ ...initial, movesLeft: 1 });
    const { pointer, tap, tick } = await setup();
    pointer('pointerdown', 50);
    expect(scene.showInteraction.mock.lastCall?.[0].pressedStack).toBe(0);
    pointer('pointermove', 250);
    vi.spyOn(Math, 'random').mockReturnValueOnce(0).mockReturnValueOnce(0.5);
    pointer('pointerup', 250);
    expect(scene.startMove).toHaveBeenCalledWith(
      [expect.objectContaining({ stack: 0, depth: 0 })], 0, false,
      expect.objectContaining({ to: 2 }),
    );
    expect(scene.draw.mock.lastCall?.[0].movesLeft).toBe(7);
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
      expect(scene.stackUnlockAnimating).toBe(false);
      const settled = scene.draw.mock.lastCall![0];
      expect(settled.stacks[3]).toHaveLength(Math.floor(settled.capacity / 2));
      expect(new Set(settled.stacks[3].slice(-2)).size).toBe(2);
      expect(scene.drawScore.mock.lastCall?.[0]).toMatchObject({ score: 1555, level: 3, levelStartScore: 1500 });
      tick(1800);
      expect(scene.creditScore).not.toHaveBeenCalled();
      expect(scene.startLevelCelebration).not.toHaveBeenCalled();
      expect(move).toHaveBeenCalledTimes(1);
    },
  );

  it('ignores a canceled swipe and restarts after revealing a settled game over', async () => {
    const { pointer, match, tap, tick, renderer, render, localStorage } = await setup(true);
    pointer('pointerdown', 50);
    pointer('pointermove', 150);
    pointer('pointercancel', 150);
    pointer('pointerup', 150);
    expect(move).not.toHaveBeenCalled();

    vi.mocked(move).mockReturnValueOnce({ ...initial, score: 1555, gameOver: true });
    match();
    expect(scene.showMatch.mock.lastCall?.[0].phase).toBe('clear');
    expect(localStorage.setItem).not.toHaveBeenCalled();
    tap(300);
    expect(createGame).toHaveBeenCalledTimes(1);
    tick(230);
    await settleResults();
    expect(scene.draw.mock.lastCall?.[0].gameOver).toBe(true);
    expect(localStorage.setItem).toHaveBeenCalledExactlyOnceWith(PERSONAL_SCORES_KEY,
      JSON.stringify([{ score: 1555, level: 2, bestCombo: 0 }]));
    expect(scene.showResults).not.toHaveBeenCalled();
    expect(scene.drawScore.mock.lastCall?.[0].score).toBe(1555);
    const priorRenders = render.mock.calls.length;
    tick(230 + GAME_OVER_HOLD_MS - 1);
    expect(render).toHaveBeenCalledTimes(priorRenders);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(null, true);
    tick(230 + GAME_OVER_HOLD_MS);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(0, true);
    tick(230 + GAME_OVER_HOLD_MS + GAME_OVER_CUE_MS - 1);
    expect(scene.showResults).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(priorRenders + 1);
    tick(230 + GAME_OVER_HOLD_MS + GAME_OVER_CUE_MS);
    expect(scene.showResults.mock.lastCall?.[0]).toMatchObject({ tab: 'personal', friends: null });
    expect(render).toHaveBeenCalledTimes(priorRenders + 2);
    expect(localStorage.setItem).toHaveBeenCalledTimes(1);
    tap(300);
    expect(createGame).toHaveBeenCalledTimes(2);
    expect(scene.draw.mock.lastCall?.[0]).toBe(initial);
    expect(scene.drawScore.mock.lastCall?.[0].score).toBe(1390);
    expect(scene.showResults).toHaveBeenLastCalledWith(null);
    renderer.emit('resize');
    expect(localStorage.setItem).toHaveBeenCalledTimes(1);
  });

  it('waits for visible board effects, preserves visible time, and resumes the same cue after interruptions', async () => {
    const { match, tap, tick, window, document, motion, resizeViewport, suspendFromHost } = await setup();
    vi.mocked(move).mockReturnValueOnce({ ...initial, gameOver: true });
    match();
    tap(50);
    tap(150);
    tap(300);
    expect(move).toHaveBeenCalledTimes(1);
    scene.effectsAnimating = true;
    tick(16);
    tick(3000);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(null, false);
    expect(scene.showResults).not.toHaveBeenCalled();
    scene.effectsAnimating = false;
    tick(3100);
    await settleResults();

    tick(3500);
    window.dispatchEvent(new Event('blur'));
    tick(7500);
    resizeViewport(375, 700);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(null, false);
    window.dispatchEvent(new Event('focus'));
    tick(7900);
    document.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    tick(11900);
    document.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    tick(12300);
    suspendFromHost();
    tick(16300);
    expect(scene.showResults).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('focus'));
    tick(17099);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(null, false);
    tick(17100);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(0, false);

    tick(17300);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(0.4, false);
    resizeViewport(390, 700);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(0.4, false);
    motion.matches = true;
    motion.dispatchEvent(new Event('change'));
    tick(17300);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(0.4, true);
    window.dispatchEvent(new Event('pagehide'));
    tick(21300);
    expect(scene.showResults).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pageshow'));
    tick(21300);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(0.4, true);
    tick(21599);
    expect(scene.showResults).not.toHaveBeenCalled();
    tick(21600);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(null, true);
    expect(scene.showResults).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it('opens results after the cue if score recording rejects', async () => {
    const record = vi.fn(async () => { throw new Error('Storage is unavailable'); });
    const { match, tick } = await setup(true, '', 1, { record });
    vi.mocked(move).mockReturnValueOnce({ ...initial, gameOver: true });
    match();
    tick(16);
    await settleResults();
    expect(record).toHaveBeenCalledExactlyOnceWith({ score: 1390, level: 2, bestCombo: 0 });
    tick(16 + GAME_OVER_HOLD_MS);
    expect(scene.showResults).not.toHaveBeenCalled();
    tick(16 + GAME_OVER_HOLD_MS + GAME_OVER_CUE_MS);
    expect(scene.showResults.mock.lastCall?.[0]?.personal).toEqual({
      run: { score: 1390, level: 2, bestCombo: 0 }, rows: [], isPersonalBest: false,
    });
  });

  it('recovers from a stalled recording and ignores its late completion after replay', async () => {
    let complete!: (results: CompletedResults) => void;
    const record = vi.fn(() => new Promise<CompletedResults>(resolve => { complete = resolve; }));
    const { match, tap, tick, render } = await setup(true, '', 1, { record });
    vi.mocked(move).mockReturnValueOnce({ ...initial, gameOver: true });
    match();
    tick(16);
    await settleResults();
    tick(16 + GAME_OVER_HOLD_MS);
    tick(16 + GAME_OVER_HOLD_MS + GAME_OVER_CUE_MS);
    const priorRenders = render.mock.calls.length;
    tick(GAME_OVER_RECORD_LIMIT_MS - 1);
    expect(render).toHaveBeenCalledTimes(priorRenders);
    expect(scene.showResults).not.toHaveBeenCalled();
    tick(GAME_OVER_RECORD_LIMIT_MS);
    expect(scene.showResults.mock.lastCall?.[0]?.personal.run.score).toBe(1390);
    tap(300);
    expect(scene.showResults).toHaveBeenLastCalledWith(null);
    complete({ run: { score: 1390, level: 2, bestCombo: 0 }, rows: [], isPersonalBest: true });
    await settleResults();
    tick(4000);
    expect(scene.showResults).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('records the best combo from earlier matches after an actual terminal refill, once across resize and replay', async () => {
    const game = await vi.importActual<typeof import('../game')>('../game');
    let seed = 9;
    let draws = 0;
    // Keep the opening and five pressure refills on the fixture's seven-miss cadence.
    const intervalDraws = new Set([16, 18, 20, 24, 26, 28]);
    const rng = () => {
      if (intervalDraws.has(++draws)) return 0.5;
      seed = (Math.imul(1664525, seed) + 1013904223) >>> 0;
      return seed / 2 ** 32;
    };
    vi.mocked(createGame).mockReturnValueOnce(game.createGame(rng));
    vi.mocked(move).mockImplementation((state, from, to, _rng, onDough) => game.move(state, from, to, rng, onDough));
    const { tap, tick, renderer, window, localStorage } = await setup(true);
    const path = [
      [0, 2], [2, 1], [2, 1], [2, 0], [1, 0], [0, 1], [2, 0], [2, 0], [0, 2], [1, 0], [2, 1], [1, 2],
      [2, 1], [0, 2], [1, 2], [0, 2], [2, 1], [0, 1], [1, 0], [1, 0], [0, 2], [1, 0], [2, 1], [1, 2],
      [1, 2], [2, 1], [0, 1], [1, 0], [0, 1], [1, 0], [0, 1], [0, 2], [1, 0], [1, 0], [0, 1], [2, 0], [2, 1],
    ];
    path.forEach(([from, to], index) => {
      tap(from * 100 + 50);
      tap(to * 100 + 50);
      expect(localStorage.setItem).not.toHaveBeenCalled();
      if (index < path.length - 1) tick((index + 1) * 1000);
    });
    expect(scene.draw.mock.lastCall?.[0]).toMatchObject({ score: 210, level: 1, combo: 0, gameOver: true });
    expect(scene.moveAnimating).toBe(true);
    expect(scene.showResults).not.toHaveBeenCalled();
    tick(path.length * 1000);
    await settleResults();
    tick(path.length * 1000 + GAME_OVER_HOLD_MS);
    tick(path.length * 1000 + GAME_OVER_HOLD_MS + GAME_OVER_CUE_MS);
    const view = scene.showResults.mock.lastCall?.[0];
    expect(view?.personal).toEqual({ run: { score: 210, level: 1, bestCombo: 2 }, isPersonalBest: true,
      rows: [{ rank: 1, score: 210, current: true }] });
    renderer.emit('resize');
    window.dispatchEvent(new Event('blur'));
    expect(scene.showResults).toHaveBeenCalledTimes(1);
    expect(localStorage.setItem).toHaveBeenCalledTimes(1);
    tap(300);
    expect(createGame).toHaveBeenCalledTimes(2);
    expect(scene.showResults).toHaveBeenLastCalledWith(null);
    expect(localStorage.setItem).toHaveBeenCalledTimes(1);
    vi.mocked(move).mockImplementation(game.move);
  });

  it('wires Friends and explicit submission from the completed screen only', async () => {
    let completeList = () => {};
    const board: FriendsScores = {
      list: vi.fn(() => new Promise<readonly FriendScore[]>(resolve => { completeList = () => resolve([]); })),
      submit: vi.fn(async () => {}),
    };
    getFriendsScores.mockReturnValue(board);
    scene.hit.mockImplementation(({ x }: Point) => {
      if (!scene.draw.mock.lastCall?.[0].gameOver) return Math.floor(x / 100);
      return x === 300 ? 'restart' : x === 320 ? 'friends' : x === 340 ? 'submit' : 'personal';
    });
    const { match, tick, tap, renderer, localStorage, render } = await setup(true);
    vi.mocked(move).mockReturnValueOnce({ ...initial, score: 1555, gameOver: true });
    match();
    expect(getFriendsScores).not.toHaveBeenCalled();
    tick(1000);
    await settleResults();
    const popupAt = 1000 + GAME_OVER_HOLD_MS + GAME_OVER_CUE_MS;
    tick(1000 + GAME_OVER_HOLD_MS);
    tick(popupAt);
    expect(getFriendsScores).toHaveBeenCalledTimes(1);
    expect(scene.showResults.mock.lastCall?.[0]).toMatchObject({ tab: 'personal' });
    renderer.emit('resize');
    expect(board.list).not.toHaveBeenCalled();
    expect(board.submit).not.toHaveBeenCalled();
    tap(320);
    expect(board.list).toHaveBeenCalledTimes(1);
    expect(board.submit).not.toHaveBeenCalled();
    tick(popupAt + 16);
    const awaitingFriends = render.mock.calls.length;
    tick(popupAt + 32);
    expect(render).toHaveBeenCalledTimes(awaitingFriends);
    completeList();
    await settleResults();
    tick(popupAt + 48);
    tick(popupAt + 64);
    expect(render).toHaveBeenCalledTimes(awaitingFriends + 1);
    expect(scene.showResults.mock.lastCall?.[0]?.friends?.list.status).toBe('ready');
    tap(340);
    tap(340);
    expect(board.submit).toHaveBeenCalledExactlyOnceWith(1555);
    tap(300);
    await Promise.resolve();
    expect(scene.showResults).toHaveBeenLastCalledWith(null);
    expect(board.list).toHaveBeenCalledTimes(1);
    expect(localStorage.setItem).toHaveBeenCalledTimes(1);
  });
});
