import { EventEmitter } from 'node:events';
import type { Application } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createGame, type DoughInsert, findSetupHint, type GameState, JOKER, move } from '../game';
import { createFriendsScores } from '../platform/friendsScores';
import { PERSONAL_SCORES_KEY } from '../platform/personalScores';
import type { Point } from './gestures';
import { mountGame } from './index';
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
  drawScore: vi.fn<(display: ScoreDisplay) => void>(),
  creditScore: vi.fn(), reachScoreGoal: vi.fn(), startLevelCelebration: vi.fn(),
  showScoreEffects: vi.fn(), cancelScoreEffects: vi.fn(),
  resize: vi.fn(), startMatch: vi.fn(), showMatch: vi.fn(), showMatchTail: vi.fn(), cancelMatch: vi.fn(),
  startMove: vi.fn(), showMove: vi.fn(), finishMove: vi.fn(), moveAnimating: false,
  startStackUnlock: vi.fn<(state: GameState, inserts: readonly DoughInsert[], now: number, reduced: boolean) => void>(),
  finishStackUnlock: vi.fn(), stackUnlockAnimating: false,
  showInteraction: vi.fn(), showJoker: vi.fn(), topPosition: vi.fn(),
  setHintAvailable: vi.fn(), showHint: vi.fn(), clearHint: vi.fn(),
}));

vi.mock('./scene', () => ({ GameScene: class { constructor() { return scene; } }, loadArt: async () => new Map() }));
vi.mock('./matchEffect', () => ({ preloadScoreFont: async () => {} }));
vi.mock('../platform/friendsScores', () => ({ createFriendsScores: vi.fn() }));
vi.mock('../game', async importOriginal => {
  const game = await importOriginal<typeof import('../game')>();
  return { ...game, createGame: vi.fn(), move: vi.fn(game.move), findSetupHint: vi.fn(game.findSetupHint) };
});

const initial: GameState = {
  stacks: [['blue', 'red'], ['red', 'green', 'red', 'red', 'red'], ['yellow', 'blue']],
  score: 1390, level: 2, rank: 'Pastry Pupil', capacity: 6, nextLevelScore: 1500, movesLeft: 7, gameOver: false,
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createGame).mockReturnValue(initial);
  vi.mocked(createFriendsScores).mockReturnValue(null);
  scene.hit.mockImplementation(({ x }: Point) => {
    if (scene.draw.mock.lastCall?.[0].gameOver) return x === 300 ? 'restart' : null;
    if (x === 398) return 'hint';
    return Math.floor(x / 100);
  });
});
afterEach(() => vi.restoreAllMocks());

async function setup(reduced = false, search = '') {
  let now = 0;
  let refillEnds = 0;
  let unlockEnds = 0;
  scene.moveAnimating = false;
  scene.stackUnlockAnimating = false;
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
  const motion = { matches: reduced };
  const localStorage = { getItem: vi.fn((): string | null => null), setItem: vi.fn() };
  const sessionStorage = { getItem: vi.fn((): string | null => null), setItem: vi.fn() };
  const window = Object.assign(new EventTarget(), { matchMedia: () => motion, location: { search }, localStorage, sessionStorage });
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
  return { window, renderer, screen: app.screen, pointer, tap, match, tick, motion, localStorage, sessionStorage,
    get refillEnds() { return refillEnds; }, get unlockEnds() { return unlockEnds; } };
}

