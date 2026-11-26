import { EventEmitter } from 'node:events';
import type { AdOutcome } from '@playbridge/core';
import { createBrowserPersistence } from '@playbridge/web';
import type { Application, Container, FederatedPointerEvent } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameSound } from '../audio/GameSound';
import { createGame, type DoughInsert, findSetupHint, type GameState, JOKER, move } from '../game';
import { BrowserQuality } from '../performance/browserQuality';
import type { FriendScore, FriendsScores } from '../platform/friendsScores';
import type { AdPlacement, AdRequestOptions, GameMonetization } from '../platform/monetization';
import { browserScoreStorage, type CompletedResults, PERSONAL_SCORES_KEY, PersonalScores } from '../platform/personalScores';
import type { BoosterFooterView } from './boosters';
import type { FirstMatchProgress } from './firstMatch';
import type { FirstMatchHandMotion } from './firstMatchHand';
import { FREE_BOOSTER_FLIGHT_MS, FREE_BOOSTER_HOLD_MS, FREE_BOOSTER_LANDING_MS } from './freeBoosterCelebration';
import { GAME_OVER_CUE_MS, GAME_OVER_LEAD_IN_MS, GAME_OVER_RECORD_LIMIT_MS, GAME_OVER_REVEAL_MS } from './gameOverPresentation';
import type { BoosterButton, Point, StackGestures } from './gestures';
import { mountGame } from './index';
import { layoutStacks, stackHit, stackTarget } from './layout';
import { LEVEL_CELEBRATION_MS } from './levelCelebration';
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
  canScrollResults: vi.fn<(point: Point) => boolean>(),
  scrollResults: vi.fn<(delta: number) => boolean>(),
  showGameOverCue: vi.fn<(progress: number | null, reduced: boolean) => void>(),
  drawScore: vi.fn<(display: ScoreDisplay) => void>(),
  creditScore: vi.fn(), reachScoreGoal: vi.fn(), startLevelCelebration: vi.fn(),
  showScoreEffects: vi.fn(), cancelScoreEffects: vi.fn(),
  resize: vi.fn(), startMatch: vi.fn(), showMatch: vi.fn(), showMatchTail: vi.fn(), cancelMatch: vi.fn(),
  startMove: vi.fn(), showMove: vi.fn(), finishMove: vi.fn(), moveAnimating: false,
  startMoveCost: vi.fn<(to: number, started: number, reduced: boolean, remaining: number) => void>(),
  startMoveRecovery: vi.fn(),
  showMoveCosts: vi.fn(), clearMoveCosts: vi.fn(), moveCostAnimating: false, moveCostDeadline: 0,
  showIcingVial: vi.fn(), icingVialAnimating: false, icingVialDeadline: 0,
  startStackUnlock: vi.fn<(state: GameState, inserts: readonly DoughInsert[], now: number, reduced: boolean) => void>(),
  finishStackUnlock: vi.fn(), stackUnlockAnimating: false,
  selectionAnimating: false, effectsAnimating: false,
  warmup: function* () {}, releasePreparedText: vi.fn(),
  showInteraction: vi.fn(), showJoker: vi.fn(), topPosition: vi.fn(),
  setHintAvailable: vi.fn(), showHint: vi.fn(), clearHint: vi.fn(),
  showFirstMatchGuide: vi.fn((move: { from: number; to: number } | null, _now: number, motion: FirstMatchHandMotion) =>
    move !== null && motion === 'animate'),
  hideFirstMatchGuide: vi.fn(), pauseFirstMatchGuide: vi.fn(),
  setBoosterControls: vi.fn<(view: BoosterFooterView) => void>(), boosterCueDeadline: 0,
  startBoosterCue: vi.fn<(kind: BoosterButton, targets: readonly { stack: number; color: string }[], now: number, reduced: boolean) => void>(),
  showBoosterCue: vi.fn(), cancelBoosterCue: vi.fn(),
  freeBoosterDeadline: 0, freeBoosterAnimating: false,
  startFreeBoosterCelebration: vi.fn<(kind: BoosterButton, now: number, reduced: boolean) => void>(),
  showFreeBoosterCelebration: vi.fn<(now: number) => void>(),
  cancelFreeBoosterCelebration: vi.fn<(kind?: BoosterButton) => void>(),
}));

vi.mock('./scene', () => ({ GameScene: class { constructor() { return scene; } }, loadArt: async () => new Map() }));
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