describe('game view match playback', () => {
  const hintState: GameState = {
    ...initial, movesLeft: 3, capacity: 5,
    stacks: [['green', 'red', 'blue', 'green', 'green'], ['blue', 'red', 'green', 'red'], ['blue', 'blue', 'blue', 'red']],
  };

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
    const { tap, tick } = await setup(true);
    tap(398);
    tap(398);
    expect(findSetupHint).toHaveBeenCalledExactlyOnceWith(state);
    expect(scene.showHint).toHaveBeenLastCalledWith(null);
    scene.clearHint.mockClear();
    tick(1499);
    expect(scene.clearHint).not.toHaveBeenCalled();
    tick(1500);
    expect(scene.clearHint).toHaveBeenCalledOnce();
    expect(move).not.toHaveBeenCalled();
    expect(state.movesLeft).toBe(3);
  });

  it('rejects Hint while playback is active and on a board with an immediate match', async () => {
    vi.mocked(createGame).mockReturnValueOnce(hintState);
    const { tap, tick } = await setup();
    scene.moveAnimating = true;
    tap(398);
    expect(scene.setHintAvailable).toHaveBeenLastCalledWith(false);
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
    expect(localStorage.setItem).not.toHaveBeenCalled();
    expect(sessionStorage.setItem).toHaveBeenCalledTimes(1);
    expect(createFriendsScores).not.toHaveBeenCalled();
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
    const { pointer, renderer, screen } = await setup();
    pointer('pointerdown', 50, 1, 'touch');
    pointer('pointerup', 50, 1, 'touch');
    screen.height -= 57;
    renderer.emit('resize');
    pointer('pointerdown', 250, 1, 'touch');
    pointer('pointerup', 250, 1, 'touch');
    expect(move).toHaveBeenCalledTimes(1);
    expect(vi.mocked(move).mock.lastCall?.slice(1, 3)).toEqual([0, 2]);
  });

  it.each(['active touch', 'width change', 'large height change'])('cancels input on resize with %s', async scenario => {
    const { pointer, renderer, screen } = await setup();
    const touch = (type: string, x: number) => pointer(type, x, 1, 'touch');
    touch('pointerdown', 50);
    touch('pointerup', 50);
    if (scenario === 'active touch') touch('pointerdown', 250);
    if (scenario === 'width change') screen.width += 20;
    screen.height -= scenario === 'large height change' ? 120 : 57;
    renderer.emit('resize');
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

  it('locks a four-donut tap match through reflow and accepts a move into the new index immediately afterward', async () => {
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
    tap(50);
    tap(350);
    expect(move).toHaveBeenCalledTimes(2);
    expect(vi.mocked(move).mock.lastCall?.slice(1, 3)).toEqual([0, 3]);
    expect(scene.startLevelCelebration).not.toHaveBeenCalled();
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
    const { pointer, match, tap, tick, renderer, localStorage } = await setup(true);
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
    expect(scene.draw.mock.lastCall?.[0].gameOver).toBe(true);
    expect(scene.drawScore.mock.lastCall?.[0].score).toBe(1555);
    expect(localStorage.setItem).toHaveBeenCalledExactlyOnceWith(PERSONAL_SCORES_KEY,
      JSON.stringify([{ score: 1555, level: 2, bestCombo: 0 }]));
    expect(scene.showResults.mock.lastCall?.[0]).toMatchObject({ tab: 'personal', friends: null });
    tick(260);
    expect(localStorage.setItem).toHaveBeenCalledTimes(1);
    tap(300);
    expect(createGame).toHaveBeenCalledTimes(2);
    expect(scene.draw.mock.lastCall?.[0]).toBe(initial);
    expect(scene.drawScore.mock.lastCall?.[0].score).toBe(1390);
    expect(scene.cancelMatch).toHaveBeenCalledTimes(3);
    expect(scene.showResults).toHaveBeenLastCalledWith(null);
    renderer.emit('resize');
    expect(localStorage.setItem).toHaveBeenCalledTimes(1);
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
    const board = { list: vi.fn(async () => []), submit: vi.fn(async () => {}) };
    vi.mocked(createFriendsScores).mockReturnValue(board);
    scene.hit.mockImplementation(({ x }: Point) => {
      if (!scene.draw.mock.lastCall?.[0].gameOver) return Math.floor(x / 100);
      return x === 300 ? 'restart' : x === 320 ? 'friends' : x === 340 ? 'submit' : 'personal';
    });
    const { match, tick, tap, renderer, localStorage } = await setup(true);
    vi.mocked(move).mockReturnValueOnce({ ...initial, score: 1555, gameOver: true });
    match();
    expect(createFriendsScores).not.toHaveBeenCalled();
    tick(1000);
    expect(createFriendsScores).toHaveBeenCalledTimes(1);
    expect(scene.showResults.mock.lastCall?.[0]).toMatchObject({ tab: 'personal' });
    renderer.emit('resize');
    expect(board.list).not.toHaveBeenCalled();
    expect(board.submit).not.toHaveBeenCalled();
    tap(320);
    expect(board.list).toHaveBeenCalledTimes(1);
    expect(board.submit).not.toHaveBeenCalled();
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