function finishGameOverReveal(tick: (time: number) => void, settledAt: number): void {
  const cueAt = settledAt + GAME_OVER_LEAD_IN_MS;
  tick(cueAt);
  tick(cueAt + GAME_OVER_CUE_MS);
  tick(settledAt + GAME_OVER_REVEAL_MS);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(createGame).mockReturnValue(initial);
  getFriendsScores.mockReturnValue(null);
  scene.canScrollResults.mockReturnValue(false);
  scene.scrollResults.mockReturnValue(false);
  scene.hit.mockImplementation(({ x }: Point, _mode: string, duringUnlock: boolean) => {
    const last = scene.draw.mock.lastCall?.[0];
    if (last?.gameOver) return x === 300 ? 'restart' : null;
    const stack = Math.floor(x / 100);
    if (scene.stackUnlockAnimating && (!duringUnlock || stack >= (last?.stacks.length ?? 0))) return null;
    return x === 398 ? 'hint' : x === 397 ? 'joker' : x === 396 ? 'sweep' : stack;
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

class TestElement extends EventTarget {
  readonly nodeName: string;
  readonly children: TestElement[] = [];
  parent: TestElement | null = null;
  textContent = '';
  className = '';
  readonly attributes = new Map<string, string>();
  readonly focus = vi.fn();
  hidden = false;
  open = false;

  constructor(tag: string) {
    super();
    this.nodeName = tag.toUpperCase();
  }

  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  setAttribute(name: string, value: string) { this.attributes.set(name, value); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  showModal() { this.open = true; }
  close() { this.open = false; }

  append(...children: TestElement[]) {
    for (const child of children) {
      this.children.push(child);
      child.parent = this;
    }
  }

  remove() {
    const siblings = this.parent?.children;
    if (siblings) siblings.splice(siblings.indexOf(this), 1);
    this.parent = null;
  }
}

async function setup(
  reduced = false, search = '', devicePixelRatio = 1, scores?: Pick<PersonalScores, 'record'>,
  watchBoosterAd?: (isCurrent: () => boolean) => Promise<AdOutcome>,
  gameMonetization?: GameMonetization,
  firstMatch?: FirstMatchProgress,
) {
  let now = 0;
  let refillEnds = 0;
  let unlockEnds = 0;
  scene.moveAnimating = false;
  scene.moveCostAnimating = false;
  scene.moveCostDeadline = 0;
  scene.stackUnlockAnimating = false;
  scene.selectionAnimating = false;
  scene.effectsAnimating = false;
  scene.boosterCueDeadline = 0;
  scene.startBoosterCue.mockImplementation((_kind, _targets, started) => { scene.boosterCueDeadline = started + 230; });
  scene.showBoosterCue.mockImplementation(now => {
    if (now >= scene.boosterCueDeadline) scene.boosterCueDeadline = 0;
  });
  scene.cancelBoosterCue.mockImplementation(() => { scene.boosterCueDeadline = 0; });
  let celebrating: BoosterButton | undefined;
  scene.freeBoosterDeadline = 0;
  scene.freeBoosterAnimating = false;
  scene.startFreeBoosterCelebration.mockImplementation((kind, now, reduced) => {
    celebrating = kind;
    scene.freeBoosterAnimating = !reduced;
    scene.freeBoosterDeadline = now + FREE_BOOSTER_HOLD_MS + (reduced ? 0 : FREE_BOOSTER_FLIGHT_MS + FREE_BOOSTER_LANDING_MS);
  });
  scene.cancelFreeBoosterCelebration.mockImplementation(kind => {
    if (kind && kind !== celebrating) return;
    celebrating = undefined;
    scene.freeBoosterDeadline = 0;
    scene.freeBoosterAnimating = false;
  });
  scene.showFreeBoosterCelebration.mockImplementation(now => {
    if (now < scene.freeBoosterDeadline) return;
    celebrating = undefined;
    scene.freeBoosterDeadline = 0;
    scene.freeBoosterAnimating = false;
  });
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
  let safeAreaBottom = 0;
  const window = Object.assign(new EventTarget(), {
    matchMedia: (query: string) => query.includes('prefers-reduced-motion') ? motion : new EventTarget(),
    getComputedStyle: () => ({ getPropertyValue: (name: string) => name === '--game-safe-area-bottom' ? `${safeAreaBottom}px` : '0px' }),
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
  const body = new TestElement('body');
  const document = Object.assign(new EventTarget(), {
    defaultView: window, hidden: false, body,
    createElement: (tag: string) => new TestElement(tag),
    querySelectorAll: () => body.children.filter(element => element.nodeName === 'DIALOG' && element.open),
  });
  let modalChanged = (_target: TestElement) => {};
  vi.stubGlobal('MutationObserver', class {
    constructor(callback: (records: { target: TestElement }[]) => void) {
      modalChanged = target => callback([{ target }]);
    }
    observe() {}
    disconnect() { modalChanged = () => {}; }
  });
  const canvas = Object.assign(new TestElement('canvas'), {
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
  const app = { canvas, renderer, render: vi.fn(), stage: { addChild: vi.fn(), once: vi.fn(), off: vi.fn() }, screen };
  const jokerPlaytest = new URLSearchParams(search).get('playtest') === 'joker';
  const personalScores = scores ?? new PersonalScores(createBrowserPersistence(
    jokerPlaytest ? sessionStorage : browserScoreStorage(() => localStorage, 'web')));
  const quality = new BrowserQuality(window as unknown as Window);
  const onResultsVisibilityChange = vi.fn<(visible: boolean) => void>();
  const monetization = gameMonetization ?? (watchBoosterAd ? {
    available: (placement: AdPlacement) => placement === 'joker' || placement === 'sweep',
    setPlaying() {},
    runCompleted() {},
    request(_placement: AdPlacement, ad: AdRequestOptions) {
      ad.onAttempt();
      return watchBoosterAd(ad.canShow);
    },
  } : undefined);
  const view = await mountGame(app as unknown as Application, {
    jokerPlaytest, firstMatch, personalScores, getFriendsScores, monetization, quality, onResultsVisibilityChange,
    onPause(callback) { pause = callback; return () => { pause = () => {}; }; },
  });
  const dialog = body.children.find(element => element.className === 'game-ad-dialog')!;
  const menuRoot = app.stage.addChild.mock.lastCall![1] as Container;
  const menuOpen = () => canvas.getAttribute('aria-description')?.includes('Game menu open.') ?? false;
  const menuLaunch = menuRoot.getChildByLabel('Game menu', true)!;
  const menuSound = menuRoot.getChildrenByLabel('Sound effects', true);
  const clickMenu = (label: string, pointerId = 21) => {
    const button = label === 'Sound effects'
      ? menuSound[menuOpen() ? 1 : 0]
      : menuRoot.getChildByLabel(label, true)!;
    const event = { button: 0, pointerId, nativeEvent: new Event('pointerup') } as FederatedPointerEvent;
    button.emit('pointerdown', event);
    button.emit('pointertap', event);
  };
  const keyMenu = (key: string, shiftKey = false) => {
    const event = Object.assign(new Event('keydown', { cancelable: true }), { key, shiftKey });
    canvas.dispatchEvent(event);
    return event.defaultPrevented;
  };
  const destroy = scene.root.once.mock.lastCall![1] as () => void;
  const clickDialog = (label: string) => {
    const button = dialog?.open && dialog.children[2].children.find(child => !child.hidden && child.textContent === label);
    if (button) button.dispatchEvent(new Event('click'));
    return !!button;
  };
  const other = new TestElement('dialog');
  const setOtherModalOpen = (open: boolean) => {
    if (!other.parent) body.append(other);
    other.open = open;
    modalChanged(other);
  };

  const pointer = (type: string, clientX: number, pointerId = 1, pointerType = 'mouse', buttons = 0, clientY = 200) => {
    const event = Object.assign(new Event(type), { button: 0, buttons, pointerId, pointerType, clientX, clientY });
    (['pointerdown', 'pointerleave', 'lostpointercapture'].includes(type) ? canvas : window).dispatchEvent(event);
  };
  const tap = (x: number) => { pointer('pointerdown', x); pointer('pointerup', x); };
  const wheel = (clientX: number, clientY: number, deltaY: number, deltaMode = 0) => {
    const event = Object.assign(new Event('wheel', { cancelable: true }), { clientX, clientY, deltaY, deltaMode });
    canvas.dispatchEvent(event);
    return event.defaultPrevented;
  };
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
  const resizeViewport = (width: number, height: number, inset = 0) => {
    safeAreaBottom = inset;
    Object.assign(window, { innerWidth: width, innerHeight: height });
    window.dispatchEvent(new Event('resize'));
    tick(now);
  };
  return { window: window as typeof window & Pick<Window, 'rebornBoardSnapshot'>,
    document, renderer, render: app.render, resizeViewport, pointer, tap, wheel, match, tick,
    motion, localStorage, sessionStorage, onResultsVisibilityChange, suspendFromHost: () => pause(),
    clickDialog, dialog, destroy, setOtherModalOpen, canvas, menuRoot, menuOpen, menuLaunch, menuSound, clickMenu, keyMenu,
    reserveCommerceSpace: view.reserveCommerceSpace,
    get refillEnds() { return refillEnds; }, get unlockEnds() { return unlockEnds; } };
}

describe('board diagnostics', () => {
  it('does not install the getter in the ordinary mode', async () => {
    const { window } = await setup();
    expect(window).not.toHaveProperty('rebornBoardSnapshot');
  });

  it('observes a terminal transfer before the overlay and preserves detached data across replay', async () => {
    vi.stubEnv('MODE', 'board-debug');
    const { window, match, tap, tick, destroy } = await setup(true);
    const read = window.rebornBoardSnapshot!;
    const opening = read();
    expect(opening).toMatchObject({ current: { runId: 1, gameOver: false, lastAction: null }, lastGameOver: null });
    vi.mocked(move).mockReturnValueOnce(initial);
    match();
    expect(read()).toEqual(opening);

    const terminal = { ...initial, movesLeft: 6, gameOver: true, stacks: [['gold', 'blue'],
      ['red', 'green', 'red', 'red', 'red', 'red'], ['yellow', 'blue']] };
    const insertion = { stack: 0, depth: 0, color: 'gold' };
    vi.mocked(move).mockImplementationOnce((_state, _from, _to, _rng, reportRefills) => {
      reportRefills?.([insertion]);
      return terminal;
    });
    match();
    const captured = read();
    const { runId, lastAction, ...after } = captured.current;
    const { runId: _initialRun, lastAction: _initialAction, ...before } = opening.current;
    expect(lastAction).toEqual({ kind: 'transfer', fromStackIndex: 0, toStackIndex: 1, refillInsertions: [insertion] });
    expect(after).toMatchObject({ movesLeft: 6, gameOver: true, stacks: terminal.stacks.map((colorsBottomFirst, index) => ({ index, colorsBottomFirst })) });
    expect(captured.lastGameOver).toEqual({ runId, before, after, action: lastAction });
    expect(scene.showResults).not.toHaveBeenCalled();
    expect(() => JSON.stringify(captured)).not.toThrow();

    const editable = read();
    editable.current.stacks[0].colorsBottomFirst.length = 0;
    editable.current.lastAction!.refillInsertions[0].depth = 99;
    editable.lastGameOver!.before.stacks.reverse();
    editable.lastGameOver!.after.score = -1;
    expect(read()).toEqual(captured);

    tick(1000);
    await settleResults();
    finishGameOverReveal(tick, 1000);
    expect(scene.showResults).toHaveBeenCalledOnce();
    expect(read()).toEqual(captured);
    tap(300);
    expect(read()).toEqual({ current: { ...opening.current, runId: 2 }, lastGameOver: captured.lastGameOver });
    destroy();
    expect(window).not.toHaveProperty('rebornBoardSnapshot');
  });
});

describe('committed move cost feedback', () => {
  it.each([
    { meter: undefined, movesLeft: 5, reduced: false, touch: false },
    { meter: 3, movesLeft: 1, reduced: false, touch: true },
    { meter: 27, movesLeft: 1, reduced: true, touch: false },
  ])('emits exactly once for meter $meter, pressure $movesLeft and reduced motion $reduced', async ({ meter, movesLeft, reduced, touch }) => {
    vi.mocked(createGame).mockReturnValueOnce({ ...initial, movesLeft, doughMeter: meter });
    const { pointer, tap, suspendFromHost } = await setup(reduced);
    const clearCount = scene.clearMoveCosts.mock.calls.length;
    if (touch) {
      pointer('pointerdown', 250, 4, 'touch', 1);
      pointer('pointermove', 50, 4, 'touch', 1);
      pointer('pointerup', 50, 4, 'touch');
    } else {
      tap(250);
      tap(50);
    }
    const after = scene.draw.mock.lastCall![0];
    expect(after).toMatchObject({ doughMeter: (meter ?? 0) + 1, gameOver: meter === 27 });
    if (movesLeft === 1 && meter !== 27) expect(after.movesLeft).toBeGreaterThanOrEqual(6);
    suspendFromHost();
    expect(scene.startMoveCost).toHaveBeenCalledExactlyOnceWith(0, 0, reduced, 27 - (meter ?? 0));
    expect(scene.clearMoveCosts.mock.calls.length).toBeGreaterThan(clearCount);
  });

  it('skips a scoring match and a blocked transfer', async () => {
    const full = ['blue', 'green', 'blue', 'green', 'blue', 'green'];
    vi.mocked(createGame).mockReturnValueOnce({ ...initial, stacks: [...initial.stacks.slice(0, 2), full] });
    const { tap, tick } = await setup(true);
    tap(50);
    tap(250);
    expect(scene.startMoveCost).not.toHaveBeenCalled();
    tap(150);
    tick(1000);
    expect(scene.startMatch).toHaveBeenCalledOnce();
    expect(scene.startMoveCost).not.toHaveBeenCalled();
  });

  it.each([
    { spent: 0, levelGain: 0, comboGain: 0 },
    { spent: 3, levelGain: 3, comboGain: 0 },
    { spent: 7, levelGain: 7, comboGain: 0 },
    { spent: 9, levelGain: 7, comboGain: 1 },
  ])('shows actual level recovery $levelGain and combo recovery $comboGain at $spent spent', async ({ spent, levelGain, comboGain }) => {
    vi.mocked(createGame).mockReturnValueOnce({ ...initial, combo: 4, doughMeter: spent });
    const { match, tick } = await setup(true);
    match();
    const levelRemaining = 28 - spent + levelGain;
    expect(scene.startMoveRecovery.mock.calls).toEqual([
      ...(levelGain ? [[{ source: 'level', restored: levelGain, remaining: levelRemaining }, 230, true]] : []),
      ...(comboGain ? [[{ source: 'combo', restored: comboGain, remaining: levelRemaining + comboGain }, 230, true]] : []),
    ]);
    expect(scene.startMoveCost).not.toHaveBeenCalled();
    tick(230);
    tick(385);
    expect(scene.startLevelCelebration).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ movesRestored: levelGain }), 385, true);
  });
});

describe('first-match input', () => {
  async function setupFirstMatch(reduced = true) {
    const { createGame: deal } = await vi.importActual<typeof import('../game')>('../game');
    vi.mocked(createGame).mockReturnValueOnce(deal(() => 0.25));
    const complete = vi.fn(async () => {});
    const game = await setup(reduced, '', 1, undefined, undefined, undefined, { complete });
    return { ...game, complete };
  }

  it('renders the board first and keeps the guide through selection and resizing', async () => {
    const game = await setupFirstMatch();
    expect(game.render).toHaveBeenCalledOnce();
    expect(scene.showFirstMatchGuide).not.toHaveBeenCalled();
    game.tick(300);
    expect(scene.showFirstMatchGuide).toHaveBeenLastCalledWith({ from: 0, to: 1 }, 300, 'reduced');
    game.resizeViewport(320, 650);
    expect(scene.showFirstMatchGuide).toHaveBeenLastCalledWith({ from: 0, to: 1 }, 300, 'reduced');
    game.tap(50);
    game.tick(316);
    expect(scene.showFirstMatchGuide).toHaveBeenLastCalledWith({ from: 0, to: 1 }, 316, 'reduced');
    expect(game.complete).not.toHaveBeenCalled();
    game.tap(150);
    game.tick(1000);
    expect(game.complete).toHaveBeenCalledOnce();
    expect(scene.hideFirstMatchGuide).toHaveBeenCalledOnce();
    expect(scene.startMatch).toHaveBeenCalledOnce();
    expect(scene.drawScore.mock.lastCall?.[0].score).toBe(100);
  });

  it('updates the suggestion after a miss and accepts a different scoring transfer', async () => {
    const game = await setupFirstMatch();
    game.tick(300);
    game.tap(150);
    game.tap(50);
    game.tick(500);
    expect(game.complete).not.toHaveBeenCalled();
    expect(scene.showFirstMatchGuide).toHaveBeenLastCalledWith({ from: 1, to: 0 }, 500, 'reduced');
    game.pointer('pointerdown', 150, 1, 'touch', 1);
    game.pointer('pointermove', 50, 1, 'touch', 1);
    game.pointer('pointerup', 50, 1, 'touch');
    game.tick(1500);
    expect(game.complete).toHaveBeenCalledOnce();
    expect(scene.hideFirstMatchGuide).toHaveBeenCalledOnce();
    expect(scene.startMatch).toHaveBeenCalledOnce();
    expect(scene.drawScore.mock.lastCall?.[0].score).toBe(100);
  });

  it('counts a match made before the guide appears', async () => {
    const game = await setupFirstMatch();
    game.match();
    game.tick(500);
    expect(game.complete).toHaveBeenCalledOnce();
    expect(scene.showFirstMatchGuide).not.toHaveBeenCalled();
    expect(scene.hideFirstMatchGuide).toHaveBeenCalledOnce();
    expect(scene.drawScore.mock.lastCall?.[0].score).toBe(100);
  });

  it('drives the hand only while visible and returns to idle after a match', async () => {
    const game = await setupFirstMatch(false);
    game.tick(300);
    game.tick(316);
    expect(scene.showFirstMatchGuide).toHaveBeenLastCalledWith({ from: 0, to: 1 }, 316, 'animate');

    game.document.hidden = true;
    game.document.dispatchEvent(new Event('visibilitychange'));
    game.tick(1000);
    expect(scene.pauseFirstMatchGuide).toHaveBeenCalledOnce();
    expect(game.render).toHaveBeenCalledTimes(3);

    game.document.hidden = false;
    game.document.dispatchEvent(new Event('visibilitychange'));
    game.tick(1016);
    expect(scene.showFirstMatchGuide).toHaveBeenLastCalledWith({ from: 0, to: 1 }, 1016, 'animate');
    game.match();
    expect(scene.hideFirstMatchGuide).toHaveBeenCalledOnce();
    game.tick(2000);
    game.tick(3000);
    const settledRenders = game.render.mock.calls.length;
    game.tick(4000);
    expect(game.render).toHaveBeenCalledTimes(settledRenders);
  });
});

describe('in-game menu', () => {
  it('shields toolbar presses and held board gestures through Resume and Escape', async () => {
    vi.stubEnv('MODE', 'board-debug');
    const game = await setup(true);
    const snapshot = game.window.rebornBoardSnapshot!;
    const before = snapshot();
    game.pointer('pointerdown', game.menuLaunch.x + 22, 11, 'touch', 1, game.menuLaunch.y + 22);
    game.pointer('pointermove', 150, 11, 'touch');
    game.pointer('pointerup', 150, 11, 'touch');
    expect(game.canvas.setPointerCapture).not.toHaveBeenCalled();

    game.pointer('pointerdown', 50, 12, 'touch');
    game.pointer('pointermove', 150, 12, 'touch');
    expect(game.keyMenu('Tab')).toBe(true);
    expect(game.keyMenu('Enter')).toBe(true);
    expect(game.menuOpen()).toBe(true);
    expect(game.canvas.focus).toHaveBeenCalledOnce();

    game.match();
    game.pointer('pointerdown', 50, 13, 'touch');
    game.clickMenu('Resume', 13);
    game.pointer('pointermove', 150, 13, 'touch');
    game.pointer('pointerup', 150, 13, 'touch');
    game.pointer('pointerup', 150, 12, 'touch');
    expect(game.menuOpen()).toBe(false);
    expect(game.canvas.focus).toHaveBeenCalledTimes(2);
    expect(snapshot()).toEqual(before);
    expect(move).not.toHaveBeenCalled();

    game.clickMenu('Game menu');
    expect(game.keyMenu('Tab')).toBe(true);
    expect(game.keyMenu('Tab')).toBe(true);
    expect(game.keyMenu('Escape')).toBe(true);
    expect(game.menuOpen()).toBe(false);
    game.match();
    expect(move).toHaveBeenCalledOnce();
    expect(snapshot().current.runId).toBe(before.current.runId);
    expect(snapshot().current.lastAction).toMatchObject({ kind: 'transfer' });
    game.destroy();
    expect(game.menuRoot.destroyed).toBe(true);
    expect(game.canvas.getAttribute('aria-description')).toBeNull();
  });

  it('reserves a full Pixi toolbar row for compact commerce and offsets the board hit coordinates', async () => {
    const game = await setup();
    game.resizeViewport(1366, 768);
    scene.resize.mockClear();
    game.reserveCommerceSpace();
    expect(scene.resize).not.toHaveBeenCalled();
    game.resizeViewport(400, 700);
    expect(game.menuLaunch.position).toMatchObject({ x: 8, y: 6 });
    expect(game.menuSound[0].position).toMatchObject({ x: 60, y: 6 });
    expect(scene.resize).toHaveBeenLastCalledWith(400, 643, 0);
    game.pointer('pointerdown', 50, 1, 'mouse', 1, 200);
    expect(scene.hit.mock.lastCall?.[0]).toEqual({ x: 50, y: 143 });
  });

  it('drops queued input and presentation audio while letting an accepted move settle', async () => {
    const cue = vi.spyOn(GameSound.prototype, 'match');
    const game = await setup();
    game.match();
    game.pointer('pointerdown', 250, 3, 'touch');
    game.pointer('pointerup', 250, 3, 'touch');
    game.pointer('pointerdown', 150, 4, 'touch');
    game.pointer('pointerup', 150, 4, 'touch');
    expect(move).toHaveBeenCalledOnce();

    game.clickMenu('Game menu');
    game.tick(2000);
    game.tick(3000);
    game.tick(4000);
    expect(cue).not.toHaveBeenCalled();
    expect(scene.startStackUnlock.mock.lastCall?.[0]).toMatchObject({ score: 1555, level: 3 });
    expect(move).toHaveBeenCalledOnce();
    game.clickMenu('Resume');
    game.tick(5000);
    expect(move).toHaveBeenCalledOnce();
  });

  it('syncs sound controls and clears delayed game cues even after a quick unmute', async () => {
    const cue = vi.spyOn(GameSound.prototype, 'match');
    const level = vi.spyOn(GameSound.prototype, 'levelUp');
    const game = await setup();
    expect(game.menuSound.map(button => button.accessibleHint)).toEqual(['On', 'On']);
    game.match();
    game.clickMenu('Sound effects');
    expect(game.menuSound.map(button => button.accessibleHint)).toEqual(['Off', 'Off']);
    expect(game.canvas.getAttribute('aria-description')).toContain('Sound effects are off.');
    game.clickMenu('Sound effects');
    expect(game.menuSound.map(button => button.accessibleHint)).toEqual(['On', 'On']);
    game.tick(2000);
    game.tick(3000);
    game.tick(4000);
    expect(cue).not.toHaveBeenCalled();
    expect(level).not.toHaveBeenCalled();
    expect(game.localStorage.setItem).toHaveBeenCalledWith('master-of-donuts-2-reborn.sound.v1', 'off');
    expect(game.localStorage.setItem).toHaveBeenCalledWith('master-of-donuts-2-reborn.sound.v1', 'on');
  });
});

describe('game view monetization', () => {
  const full: GameState = {
    ...initial, score: 1390, combo: 2, movesLeft: 1, gameOver: true,
    stacks: [
      ['red', 'blue', 'red', 'blue', 'blue', 'red'],
      ['red', 'blue', 'red', 'blue', 'red', 'blue'],
      ['red', 'blue', 'red', 'blue', 'red', 'blue'],
    ],
  };
  const terminalAt = 1000 + GAME_OVER_REVEAL_MS;
  const makeMonetization = (...placements: AdPlacement[]) => ({
    available: vi.fn((placement: AdPlacement) => placements.includes(placement)),
    request: vi.fn<GameMonetization['request']>().mockResolvedValue({ status: 'unavailable', attempted: false }),
    setPlaying: vi.fn<GameMonetization['setPlaying']>(),
    runCompleted: vi.fn<GameMonetization['runCompleted']>(),
  });
  const openTerminal = async (game: Awaited<ReturnType<typeof setup>>, terminal = full, start = 0) => {
    vi.mocked(move).mockReturnValueOnce(terminal);
    game.match();
    game.tick(start + 1000);
    await settleResults();
    finishGameOverReveal(game.tick, start + 1000);
  };

  it('counts foreground play transitions between frames and pauses for a purchase modal', async () => {
    const monetization = makeMonetization();
    const game = await setup(true, '', 1, undefined, undefined, monetization);
    game.setOtherModalOpen(true);
    game.tap(50);
    game.tap(150);
    expect(move).not.toHaveBeenCalled();
    game.setOtherModalOpen(false);
    game.window.dispatchEvent(new Event('blur'));
    game.document.hidden = true;
    game.document.dispatchEvent(new Event('visibilitychange'));
    game.window.dispatchEvent(new Event('focus'));
    expect(monetization.setPlaying.mock.calls).toEqual([[true], [false], [true], [false]]);
    game.document.hidden = false;
    game.document.dispatchEvent(new Event('visibilitychange'));
    await openTerminal(game);
    expect(monetization.setPlaying.mock.calls).toEqual([[true], [false], [true], [false], [true], [false]]);
    expect(monetization.runCompleted).toHaveBeenCalledOnce();
  });

  it('pauses the gameplay clock and preserves terminal ad and results flow', async () => {
    const monetization = makeMonetization('extra-chance');
    const game = await setup(true, '', 1, undefined, undefined, monetization);
    game.clickMenu('Game menu');
    expect(game.menuOpen()).toBe(true);
    expect(monetization.setPlaying.mock.calls).toEqual([[true], [false]]);
    game.tick(5000);
    expect(monetization.request).not.toHaveBeenCalled();
    game.clickMenu('Resume');
    expect(monetization.setPlaying.mock.calls).toEqual([[true], [false], [true]]);
    game.setOtherModalOpen(true);
    game.clickMenu('Game menu');
    expect(game.menuOpen()).toBe(false);
    game.setOtherModalOpen(false);
    await openTerminal(game, full, 5000);
    expect(game.menuRoot.visible).toBe(false);
    expect(game.dialog.open).toBe(true);
    game.clickMenu('Game menu');
    expect(game.menuOpen()).toBe(false);
    expect(game.dialog.open).toBe(true);
    expect(game.clickDialog('Skip · See results')).toBe(true);
    await settleResults();
    game.tick(12000);
    expect(scene.showResults.mock.lastCall?.[0]).not.toBeNull();
    expect(game.onResultsVisibilityChange).toHaveBeenLastCalledWith(true);
  });

  it('leases one Play Again for the current results and waits through host pause, hide and blur', async () => {
    const monetization = makeMonetization('play-again');
    let settle!: (outcome: AdOutcome) => void;
    monetization.request.mockImplementation((_placement, ad) => {
      expect(ad.canShow()).toBe(true);
      ad.onAttempt();
      return new Promise(resolve => { settle = resolve; });
    });
    const game = await setup(true, '', 1, undefined, undefined, monetization);
    await openTerminal(game);
    const outgoing = scene.showResults.mock.lastCall?.[0];
    const stop = vi.spyOn(GameSound.prototype, 'stop');
    game.tap(300);
    game.tap(300);
    expect(monetization.request).toHaveBeenCalledExactlyOnceWith('play-again', expect.any(Object));
    expect(monetization.runCompleted).toHaveBeenCalledBefore(monetization.request);
    expect(stop).toHaveBeenCalledOnce();
    expect(scene.showResults).toHaveBeenLastCalledWith(outgoing);
    const ad = monetization.request.mock.lastCall![1];
    game.suspendFromHost();
    game.window.dispatchEvent(new Event('blur'));
    game.document.hidden = true;
    game.document.dispatchEvent(new Event('visibilitychange'));
    expect(ad.isCurrent()).toBe(true);
    expect(ad.canShow()).toBe(false);
    settle({ status: 'completed', attempted: true });
    await settleResults();
    game.document.hidden = false;
    game.document.dispatchEvent(new Event('visibilitychange'));
    expect(scene.showResults).toHaveBeenLastCalledWith(outgoing);
    expect(createGame).toHaveBeenCalledOnce();
    game.window.dispatchEvent(new Event('focus'));
    game.window.dispatchEvent(new Event('focus'));
    expect(scene.showResults).toHaveBeenLastCalledWith(null);
    expect(createGame).toHaveBeenCalledTimes(2);
    expect(ad.isCurrent()).toBe(false);
    expect(game.localStorage.setItem).toHaveBeenCalledOnce();
  });

  it('keeps a no-fill check silent and restarts immediately when it resolves', async () => {
    const monetization = makeMonetization('play-again');
    const game = await setup(true, '', 1, undefined, undefined, monetization);
    await openTerminal(game);
    const stop = vi.spyOn(GameSound.prototype, 'stop');
    game.tap(300);
    expect(stop).not.toHaveBeenCalled();
    expect(createGame).toHaveBeenCalledOnce();
    await settleResults();
    expect(scene.showResults).toHaveBeenLastCalledWith(null);
    expect(createGame).toHaveBeenCalledTimes(2);
  });

  it('offers a foreground return if the host pauses before the ad ever starts', async () => {
    const monetization = makeMonetization('extra-chance');
    let settle!: (outcome: AdOutcome) => void;
    monetization.request.mockImplementation(() => new Promise(resolve => { settle = resolve; }));
    const game = await setup(true, '', 1, undefined, undefined, monetization);
    await openTerminal(game);
    game.clickDialog('Watch ad');
    const ad = monetization.request.mock.lastCall![1];
    game.suspendFromHost();
    expect(ad.isCurrent()).toBe(true);
    expect(ad.canShow()).toBe(false);
    settle({ status: 'unavailable', attempted: false });
    await settleResults();
    expect(game.localStorage.setItem).not.toHaveBeenCalled();
    expect(game.clickDialog('Return to game')).toBe(true);
    await settleResults();
    game.tick(terminalAt + 16);
    expect(scene.showResults.mock.lastCall?.[0]?.personal.run.score).toBe(full.score);
    expect(game.localStorage.setItem).toHaveBeenCalledOnce();
  });

  it('preserves booster inventory and best combo across a successful Extra Chance and records the final run once', async () => {
    vi.stubEnv('MODE', 'board-debug');
    const monetization = makeMonetization('extra-chance');
    let settle!: (outcome: AdOutcome) => void;
    monetization.request.mockImplementation((_placement, ad) => {
      ad.onAttempt();
      return new Promise(resolve => { settle = resolve; });
    });
    const friends = { list: vi.fn(async () => []), submit: vi.fn(async () => {}) };
    getFriendsScores.mockReturnValue(friends);
    scene.hit.mockImplementation(({ x }: Point) => {
      const last = scene.draw.mock.lastCall?.[0];
      if (!last?.gameOver) return Math.floor(x / 100);
      return x === 300 ? 'restart' : x === 320 ? 'friends' : x === 340 ? 'submit' : null;
    });
    const game = await setup(true, '', 1, undefined, undefined, monetization);
    vi.spyOn(Math, 'random').mockReturnValueOnce(0.25);
    vi.mocked(move).mockReturnValueOnce({ ...initial, combo: 5 });
    game.match();
    game.tick(1000);
    vi.mocked(move).mockReturnValueOnce(full);
    game.match();
    const read = game.window.rebornBoardSnapshot!;
    const terminalSnapshot = read();
    game.tick(2000);
    await settleResults();
    game.tick(2249);
    expect(game.dialog.open).toBe(false);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(null, true);
    game.tick(2250);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(0, true);
    game.tick(2750);
    expect(game.dialog.open).toBe(false);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(null, true);
    game.tick(6499);
    expect(game.dialog.open).toBe(false);
    game.tick(6500);
    expect(game.dialog.open).toBe(true);
    expect(game.dialog.children[0].textContent).toBe('Extra Chance');
    expect(game.localStorage.setItem).not.toHaveBeenCalled();
    expect(getFriendsScores).not.toHaveBeenCalled();
    expect(monetization.runCompleted).not.toHaveBeenCalled();
    expect(game.clickDialog('Watch ad')).toBe(true);
    expect(game.clickDialog('Watch ad')).toBe(false);
    expect(monetization.request).toHaveBeenCalledExactlyOnceWith('extra-chance', expect.any(Object));
    game.window.dispatchEvent(new Event('blur'));
    settle({ status: 'completed', attempted: true });
    await settleResults();
    expect(scene.draw.mock.lastCall?.[0]).toBe(full);
    expect(read()).toEqual(terminalSnapshot);
    game.window.dispatchEvent(new Event('focus'));
    const revived = scene.draw.mock.lastCall?.[0];
    expect(revived).toMatchObject({ ...full, gameOver: false, doughMeter: 21, stacks: expect.any(Array) });
    expect(scene.startMoveRecovery).toHaveBeenLastCalledWith({ source: 'extra', restored: 7, remaining: 7 }, expect.any(Number), true);
    expect(revived?.stacks).not.toEqual(full.stacks);
    expect(read()).toMatchObject({ current: { runId: terminalSnapshot.current.runId, gameOver: false,
      lastAction: { kind: 'extra-chance', refillInsertions: [] } }, lastGameOver: terminalSnapshot.lastGameOver });
    expect(scene.setBoosterControls.mock.lastCall?.[0].joker.mode).toBe('free');
    expect(createGame).toHaveBeenCalledOnce();
    expect(game.localStorage.setItem).not.toHaveBeenCalled();

    const next = { ...full, score: 1480, combo: 3 };
    vi.mocked(move).mockReturnValueOnce(next);
    game.tap(150);
    game.tap(50);
    game.tick(terminalAt + 2000);
    await settleResults();
    finishGameOverReveal(game.tick, terminalAt + 2000);
    expect(game.dialog.open).toBe(false);
    expect(monetization.runCompleted).toHaveBeenCalledOnce();
    expect(game.localStorage.setItem).toHaveBeenCalledOnce();
    expect(scene.showResults.mock.lastCall?.[0]?.personal.run).toEqual({ score: 1480, level: 2, bestCombo: 5 });
    expect(getFriendsScores).toHaveBeenCalledOnce();
    game.tap(320);
    game.tap(340);
    game.tap(340);
    expect(friends.submit).toHaveBeenCalledExactlyOnceWith(1480);
    game.tap(300);
    expect(monetization.request).toHaveBeenCalledOnce();
    expect(createGame).toHaveBeenCalledTimes(2);
  });

  it.each(['skip', 'unavailable', 'failed', 'cancelled', 'unconfirmed completion'] as const)(
    'finalizes an unchanged terminal on %s', async result => {
      const monetization = makeMonetization('extra-chance');
      const game = await setup(true, '', 1, undefined, undefined, monetization);
      await openTerminal(game);
      expect(game.localStorage.setItem).not.toHaveBeenCalled();
      if (result === 'skip') {
        expect(game.clickDialog('Skip · See results')).toBe(true);
        expect(monetization.request).not.toHaveBeenCalled();
      } else {
        const status = result === 'unconfirmed completion' ? 'completed' : result;
        monetization.request.mockResolvedValue({ status, attempted: false });
        expect(game.clickDialog('Watch ad')).toBe(true);
      }
      await settleResults();
      game.tick(terminalAt + 16);
      expect(game.dialog.open).toBe(false);
      expect(scene.draw.mock.lastCall?.[0]).toBe(full);
      expect(scene.showResults.mock.lastCall?.[0]?.personal.run.score).toBe(full.score);
      expect(game.localStorage.setItem).toHaveBeenCalledOnce();
      expect(monetization.runCompleted).toHaveBeenCalledOnce();
    },
  );

  it('suppresses Extra Chance for an undersized board with no possible rescue', async () => {
    const monetization = makeMonetization('extra-chance');
    const game = await setup(true, '', 1, undefined, undefined, monetization);
    await openTerminal(game, { ...full, stacks: [['blue']] });
    expect(game.dialog.open).toBe(false);
    expect(monetization.request).not.toHaveBeenCalled();
    expect(game.localStorage.setItem).toHaveBeenCalledOnce();
    expect(scene.showResults.mock.lastCall?.[0]?.personal.run.score).toBe(full.score);
  });

  it.each(['pending', 'revived'] as const)('finalizes the %s terminal on teardown and fences late callbacks', async phase => {
    const monetization = makeMonetization('extra-chance');
    let settle!: (outcome: AdOutcome) => void;
    monetization.request.mockImplementation((_placement, ad) => {
      ad.onAttempt();
      return new Promise(resolve => { settle = resolve; });
    });
    const game = await setup(true, '', 1, undefined, undefined, monetization);
    await openTerminal(game);
    game.clickDialog('Watch ad');
    if (phase === 'revived') {
      settle({ status: 'completed', attempted: true });
      await settleResults();
      expect(scene.draw.mock.lastCall?.[0].gameOver).toBe(false);
    }
    expect(game.localStorage.setItem).not.toHaveBeenCalled();
    game.destroy();
    const ad = monetization.request.mock.lastCall![1];
    expect(ad.isCurrent()).toBe(false);
    ad.onRecovery(vi.fn());
    const draws = scene.draw.mock.calls.length;
    settle({ status: 'completed', attempted: true });
    await settleResults();
    expect(scene.draw).toHaveBeenCalledTimes(draws);
    expect(game.localStorage.setItem).toHaveBeenCalledOnce();
    expect(monetization.runCompleted).toHaveBeenCalledOnce();
  });

  it('keeps a cached page provisional, then finalizes the terminal on permanent pagehide', async () => {
    const monetization = makeMonetization('extra-chance');
    const game = await setup(true, '', 1, undefined, undefined, monetization);
    await openTerminal(game);
    game.window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: true }));
    game.window.dispatchEvent(new Event('pageshow'));
    await settleResults();
    expect(game.localStorage.setItem).not.toHaveBeenCalled();
    expect(game.dialog.open).toBe(true);
    game.window.dispatchEvent(Object.assign(new Event('pagehide'), { persisted: false }));
    game.destroy();
    await settleResults();
    expect(game.localStorage.setItem).toHaveBeenCalledOnce();
    expect(monetization.runCompleted).toHaveBeenCalledOnce();
  });

  it('rejects a completion arriving after Extra Chance expired, even before recovery input', async () => {
    const monetization = makeMonetization('extra-chance');
    let settle!: (outcome: AdOutcome) => void;
    monetization.request.mockImplementation((_placement, ad) => {
      ad.onAttempt();
      return new Promise(resolve => { settle = resolve; });
    });
    const game = await setup(true, '', 1, undefined, undefined, monetization);
    await openTerminal(game);
    game.clickDialog('Watch ad');
    const ad = monetization.request.mock.lastCall![1];
    const recover = vi.fn();
    ad.onRecovery(recover);
    expect(game.dialog.open).toBe(true);
    ad.onRecovery();
    settle({ status: 'completed', attempted: true });
    await settleResults();
    game.tick(terminalAt + 16);
    expect(game.dialog.open).toBe(false);
    expect(recover).not.toHaveBeenCalled();
    expect(scene.draw.mock.lastCall?.[0]).toBe(full);
    expect(game.localStorage.setItem).toHaveBeenCalledOnce();
  });

  it.each(['play-again', 'extra-chance', 'joker', 'sweep'] as const)('recovers a stalled %s only on foreground input', async placement => {
    const monetization = makeMonetization(placement);
    let settle!: (outcome: AdOutcome) => void;
    monetization.request.mockImplementation((_placement, ad) => {
      ad.onAttempt();
      return new Promise(resolve => { settle = resolve; });
    });
    const game = await setup(true, '', 1, undefined, undefined, monetization);
    if (placement === 'joker' || placement === 'sweep') {
      game.tap(250);
      game.tap(50);
      game.tick(45_000);
      game.tap(placement === 'joker' ? 397 : 396);
      expect(game.clickDialog('Watch ad')).toBe(true);
    } else {
      await openTerminal(game);
      if (placement === 'play-again') game.tap(300);
      else expect(game.clickDialog('Watch ad')).toBe(true);
    }
    const ad = monetization.request.mock.lastCall![1];
    const recover = vi.fn(() => settle({ status: 'completed', attempted: true }));
    game.suspendFromHost();
    game.window.dispatchEvent(new Event('blur'));
    ad.onRecovery(recover);
    expect(game.clickDialog('Return to game')).toBe(false);
    game.window.dispatchEvent(new Event('focus'));
    expect(game.clickDialog('Return to game')).toBe(true);
    expect(game.clickDialog('Return to game')).toBe(false);
    expect(recover).toHaveBeenCalledOnce();
    await settleResults();
    expect(ad.isCurrent()).toBe(false);
    if (placement === 'play-again') expect(createGame).toHaveBeenCalledTimes(2);
    else if (placement === 'extra-chance') {
      game.tick(terminalAt + 16);
      expect(scene.draw.mock.lastCall?.[0]).toBe(full);
      expect(game.localStorage.setItem).toHaveBeenCalledOnce();
    } else {
      expect(scene.setBoosterControls.mock.lastCall?.[0][placement].mode).toBe('ad');
    }
  });
});

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

  const footer = () => scene.setBoosterControls.mock.lastCall![0];

  it('starts on the first move and pauses the shared ad fill while hidden', async () => {
    const watch = vi.fn<() => Promise<AdOutcome>>();
    const { document, tap, tick } = await setup(true, '', 1, undefined, watch);
    tick(60_000);
    expect(footer()).toMatchObject({ progress: 0, joker: { mode: 'charging' }, sweep: { mode: 'charging' } });
    tap(397);
    expect(watch).not.toHaveBeenCalled();
    tap(250);
    tap(50);
    tick(75_000);
    expect(footer().progress).toBe(0.33);

    document.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    tick(150_000);
    document.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    tick(150_000);
    expect(footer().progress).toBe(0.33);
    tick(179_999);
    expect(footer().joker.mode).toBe('charging');
    tick(180_000);
    expect(footer()).toMatchObject({ progress: 1, joker: { mode: 'ad' }, sweep: { mode: 'ad' } });
  });

  it.each(['mouse', 'touch'])('claims and uses a Joker only on complete %s releases', async pointerType => {
    vi.stubEnv('MODE', 'board-debug');
    const board = { ...initial, stacks: [['red', 'blue', 'green'], [], ['gold', 'gold', 'red'], ['gold']], combo: 3 };
    vi.mocked(createGame).mockReturnValueOnce(board);
    const watch = vi.fn(async (isCurrent: () => boolean): Promise<AdOutcome> => {
      expect(isCurrent()).toBe(true);
      return { status: 'completed', attempted: true };
    });
    const { pointer, tap, tick, clickDialog, window } = await setup(false, '', 1, undefined, watch);
    const press = (x: number, id = 1) => pointer('pointerdown', x, id, pointerType, 1);
    const release = (x: number, id = 1) => pointer('pointerup', x, id, pointerType);
    const click = (x: number) => { press(x); release(x); };
    tap(50);
    tap(350);
    tick(45_000);
    const read = window.rebornBoardSnapshot!;
    const beforeClaim = read();

    press(397);
    expect(watch).not.toHaveBeenCalled();
    release(50);
    expect(watch).not.toHaveBeenCalled();
    click(397);
    expect(watch).not.toHaveBeenCalled();
    expect(clickDialog('Cancel')).toBe(true);
    expect(watch).not.toHaveBeenCalled();
    click(397);
    expect(clickDialog('Watch ad')).toBe(true);
    expect(clickDialog('Watch ad')).toBe(false);
    await settleResults();
    const claimed = scene.draw.mock.lastCall![0];
    expect(claimed.stacks).toEqual([['red', 'blue'], [], ['gold', 'gold', 'red'], ['gold', 'green']]);
    expect(footer()).toMatchObject({ progress: 0, joker: { mode: 'held', usable: true }, armed: false });
    click(397);
    expect(footer().armed).toBe(true);
    click(150);
    press(50);
    pointer('pointermove', 250, 1, pointerType, 1);
    release(250);
    expect(scene.draw.mock.lastCall?.[0]).toBe(claimed);
    expect(footer().armed).toBe(true);
    click(397);
    expect(footer().armed).toBe(false);

    click(397);
    press(50);
    release(50, 2);
    expect(scene.startBoosterCue).not.toHaveBeenCalled();
    expect(read()).toEqual(beforeClaim);
    release(50);
    expect(scene.draw.mock.lastCall?.[0]).toMatchObject({
      ...claimed, stacks: [['red', JOKER], [], ['gold', 'gold', 'red'], ['gold', 'green']],
    });
    expect(scene.startBoosterCue).toHaveBeenLastCalledWith('joker', [{ stack: 0, color: 'blue' }], 45_000, false);
    expect(read().current.lastAction).toEqual({ kind: 'joker', stackIndex: 0, refillInsertions: [] });
    tick(45_230);
    click(397);
    expect(watch).toHaveBeenCalledOnce();
    expect(scene.startBoosterCue).toHaveBeenCalledOnce();
    expect(footer().joker).toEqual({ mode: 'charging', usable: false });
  });

  it('locks input while showing an ad, and leaves the offer available after cancellation or failure', async () => {
    let resolveAd!: (value: AdOutcome) => void;
    const watch = vi.fn<(isCurrent: () => boolean) => Promise<AdOutcome>>()
      .mockImplementationOnce(() => new Promise(resolve => { resolveAd = resolve; }))
      .mockRejectedValueOnce(Error('No fill'))
      .mockResolvedValueOnce({ status: 'completed', attempted: true });
    const { tap, tick, suspendFromHost, clickDialog } = await setup(true, '', 1, undefined, watch);
    tap(250);
    tap(50);
    tick(45_000);
    tap(396);
    expect(clickDialog('Watch ad')).toBe(true);
    expect(footer()).toMatchObject({ progress: 1, sweep: { mode: 'loading', usable: false } });
    tap(397);
    tap(50);
    tap(250);
    expect(watch).toHaveBeenCalledOnce();
    expect(move).toHaveBeenCalledOnce();
    tick(80_000);
    resolveAd({ status: 'cancelled', attempted: true });
    await settleResults();
    expect(footer()).toMatchObject({ progress: 1, adUnavailable: false, sweep: { mode: 'ad' } });
    tap(396);
    expect(clickDialog('Watch ad')).toBe(true);
    await settleResults();
    expect(footer()).toMatchObject({ progress: 1, adUnavailable: true, sweep: { mode: 'ad' } });

    watch.mockImplementationOnce(async () => ({ status: 'completed', attempted: true }));
    tap(396);
    expect(clickDialog('Watch ad')).toBe(true);
    suspendFromHost();
    await settleResults();
    expect(footer()).toMatchObject({ progress: 0, adUnavailable: false, sweep: { mode: 'held', usable: true } });
    expect(scene.startBoosterCue).not.toHaveBeenCalled();
    tap(396);
    expect(scene.startBoosterCue).toHaveBeenCalledOnce();
    tick(80_230);
    expect(footer().sweep).toEqual({ mode: 'charging', usable: false });
  });

  it('announces a free Sweep at 5× after score credit and wakes once to end the reduced-motion hold', async () => {
    vi.stubEnv('MODE', 'board-debug');
    const board = {
      ...initial, score: 0, nextLevelScore: 5000, combo: 4, doughMeter: 12,
      stacks: [['red'], ['red', 'red'], [JOKER, 'blue']],
    };
    vi.mocked(createGame).mockReturnValueOnce(board);
    const { match, tap, tick, render, window } = await setup(true);
    expect(footer()).toMatchObject({ sweep: { mode: 'locked' } });
    match();
    tick(229);
    expect(scene.startFreeBoosterCelebration).not.toHaveBeenCalled();
    tick(230);
    expect(scene.creditScore).toHaveBeenCalledExactlyOnceWith(230, true);
    tick(419);
    expect(scene.startFreeBoosterCelebration).not.toHaveBeenCalled();
    tick(420);
    expect(scene.startFreeBoosterCelebration).toHaveBeenCalledExactlyOnceWith('sweep', 420, true);
    const revealPainted = render.mock.calls.length;
    tick(1069);
    expect(render).toHaveBeenCalledTimes(revealPainted);
    tick(1070);
    expect(render).toHaveBeenCalledTimes(revealPainted + 1);
    tick(2000);
    const before = scene.draw.mock.lastCall![0];
    expect(before).toMatchObject({ combo: 5, doughMeter: 11 });
    expect(footer().sweep).toEqual({ mode: 'free', usable: true });
    expect(scene.startBoosterCue).not.toHaveBeenCalled();
    tap(396);
    const [flavor] = before.stacks[0];
    expect(scene.draw.mock.lastCall?.[0]).toMatchObject({
      ...before, stacks: [[flavor, flavor], [], [JOKER]],
    });
    expect(scene.startBoosterCue).toHaveBeenLastCalledWith('sweep', expect.any(Array), 2000, true);
    expect(window.rebornBoardSnapshot!().current.lastAction).toEqual({ kind: 'sweep', refillInsertions: [
      { stack: 0, depth: 1, color: flavor },
    ] });
    expect(footer().sweep).toEqual({ mode: 'locked', usable: false });
    tick(2016);
    tick(2150);
    const cuePainted = render.mock.calls.length;
    tick(2229);
    expect(render).toHaveBeenCalledTimes(cuePainted);
    tick(2230);
    expect(render).toHaveBeenCalledTimes(cuePainted + 1);
    tick(3000);
    expect(render).toHaveBeenCalledTimes(cuePainted + 1);
  });

  it.each([[0.25, 'joker'], [0.75, 'sweep']] as const)(
    'announces and displays the actual free booster after the same fifth match with roll %f', async (roll, kind) => {
      const flavors = ['red', 'blue', 'green', 'gold', 'yellow', 'purple', 'choco', 'gray'];
      const stacks = flavors.map((_, index) => Array.from({ length: index === 1 || index === 6 ? 9 : 10 },
        (_, depth) => flavors[(index + depth) % flavors.length]));
      stacks[5][9] = 'red';
      stacks[6][7] = stacks[6][8] = 'red';
      const board = { ...initial, stacks, combo: 4, capacity: 10, level: 16, score: 34_000, nextLevelScore: 38_300 };
      vi.mocked(createGame).mockReturnValueOnce(board);
      const { tap, tick } = await setup();
      const refillRng = vi.fn(() => 0);
      const expected = vi.mocked(move).getMockImplementation()!(board, 5, 6, refillRng);
      const rng = vi.spyOn(Math, 'random').mockReturnValue(roll);
      for (const _ of refillRng.mock.calls) rng.mockReturnValueOnce(0);
      tap(550);
      tap(650);
      tick(540);
      tick(850);

      expect(expected).toMatchObject({ score: 34_350, combo: 5 });
      expect(scene.draw.mock.lastCall?.[0]).toEqual(expected);
      expect(rng).toHaveBeenCalledTimes(refillRng.mock.calls.length + 1);
      expect(footer()[kind]).toEqual({ mode: 'free', usable: true });
      expect(footer()[kind === 'joker' ? 'sweep' : 'joker'].mode).toBe('locked');
      expect(scene.startFreeBoosterCelebration).toHaveBeenCalledExactlyOnceWith(kind, 850, false);
    },
  );

  it('announces a free Joker after the same match’s level celebration and keeps stack input live', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.mocked(createGame).mockReturnValueOnce({ ...initial, combo: 4 });
    const game = await setup();
    game.match();
    game.tick(540);
    game.tick(850);
    expect(scene.creditScore).toHaveBeenCalledExactlyOnceWith(850, false);
    const levelAt = Math.max(game.unlockEnds, game.refillEnds, 1005);
    game.tick(levelAt);
    expect(scene.startLevelCelebration).toHaveBeenCalledOnce();
    game.tick(levelAt + LEVEL_CELEBRATION_MS - 1);
    expect(scene.startFreeBoosterCelebration).not.toHaveBeenCalled();
    game.tick(levelAt + LEVEL_CELEBRATION_MS);
    expect(scene.startFreeBoosterCelebration).toHaveBeenCalledExactlyOnceWith('joker', levelAt + LEVEL_CELEBRATION_MS, false);
    expect(footer().joker.mode).toBe('free');
    game.tap(50);
    game.tap(350);
    expect(move).toHaveBeenCalledTimes(2);
  });

  it('keeps the two held ad boosters and skips the reveal when a 5× award finds both slots full', async () => {
    const board = { ...initial, combo: 4, nextLevelScore: 5000 };
    vi.mocked(createGame).mockReturnValueOnce(board);
    vi.mocked(move).mockReturnValueOnce({ ...board });
    const watch = vi.fn<() => Promise<AdOutcome>>().mockResolvedValue({ status: 'completed', attempted: true });
    const { tap, match, tick, clickDialog } = await setup(true, '', 1, undefined, watch);
    tap(250);
    tap(50);
    tick(45_000);
    tap(397);
    expect(clickDialog('Watch ad')).toBe(true);
    await settleResults();
    tick(120_000);
    tap(396);
    expect(clickDialog('Watch ad')).toBe(true);
    await settleResults();
    expect(footer()).toMatchObject({ joker: { mode: 'held' }, sweep: { mode: 'held' } });

    match();
    tick(121_000);
    expect(scene.draw.mock.lastCall?.[0].combo).toBe(5);
    expect(scene.startFreeBoosterCelebration).not.toHaveBeenCalled();
    expect(footer()).toMatchObject({ joker: { mode: 'held' }, sweep: { mode: 'held' } });
  });

  it.each(['blur', 'resize'])('cancels an uncredited Joker reveal on %s and retains the award', async reason => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.mocked(createGame).mockReturnValueOnce({ ...initial, combo: 4, nextLevelScore: 5000 });
    const game = await setup();
    game.match();
    game.tick(540);
    if (reason === 'blur') {
      game.window.dispatchEvent(new Event('blur'));
      game.window.dispatchEvent(new Event('focus'));
    } else game.resizeViewport(380, 680);
    game.tick(2000);
    expect(scene.startFreeBoosterCelebration).not.toHaveBeenCalled();
    expect(footer().joker).toEqual({ mode: 'free', usable: true });
  });

  it('dismisses the free-booster reveal when the awarded booster is used during its hold', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    vi.mocked(createGame).mockReturnValueOnce({ ...initial, combo: 4, nextLevelScore: 5000 });
    const { match, tap, tick } = await setup();
    match();
    tick(540);
    tick(850);
    expect(scene.startFreeBoosterCelebration).toHaveBeenCalledExactlyOnceWith('joker', 850, false);
    tap(397);
    tap(50);
    expect(scene.startBoosterCue).toHaveBeenCalledOnce();
    expect(scene.cancelFreeBoosterCelebration).toHaveBeenLastCalledWith('joker');
    expect(scene.freeBoosterDeadline).toBe(0);
    expect(footer().joker.mode).toBe('locked');
  });

  it('skips the pending reveal when the free Sweep is used before the reduced-motion score label clears', async () => {
    vi.mocked(createGame).mockReturnValueOnce({
      ...initial, score: 0, nextLevelScore: 5000, combo: 4,
      stacks: [['red'], ['red', 'red'], [JOKER, 'blue']],
    });
    const game = await setup(true);
    game.match();
    game.tick(230);
    expect(game.refillEnds).toBeLessThan(420);
    game.tick(game.refillEnds);
    game.tap(396);
    expect(scene.startBoosterCue).toHaveBeenCalledOnce();
    game.tick(420);
    expect(scene.startFreeBoosterCelebration).not.toHaveBeenCalled();
    expect(footer().sweep.mode).toBe('locked');
  });

  it('drops incomplete booster presses across resize and resume without using inventory', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const board = { ...initial, combo: 4, nextLevelScore: 5000 };
    vi.mocked(createGame).mockReturnValueOnce(board);
    const { document, match, pointer, resizeViewport, tap, tick } = await setup(true);
    match();
    tick(1000);
    tick(2000);
    expect(footer().joker).toEqual({ mode: 'free', usable: true });
    tap(397);
    pointer('pointerdown', 50, 1, 'touch');
    resizeViewport(400, 665);
    pointer('pointerup', 50, 1, 'touch');
    expect(footer().armed).toBe(false);
    expect(scene.startBoosterCue).not.toHaveBeenCalled();

    pointer('pointerdown', 397, 1, 'touch');
    document.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    document.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    pointer('pointerup', 397, 1, 'touch');
    tick(2016);
    expect(footer().armed).toBe(false);
    expect(footer().joker).toEqual({ mode: 'free', usable: true });
    tap(397);
    tap(50);
    expect(scene.startBoosterCue).toHaveBeenCalledOnce();
    const boosted = scene.draw.mock.lastCall![0];
    resizeViewport(420, 665);
    expect(scene.boosterCueDeadline).toBe(0);
    expect(scene.draw.mock.lastCall?.[0]).toBe(boosted);
    expect(footer().joker).toEqual({ mode: 'locked', usable: false });
  });

  it('resets the free drop and ad timer at Play Again', async () => {
    vi.spyOn(Math, 'random').mockReturnValue(0);
    const board = { ...initial, combo: 4, nextLevelScore: 5000 };
    const watch = vi.fn<() => Promise<AdOutcome>>();
    vi.mocked(createGame).mockReturnValueOnce(board);
    const { match, tap, tick } = await setup(true, '', 1, undefined, watch);
    match();
    tick(1000);
    tick(15_000);
    const active = scene.draw.mock.lastCall![0];
    expect(footer()).toMatchObject({ progress: 0.33, joker: { mode: 'free', usable: true } });
    vi.mocked(move).mockReturnValueOnce({ ...active, gameOver: true });
    tap(250);
    tap(50);
    expect(footer().visible).toBe(false);
    await settleResults();
    tick(16_000);
    finishGameOverReveal(tick, 16_000);
    tap(300);
    expect(scene.draw.mock.lastCall?.[0]).toBe(initial);
    expect(footer()).toMatchObject({ visible: true, progress: 0, joker: { mode: 'charging' }, sweep: { mode: 'charging' } });
    expect(watch).not.toHaveBeenCalled();
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
    finishGameOverReveal(tick, 1370);
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

  it('refreshes layout when only the safe area changes', async () => {
    const { resizeViewport } = await setup();
    expect(scene.resize).toHaveBeenLastCalledWith(400, 700, 0);
    resizeViewport(400, 700, 34);
    expect(scene.resize).toHaveBeenLastCalledWith(400, 700, 34);
    resizeViewport(400, 700);
    expect(scene.resize).toHaveBeenCalledTimes(3);
    expect(scene.resize).toHaveBeenLastCalledWith(400, 700, 0);
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

  it.each([
    { label: 'touch motion in the gap', device: 'touch', drift: [172], release: 173, preview: 1, destination: 1 },
    { label: 'touch drift reported only at release', device: 'touch', drift: [], release: 173, preview: 1, destination: 1 },
    { label: 'slight mouse drift', device: 'mouse', drift: [161], release: 162, preview: 1, destination: 1 },
    { label: 'touch drift beyond the tolerance', device: 'touch', drift: [166, 176, 169], release: 169, preview: null, destination: null },
    { label: 'release over a different stack', device: 'touch', drift: [198], release: 200, preview: 2, destination: 2 },
    { label: 'return to the source', device: 'touch', drift: [50], release: 50, preview: null, destination: null },
    { label: 'drag onto the Hint control', device: 'touch', drift: [166], release: 166, preview: null, destination: null },
  ])('keeps the preview and swipe result aligned for $label', async ({ device, drift, release, preview, destination, label }) => {
    scene.hit.mockImplementation(({ x }: Point) => {
      if (label === 'drag onto the Hint control' && x === 166) return 'hint';
      if (x < 100) return 0;
      if (x <= 155) return 1;
      return x >= 190 ? 2 : null;
    });
    const { pointer } = await setup(true);
    pointer('pointerdown', 50, 1, device, 1);
    pointer('pointermove', 150, 1, device, 1);
    expect(scene.showInteraction.mock.lastCall?.[1]).toMatchObject({ destination: 1, blocked: false });
    for (const x of drift) pointer('pointermove', x, 1, device, 1);
    const arrow = scene.showInteraction.mock.lastCall?.[1];
    if (preview === null) expect(arrow).toBeNull();
    else expect(arrow).toMatchObject({ destination: preview, blocked: false });

    pointer('pointerup', release, 1, device);
    expect(vi.mocked(move).mock.calls.map(([, from, to]) => [from, to])).toEqual(
      destination === null ? [] : [[0, destination]],
    );
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

  it.each(['mouse', 'touch'])('replays rapid %s pairs in order against the board left by the previous move', async type => {
    const fullStack = ['green', 'blue', 'yellow', 'green', 'blue', 'yellow'];
    vi.mocked(createGame).mockReturnValueOnce({
      ...initial, nextLevelScore: 5000, stacks: [...initial.stacks.slice(0, 2), fullStack],
    });
    const { match, pointer, tick } = await setup();
    const tap = (x: number) => {
      pointer('pointerdown', x, 4, type);
      pointer('pointerup', x, 4, type);
    };

    match();
    tick(100);
    for (const x of [250, 50, 50, 250, 250, 50]) tap(x);
    expect(move).toHaveBeenCalledTimes(1);

    tick(540);
    tick(556);
    tick(572);
    expect(vi.mocked(move).mock.calls.map(([, from, to]) => [from, to])).toEqual([
      [0, 1], [2, 0], [0, 2], [2, 0],
    ]);
    expect(vi.mocked(move).mock.calls.slice(1).map(([state]) => state.stacks[2].length)).toEqual([6, 5, 6]);
    expect(scene.draw.mock.lastCall?.[0].stacks[2]).toEqual(fullStack.slice(0, -1));
    expect(scene.startMoveCost.mock.calls.map(([to]) => to)).toEqual([0, 2, 0]);
  });

  it('keeps touch destination grace when the source tap is still queued', async () => {
    vi.mocked(createGame).mockReturnValueOnce({ ...initial, nextLevelScore: 5000 });
    scene.hit.mockImplementation(({ x }: Point) => x === 63 ? 1 : Math.floor(x / 100));
    const { match, pointer, tick } = await setup();
    match();
    tick(100);
    pointer('pointerdown', 250, 4, 'touch');
    pointer('pointerup', 250, 4, 'touch');
    pointer('pointerdown', 50, 5, 'touch');
    pointer('pointermove', 63, 5, 'touch');
    pointer('pointerup', 63, 5, 'touch');

    tick(540);
    expect(vi.mocked(move).mock.calls.map(([, from, to]) => [from, to])).toEqual([[0, 1], [2, 0]]);
  });

  it('holds remaining queued pairs when a queued move starts another match', async () => {
    vi.mocked(createGame).mockReturnValueOnce({
      ...initial, score: 0, nextLevelScore: 5000,
      stacks: [['blue', 'red'], ['green', 'red', 'red'], ['yellow', 'blue'], ['gold', 'blue', 'blue']],
    });
    const { match, tap, tick } = await setup();
    match();
    tick(100);
    for (const x of [250, 350, 50, 250]) tap(x);

    tick(540);
    expect(vi.mocked(move).mock.calls.map(([, from, to]) => [from, to])).toEqual([[0, 1], [2, 3]]);
    expect(scene.startMatch).toHaveBeenCalledTimes(2);
    tick(1079);
    expect(move).toHaveBeenCalledTimes(2);
    tick(1080);
    expect(vi.mocked(move).mock.calls.map(([, from, to]) => [from, to])).toEqual([[0, 1], [2, 3], [0, 2]]);
  });

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
      level: 3, rank: 'Fryer Fighter', movesRestored: 0, upgrade: { kind: 'stack', firstNewStack: 3, stackCount: 4 },
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
      level: 2, rank: 'Pastry Pupil', movesRestored: 0, upgrade: { kind: 'slots', previousCapacity: 5, capacity: 6 },
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
    const cueAt = 230 + 250;
    const cueEnds = cueAt + 500;
    const popupAt = 230 + 4500;
    const priorRenders = render.mock.calls.length;
    tick(cueAt - 1);
    tap(50);
    tap(150);
    tap(300);
    expect(move).toHaveBeenCalledTimes(1);
    expect(createGame).toHaveBeenCalledTimes(1);
    expect(render).toHaveBeenCalledTimes(priorRenders);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(null, true);
    tick(cueAt);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(0, true);
    tick(cueEnds - 1);
    tap(300);
    expect(createGame).toHaveBeenCalledTimes(1);
    expect(scene.showResults).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(priorRenders + 1);
    tick(cueEnds);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(null, true);
    tick(popupAt - 1);
    tap(50);
    tap(150);
    tap(300);
    expect(move).toHaveBeenCalledTimes(1);
    expect(createGame).toHaveBeenCalledTimes(1);
    expect(scene.showResults).not.toHaveBeenCalled();
    expect(render).toHaveBeenCalledTimes(priorRenders + 2);
    tick(popupAt);
    expect(scene.showResults.mock.lastCall?.[0]).toMatchObject({ tab: 'personal', friends: null });
    expect(render).toHaveBeenCalledTimes(priorRenders + 3);
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

    tick(3150);
    window.dispatchEvent(new Event('blur'));
    tick(7150);
    resizeViewport(375, 700);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(null, false);
    window.dispatchEvent(new Event('focus'));
    tick(7200);
    document.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    tick(11200);
    document.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    tick(11250);
    suspendFromHost();
    tick(15250);
    expect(scene.showResults).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('focus'));
    const cueAt = 15250 + 250 - 3 * 50;
    tick(cueAt - 1);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(null, false);
    tick(cueAt);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(0, false);

    const pauseCueAt = cueAt + 200;
    tick(pauseCueAt);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(0.4, false);
    resizeViewport(390, 700);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(0.4, false);
    motion.matches = true;
    motion.dispatchEvent(new Event('change'));
    tick(pauseCueAt);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(0.4, true);
    window.dispatchEvent(new Event('pagehide'));
    const resumeCueAt = pauseCueAt + 4000;
    tick(resumeCueAt);
    expect(scene.showResults).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('pageshow'));
    tick(resumeCueAt);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(0.4, true);
    const cueEnds = resumeCueAt + 300;
    tick(cueEnds - 1);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(0.4, true);
    expect(scene.showResults).not.toHaveBeenCalled();
    tick(cueEnds);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(null, true);
    tick(cueEnds + 1000);
    document.hidden = true;
    document.dispatchEvent(new Event('visibilitychange'));
    const resumeInspectionAt = cueEnds + 5000;
    tick(resumeInspectionAt);
    expect(scene.showResults).not.toHaveBeenCalled();
    document.hidden = false;
    document.dispatchEvent(new Event('visibilitychange'));
    const popupAt = resumeInspectionAt + 2750;
    tick(popupAt - 1);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(null, true);
    expect(scene.showResults).not.toHaveBeenCalled();
    tick(popupAt);
    expect(scene.showResults).toHaveBeenCalledTimes(1);
    expect(move).toHaveBeenCalledTimes(1);
  });

  it('opens results after the reveal if score recording rejects', async () => {
    const record = vi.fn(async () => { throw new Error('Storage is unavailable'); });
    const { match, tick } = await setup(true, '', 1, { record });
    vi.mocked(move).mockReturnValueOnce({ ...initial, gameOver: true });
    match();
    tick(16);
    await settleResults();
    expect(record).toHaveBeenCalledExactlyOnceWith({ score: 1390, level: 2, bestCombo: 0 });
    finishGameOverReveal(tick, 16);
    expect(scene.showResults.mock.lastCall?.[0]?.personal).toEqual({
      run: { score: 1390, level: 2, bestCombo: 0 }, rows: [], isPersonalBest: false,
    });
  });

  it('finishes the inspection after a stalled recording expires and ignores its late completion after replay', async () => {
    let complete!: (results: CompletedResults) => void;
    const record = vi.fn(() => new Promise<CompletedResults>(resolve => { complete = resolve; }));
    const { match, tap, tick, render } = await setup(true, '', 1, { record });
    vi.mocked(move).mockReturnValueOnce({ ...initial, gameOver: true });
    match();
    tick(16);
    await settleResults();
    expect(record).toHaveBeenCalledOnce();
    expect(GAME_OVER_RECORD_LIMIT_MS).toBe(3500);
    const cueAt = 16 + 250;
    const popupAt = 16 + 4500;
    tick(cueAt);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(0, true);
    tick(cueAt + 500);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(null, true);
    const priorRenders = render.mock.calls.length;
    tick(GAME_OVER_RECORD_LIMIT_MS);
    expect(render).toHaveBeenCalledTimes(priorRenders);
    expect(scene.showGameOverCue).toHaveBeenLastCalledWith(null, true);
    expect(scene.showResults).not.toHaveBeenCalled();
    tick(popupAt - 1);
    expect(scene.showResults).not.toHaveBeenCalled();
    tick(popupAt);
    expect(scene.showResults.mock.lastCall?.[0]?.personal).toEqual({
      run: { score: 1390, level: 2, bestCombo: 0 }, rows: [], isPersonalBest: false,
    });
    tap(300);
    expect(scene.showResults).toHaveBeenLastCalledWith(null);
    complete({ run: { score: 1390, level: 2, bestCombo: 0 }, rows: [], isPersonalBest: true });
    await settleResults();
    tick(popupAt + 16);
    expect(scene.showResults).toHaveBeenCalledTimes(2);
    expect(record).toHaveBeenCalledTimes(1);
  });

  it('records the best combo after the 28th miss, once across resize and replay', async () => {
    const game = await vi.importActual<typeof import('../game')>('../game');
    const opening: GameState = {
      ...initial, score: 0, level: 1, nextLevelScore: 500, doughMeter: 25,
      stacks: [['red', 'red', 'gold'], ['gold', 'gold'], ['red', 'blue', 'red']],
    };
    vi.mocked(createGame).mockReturnValueOnce(opening);
    vi.mocked(move).mockImplementation((state, from, to, _rng, onDough) => game.move(state, from, to, () => 0, onDough));
    const { tap, tick, renderer, window, localStorage } = await setup(true);
    const transfer = (from: number, to: number) => {
      tap(from * 100 + 50);
      tap(to * 100 + 50);
    };
    transfer(0, 1);
    tick(1000);
    transfer(2, 0);
    tick(2000);
    expect(scene.draw.mock.lastCall?.[0]).toMatchObject({ score: 210, combo: 2, doughMeter: 25 });

    for (let count = 26; count <= 28; count++) {
      const board = scene.draw.mock.lastCall![0];
      const miss = board.stacks.flatMap((source, from) => board.stacks.flatMap((target, to) =>
        game.canMove(board, from, to) && !game.resolveMatch(target, source.at(-1)!) ? [{ from, to }] : []))[0];
      expect(miss).toBeDefined();
      transfer(miss.from, miss.to);
      expect(scene.draw.mock.lastCall?.[0]).toMatchObject({ doughMeter: count, gameOver: count === 28 });
      expect(localStorage.setItem).not.toHaveBeenCalled();
      if (count < 28) tick((count - 23) * 1000);
    }
    expect(scene.draw.mock.lastCall?.[0]).toMatchObject({ score: 210, level: 1, combo: 0, endReason: 'dough-meter' });
    expect(scene.showResults).not.toHaveBeenCalled();
    expect(scene.startMoveCost).toHaveBeenCalledTimes(3);
    scene.moveCostAnimating = true;
    tick(5000);
    await settleResults();
    finishGameOverReveal(tick, 5000);
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
    const { match, tick, tap, renderer, localStorage, render, onResultsVisibilityChange } = await setup(true);
    vi.mocked(move).mockReturnValueOnce({ ...initial, score: 1555, gameOver: true });
    match();
    expect(getFriendsScores).not.toHaveBeenCalled();
    tick(1000);
    await settleResults();
    const popupAt = 1000 + GAME_OVER_REVEAL_MS;
    tick(1000 + GAME_OVER_LEAD_IN_MS);
    tick(1000 + GAME_OVER_LEAD_IN_MS + GAME_OVER_CUE_MS);
    expect(onResultsVisibilityChange).not.toHaveBeenCalled();
    tick(popupAt);
    expect(onResultsVisibilityChange).toHaveBeenCalledExactlyOnceWith(true);
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
    expect(onResultsVisibilityChange.mock.calls).toEqual([[true], [false]]);
    expect(board.list).toHaveBeenCalledTimes(1);
    expect(localStorage.setItem).toHaveBeenCalledTimes(1);
  });

  it('routes a results-list drag and wheel without replaying or leaving a captured gesture active after resize', async () => {
    scene.canScrollResults.mockImplementation(point => point.x === 100);
    scene.scrollResults.mockReturnValue(true);
    const { match, tick, pointer, wheel, render, renderer, tap } = await setup(true);
    expect(wheel(100, 400, 20)).toBe(false);
    vi.mocked(move).mockReturnValueOnce({ ...initial, score: 1555, gameOver: true });
    match();
    tick(1000);
    await settleResults();
    const popupAt = 1000 + GAME_OVER_REVEAL_MS;
    finishGameOverReveal(tick, 1000);
    expect(scene.showResults.mock.lastCall?.[0]?.tab).toBe('personal');

    const rendered = render.mock.calls.length;
    pointer('pointerdown', 100, 1, 'touch', 1, 400);
    pointer('pointermove', 100, 2, 'touch', 1, 315);
    pointer('pointermove', 100, 1, 'touch', 1, 350);
    pointer('pointerup', 300, 1, 'touch', 0, 328);
    expect(scene.scrollResults.mock.calls).toEqual([[50], [22]]);
    tick(popupAt + 16);
    expect(render).toHaveBeenCalledTimes(rendered + 1);
    expect(scene.showResults.mock.lastCall?.[0]?.tab).toBe('personal');

    expect(wheel(300, 400, 20)).toBe(false);
    expect(wheel(100, 400, -2, 1)).toBe(true);
    expect(scene.scrollResults).toHaveBeenLastCalledWith(-32);
    pointer('pointerdown', 100, 1, 'touch', 1, 400);
    renderer.emit('resize');
    pointer('pointermove', 100, 1, 'touch', 1, 300);
    pointer('pointerup', 300, 1, 'touch', 0, 310);
    expect(scene.scrollResults).toHaveBeenCalledTimes(3);
    tap(300);
    expect(scene.showResults).toHaveBeenLastCalledWith(null);
  });
});
