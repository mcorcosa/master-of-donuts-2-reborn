import type { AdOutcome } from '@playbridge/core';
import type { Application } from 'pixi.js';
import { GameSound } from '../audio/GameSound';
import {
  canMove, canRequestSetupHint, canUseJokerBooster, createGame, DOUGH_METER_LIMIT, type DoughInsert, findSetupHint, type GameState,
  getBoardRepair, JOKER, LEVEL_DOUGH_RELIEF, move, previewExtraChance, useJokerBooster, useStackSweep,
} from '../game';
import { RunBoosters } from '../game/boosters';
import type { BrowserQuality } from '../performance/browserQuality';
import { FrameLoop } from '../performance/frameLoop';
import type { FriendsScores } from '../platform/friendsScores';
import type { AdPlacement, GameMonetization } from '../platform/monetization';
import type { PersonalScores } from '../platform/personalScores';
import { AdDialog, type AdDialogContent } from './adDialog';
import { installBoardDebug } from './boardDebug';
import type { BoosterButtonView, BoosterFooterView } from './boosters';
import { arrangeFirstMatch, findFirstMatch, type FirstMatchProgress } from './firstMatch';
import { preloadGameFont } from './gameFont';
import { GameOverPresentation } from './gameOverPresentation';
import { type BoosterButton, type Point, StackGestures } from './gestures';
import { VIEW_WIDTH } from './layout';
import { LEVEL_CELEBRATION_MS, type LevelCelebrationDetails } from './levelCelebration';
import { awardFrame, beginMatch, clearStart, matchFrame, type MatchPlayback, matchPopTime, scoreImpactTime } from './matchPlayback';
import { FLIGHT_MS } from './movePlayback';
import { ResultsSession } from './resultsSession';
import { type Feedback, GameScene, loadArt } from './scene';
import { GOAL_GLEAM_MS, type ScoreDisplay } from './scoreBar';

const MOUSE_BOARD_EDGE_SLOP = 6;
const BROWSER_CHROME_HEIGHT_CHANGE = 96;
const FIRST_MATCH_GUIDE_DELAY_MS = 250;
const MIN_CREDIT_SPACING_MS = 55;
const HINT_STATUS_MS = 1500;
const AD_STATUS_MS = 2000;
const WARMUP_MIN_IDLE_MS = 4;
const WARMUP_FALLBACK_MS = 45;

interface LevelReveal {
  details: LevelCelebrationDetails;
  nextLevelScore: number;
  levelStartScore: number;
  reduced: boolean;
  settled: boolean;
  credited: boolean;
  gleamAt: number | null;
  silent?: boolean;
}

interface ScoreCredit {
  at: number;
  total: number;
  reduced: boolean;
  level: LevelReveal | null;
}

interface AdPlayback {
  attempted: boolean;
  hostPausedDuringAttempt: boolean;
  timedOut: boolean;
  recovered: boolean;
  outcome?: AdOutcome;
  recovery?: AdDialogContent;
  pending?: AdDialogContent;
  isCurrent: () => boolean;
  finish: (outcome: AdOutcome) => void;
}

const boosterNames = { joker: 'Joker', sweep: 'Stack Sweep' } as const;
const resultNumber = new Intl.NumberFormat();

function scoreDisplay({ score, level, rank, nextLevelScore }: GameState, levelStartScore: number): ScoreDisplay {
  return { score, level, rank, nextLevelScore, levelStartScore };
}

function levelReveal(before: GameState, after: GameState, reduced: boolean): LevelReveal | null {
  if (before.level === after.level) return null;
  const { level, rank, capacity, nextLevelScore, stacks } = after;
  const newStack = stacks.length > before.stacks.length;
  const newSlots = capacity > before.capacity;
  const spent = before.doughMeter ?? 0;
  const movesRestored = Math.min(LEVEL_DOUGH_RELIEF, Math.max(0, spent - (after.doughMeter ?? 0)));
  const details: LevelCelebrationDetails = { level, rank, movesRestored };
  if (newStack) details.upgrade = { kind: 'stack', firstNewStack: before.stacks.length, stackCount: stacks.length };
  else if (newSlots) details.upgrade = { kind: 'slots', previousCapacity: before.capacity, capacity };
  return { details, nextLevelScore, levelStartScore: before.nextLevelScore, reduced, settled: false, credited: false, gleamAt: null };
}

interface GameResultsOptions {
  jokerPlaytest: boolean;
  firstMatch?: FirstMatchProgress | null;
  personalScores: Pick<PersonalScores, 'record'>;
  getFriendsScores(): FriendsScores | null;
  monetization?: GameMonetization;
  quality: BrowserQuality;
  onPause?(callback: () => void): () => void;
  onResultsVisibilityChange?(visible: boolean): void;
}

export async function mountGame(app: Application, {
  jokerPlaytest, firstMatch, personalScores, getFriendsScores, monetization, quality, onPause, onResultsVisibilityChange,
}: GameResultsOptions): Promise<void> {
  const { canvas, renderer, stage } = app;
  const document = canvas.ownerDocument;
  const [art] = await Promise.all([loadArt(), preloadGameFont(document.fonts).catch(error => {
    console.warn('The bundled game font could not be loaded.', error);
  })]);
  const scene = new GameScene(art);
  const sound = new GameSound();
  const window = document.defaultView!;
  const adDialog = monetization ? new AdDialog(document) : null;
  const createRun = jokerPlaytest ? (): GameState => ({
    stacks: [[JOKER], ['red', 'blue'], ['red', 'blue']],
    score: 0, combo: 0, level: 1, rank: 'Dough Enthusiast', capacity: 5, nextLevelScore: 500, movesLeft: 7,
    doughMeter: 0, gameOver: false,
  }) : createGame;
  const events = new AbortController();
  const options = { signal: events.signal };
  const touchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  let firstMatchProgress = jokerPlaytest ? null : firstMatch;
  let firstMatchGuideAt = 0;
  let firstMatchGuideBoard: GameState | undefined;
  let firstMatchMove: ReturnType<typeof findFirstMatch> = null;
  let state = createRun();
  if (firstMatchProgress) state = arrangeFirstMatch(state);
  const boardDebug = import.meta.env.MODE === 'board-debug' ? installBoardDebug(window, () => state) : undefined;
  let bestCombo = 0;
  let results: ResultsSession | null = null;
  let resultsDrag: { id: number; y: number } | null = null;
  let gameOver: GameOverPresentation | null = null;
  let abandonment: GameOverPresentation | null = null;
  let extraChance: GameState | null = null;
  let extraChanceUsed = false;
  let resultsVisible = false;
  let adPlayback: AdPlayback | null = null;
  let leaving = false;
  let reportedPlaying: boolean | undefined;
  let levelStartScore = 0;
  let displayed = scoreDisplay(state, levelStartScore);
  const credits: ScoreCredit[] = [];
  const levels: LevelReveal[] = [];
  let unsettledLevel: LevelReveal | null = null;
  let celebrationEnds = 0;
  let feedback: Feedback | null = null;
  let renderedSize: { width: number; height: number } | null = null;
  let pending: { playback: MatchPlayback; level: LevelReveal | null; inserts: readonly DoughInsert[]; popAt: number | null } | null = null;
  let landing: { at: number; color: string } | null = null;
  let tapOnlyPress = false;
  const queuedStackTaps: number[] = [];
  let arrowPointer: { point: Point; destination: number | null } | null = null;
  let hintCache: { state: GameState; eligible: boolean; result?: ReturnType<typeof findSetupHint> } | null = null;
  let hintAvailable = false;
  let hintStatusUntil = 0;
  let jokerArmed = false;
  let boosters = new RunBoosters();
  let boosterDrop: { kind: BoosterButton; creditAt: number; playback: MatchPlayback } | null = null;
  let adStatusUntil = 0;
  let boosterCache: { state: GameState; joker: boolean; swept: GameState } | null = null;
  let boosterDisplay: BoosterFooterView | null = null;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const gestures = new StackGestures(index => state.stacks[index].length > 0, (from, to) => canMove(state, from, to));
  const frames = new FrameLoop({
    request: callback => window.requestAnimationFrame(callback),
    cancel: id => window.cancelAnimationFrame(id),
  }, renderFrame);
  let hostPaused = false;
  let focused = true;
  let pageHidden = false;
  let viewportDirty = true;
  let viewportWidth = app.screen.width;
  let viewportHeight = app.screen.height;
  let safeAreaBottom = readSafeAreaBottom();
  let displayQuery: MediaQueryList | undefined;
  let painted = false;
  let wakeAt = 0;
  let wakeTimer = 0;
  let cancelWarmup: (() => void) | undefined;
  let warmup: Generator<void> | null = scene.warmup(renderer, motion.matches);

  function hasJoker(): boolean {
    return state.stacks.some(stack => stack.includes(JOKER)) || pending?.playback.jokerIndex !== undefined;
  }

  function boardAnimating(): boolean {
    return pending !== null || queuedStackTaps.length > 0 || scene.moveAnimating || scene.stackUnlockAnimating || scene.effectsAnimating ||
      scene.selectionAnimating || (feedback !== null && !motion.matches) ||
      credits.length > 0 || levels.length > 0 || (!motion.matches && scene.boosterCueDeadline > 0);
  }

  function timedWork(): boolean {
    return boardAnimating() || scene.moveCostAnimating || boosterDrop !== null || scene.freeBoosterAnimating ||
      scene.icingVialAnimating || (!motion.matches && gameOver?.cueAnimating === true);
  }

  function needsAnimation(): boolean {
    return timedWork() || (!state.gameOver && !motion.matches && hasJoker());
  }

  function queueDeadline(now: number): void {
    let next = hintStatusUntil;
    const moveCost = scene.moveCostDeadline;
    if (moveCost && (!next || moveCost < next)) next = moveCost;
    const vial = scene.icingVialDeadline;
    if (vial && (!next || vial < next)) next = vial;
    if (firstMatchGuideAt && (!next || firstMatchGuideAt < next)) next = firstMatchGuideAt;
    const gameOverDeadline = results || adDialog?.element.open ? 0 : gameOver?.deadline(motion.matches) ?? 0;
    if (gameOverDeadline && (!next || gameOverDeadline < next)) next = gameOverDeadline;
    if (feedback && motion.matches) {
      const feedbackEnds = feedback.started + feedback.duration;
      if (!next || feedbackEnds < next) next = feedbackEnds;
    }
    const boosterEnds = motion.matches ? scene.boosterCueDeadline : 0;
    if (boosterEnds && (!next || boosterEnds < next)) next = boosterEnds;
    const dropEnds = scene.freeBoosterAnimating ? 0 : scene.freeBoosterDeadline;
    if (dropEnds && (!next || dropEnds < next)) next = dropEnds;
    const claimRefresh = boosters.source('joker') && boosters.source('sweep') ? 0 : boosters.nextRefresh(now);
    if (claimRefresh && (!next || claimRefresh < next)) next = claimRefresh;
    if (adStatusUntil && (!next || adStatusUntil < next)) next = adStatusUntil;
    if (next === wakeAt) return;
    if (wakeAt) window.clearTimeout(wakeTimer);
    wakeAt = next;
    if (next) wakeTimer = window.setTimeout(() => {
      wakeAt = 0;
      frames.invalidate();
    }, Math.max(0, next - now));
  }

  function queueWarmup(): void {
    if (!warmup || cancelWarmup || state.gameOver || !foreground() || adPlayback?.attempted || gestures.active || needsAnimation()) return;
    const run = (deadline?: IdleDeadline) => {
      cancelWarmup = undefined;
      if (!warmup || state.gameOver || !foreground() || adPlayback?.attempted || gestures.active || needsAnimation()) return;
      if (!deadline || deadline.timeRemaining() >= WARMUP_MIN_IDLE_MS) {
        try {
          if (warmup.next().done) warmup = null;
        } catch (error) {
          warmup = null;
          console.warn('Optional game resources could not be prepared.', error);
        }
      }
      queueWarmup();
    };
    if (typeof window.requestIdleCallback === 'function') {
      const request = window.requestIdleCallback(run);
      cancelWarmup = () => window.cancelIdleCallback(request);
    } else {
      const request = window.setTimeout(run, WARMUP_FALLBACK_MS);
      cancelWarmup = () => window.clearTimeout(request);
    }
  }

  function stopWarmup(): void {
    cancelWarmup?.();
    cancelWarmup = undefined;
  }

  function sizeCanvas(): void {
    canvas.style.width = `${viewportWidth}px`;
    canvas.style.height = `${viewportHeight}px`;
  }

  function resolutionChanged(): void {
    scene.releasePreparedText();
    warmup = scene.warmup(renderer, motion.matches);
    sizeCanvas();
  }

  function applyQuality(): void {
    quality.applyPending();
    const resolution = quality.frames.resolution;
    if (renderer.resolution === resolution) return;
    // Pixi's resolution setter resizes the backing surface and invalidates
    // auto-resolution text without firing the layout resize handler.
    renderer.resolution = resolution;
    resolutionChanged();
  }

  function wakeViewport(): void {
    viewportDirty = true;
    quality.frames.interrupt();
    frames.invalidate();
  }

  function watchDisplay(): void {
    displayQuery?.removeEventListener('change', wakeViewport);
    displayQuery = window.matchMedia(`(resolution: ${quality.nativeDpr}dppx)`);
    displayQuery.addEventListener('change', wakeViewport, options);
  }

  function readSafeAreaBottom(): number {
    return parseFloat(window.getComputedStyle(canvas).getPropertyValue('--game-safe-area-bottom')) || 0;
  }

  function syncViewport(): void {
    if (!viewportDirty) return;
    viewportDirty = false;
    const dpr = quality.nativeDpr;
    quality.syncDisplay();
    if (dpr !== quality.nativeDpr) watchDisplay();
    const { innerWidth, innerHeight } = window;
    const inset = readSafeAreaBottom();
    const insetChanged = safeAreaBottom !== inset;
    safeAreaBottom = inset;
    if (innerWidth === viewportWidth && innerHeight === viewportHeight) {
      if (renderer.resolution !== quality.frames.resolution) {
        renderer.resolution = quality.frames.resolution;
        resolutionChanged();
      }
      if (insetChanged) resize();
      return;
    }
    viewportWidth = innerWidth;
    viewportHeight = innerHeight;
    const previous = renderer.resolution;
    renderer.resize(innerWidth, innerHeight, quality.frames.resolution);
    if (previous !== renderer.resolution) resolutionChanged();
    else sizeCanvas();
  }

  function syncHintAvailability(): boolean {
    const settled = !state.gameOver && !adPlayback && !adDialog?.element.open &&
      !boosters.claiming && !pending && !scene.moveAnimating && !scene.stackUnlockAnimating;
    if (settled && hintCache?.state !== state) hintCache = { state, eligible: canRequestSetupHint(state) };
    const available = settled && hintCache?.eligible === true;
    if (available !== hintAvailable) {
      hintAvailable = available;
      scene.setHintAvailable(available);
    }
    return available;
  }

  function visibleAndFocused(): boolean {
    return focused && !pageHidden && !document.hidden && !leaving && (document.hasFocus?.() ?? true);
  }

  function foreground(): boolean {
    return visibleAndFocused() && !hostPaused;
  }

  function otherDialogOpen(): boolean {
    return adDialog !== null && Array.from(document.querySelectorAll('dialog[open]')).some(dialog => dialog !== adDialog.element);
  }

  function syncBoosterClock(now: number): void {
    const playing = !state.gameOver && foreground() && !adPlayback && !adDialog?.element.open && !otherDialogOpen();
    if (monetization && reportedPlaying !== playing) {
      reportedPlaying = playing;
      monetization.setPlaying(playing);
    }
    boosters.setActive(playing && !!(monetization?.available('joker') || monetization?.available('sweep')), now);
  }

  function boosterLegality() {
    if (boosterCache?.state !== state) {
      // Keep the validated Sweep board so a completed press commits the exact preview.
      boosterCache = { state, joker: canUseJokerBooster(state), swept: useStackSweep(state) };
    }
    return boosterCache;
  }

  function syncBoosterAvailability(now = performance.now()): BoosterFooterView {
    const visible = !state.gameOver;
    const settled = visible && !pending && !queuedStackTaps.length && !scene.moveAnimating && !scene.stackUnlockAnimating &&
      !scene.effectsAnimating && !scene.boosterCueDeadline && !credits.length && !levels.length &&
      !boosters.claiming && !adPlayback && !adDialog?.element.open && !hostPaused && !document.hidden && !pageHidden;
    const legal = settled ? boosterLegality() : null;
    const progress = Math.floor(boosters.progress(now) * 100) / 100;
    const button = (kind: BoosterButton, legal: boolean): BoosterButtonView => {
      const source = boosters.source(kind);
      if (source) return { usable: legal, mode: source === 'free' ? 'free' : 'held' };
      if (boosters.claiming === kind) return { usable: false, mode: 'loading' };
      if (!boosters.hasOffersLeft || !monetization?.available(kind)) return { usable: false, mode: 'locked' };
      return { usable: false, mode: legal && foreground() && boosters.canClaim(kind, now) ? 'ad' : 'charging' };
    };
    const joker = button('joker', legal?.joker === true);
    const sweep = button('sweep', legal !== null && legal.swept !== state);
    if (!joker.usable) jokerArmed = false;
    const adUnavailable = adStatusUntil > now;
    if (!boosterDisplay || joker.mode !== boosterDisplay.joker.mode || joker.usable !== boosterDisplay.joker.usable ||
        sweep.mode !== boosterDisplay.sweep.mode || sweep.usable !== boosterDisplay.sweep.usable ||
        progress !== boosterDisplay.progress || jokerArmed !== boosterDisplay.armed || visible !== boosterDisplay.visible ||
        adUnavailable !== boosterDisplay.adUnavailable) {
      boosterDisplay = { joker, sweep, progress, armed: jokerArmed, visible, adUnavailable };
      scene.setBoosterControls(boosterDisplay);
    }
    return boosterDisplay;
  }

  function syncControls(now = performance.now()): void {
    syncHintAvailability();
    syncBoosterAvailability(now);
  }

  function offerBooster(kind: BoosterButton): void {
    const run = boosters;
    if (!adDialog || !foreground() || !monetization?.available(kind)) return;
    jokerArmed = false;
    gestures.reset();
    clearHint();
    updateInteraction();
    const name = boosterNames[kind];
    adDialog.show({
      title: name,
      description: kind === 'joker'
        ? 'Watch an ad to earn a Joker. Use it to turn the top donut of one stack into a wildcard.'
        : 'Watch an ad to earn a Stack Sweep. Use it to remove the top donut from each stack.',
      primary: { label: 'Watch ad', activate: event => {
        if (event.isTrusted && hostPaused) wake();
        if (!foreground() || otherDialogOpen() || !monetization.available(kind) ||
            run !== boosters || !run.beginClaim(kind, performance.now())) return;
        if (event.isTrusted) sound.activate();
        adStatusUntil = 0;
        requestAd(kind, () => boosters === run && !state.gameOver, outcome => {
          run.finishClaim(outcome.status === 'completed');
          if (outcome.status !== 'completed' && outcome.status !== 'cancelled') {
            adStatusUntil = performance.now() + AD_STATUS_MS;
          }
        }, { title: name, description: 'Opening ad…' });
      } },
      secondary: { label: 'Cancel', activate: () => {
        adDialog.hide();
        syncGameOverVisibility();
        syncControls();
        frames.invalidate();
      } },
    });
    syncGameOverVisibility();
    syncControls();
    frames.invalidate();
  }

  function cancelBoosterPresentation(): void {
    if (jokerArmed || gestures.boosterPress) {
      jokerArmed = false;
      gestures.reset();
      updateInteraction();
    }
    scene.cancelBoosterCue();
    cancelFreeBoosterPresentation();
  }

  function cancelFreeBoosterPresentation(kind?: BoosterButton): void {
    if (!kind || boosterDrop?.kind === kind) boosterDrop = null;
    scene.cancelFreeBoosterCelebration(kind);
  }

  function clearHint(): void {
    hintStatusUntil = 0;
    scene.clearHint();
  }

  function stopFirstMatch(): void {
    if (!firstMatchProgress) return;
    firstMatchProgress = null;
    firstMatchGuideAt = 0;
    firstMatchGuideBoard = undefined;
    firstMatchMove = null;
    scene.hideFirstMatchGuide();
  }

  function renderFirstMatchGuide(now: number): boolean {
    if (!firstMatchProgress || !painted || now < firstMatchGuideAt) return false;
    firstMatchGuideAt = 0;
    if (firstMatchGuideBoard !== state) {
      firstMatchGuideBoard = state;
      firstMatchMove = findFirstMatch(state);
    }
    const active = foreground() && !adPlayback && !adDialog?.element.open && !otherDialogOpen();
    const handMotion = motion.matches ? 'reduced' : active ? 'animate' : 'paused';
    return scene.showFirstMatchGuide(scene.moveAnimating ? null : firstMatchMove, now, handMotion);
  }

  function updateInteraction(now = performance.now()): void {
    if (feedback && now - feedback.started >= feedback.duration) feedback = null;
    const { source } = gestures;
    const preview = arrowPointer && source !== null && arrowPointer.destination !== source
      ? { ...arrowPointer, blocked: arrowPointer.destination !== null && !canMove(state, source, arrowPointer.destination) }
      : null;
    scene.showInteraction(gestures, preview, feedback, now, motion.matches);
  }

  function draw(refreshVial = true): void {
    if (refreshVial) scene.draw(state);
    else scene.draw(state, false);
    updateInteraction();
  }

  function resetScore(): void {
    credits.length = levels.length = 0;
    unsettledLevel = null;
    celebrationEnds = 0;
    displayed = scoreDisplay(state, levelStartScore);
    scene.drawScore(displayed);
    scene.cancelScoreEffects();
  }

  function checkBoardSettled(): void {
    if (!unsettledLevel || scene.moveAnimating || scene.stackUnlockAnimating) return;
    unsettledLevel.settled = true;
    unsettledLevel = null;
  }

  function syncGameOverVisibility(now = performance.now()): void {
    gameOver?.setVisible(foreground() && !adPlayback?.attempted && !otherDialogOpen(), now);
    syncBoosterClock(now);
    queueDeadline(now);
  }

  function setResultsVisible(visible: boolean): void {
    if (resultsVisible === visible) return;
    resultsVisible = visible;
    onResultsVisibilityChange?.(visible);
  }

  function finalizeGameOver(presentation: GameOverPresentation, now = performance.now()): void {
    if (presentation.finalize(now)) monetization?.runCompleted();
  }

  function declineExtraChance(presentation: GameOverPresentation): void {
    if (gameOver !== presentation || !extraChance) return;
    extraChance = null;
    adDialog?.hide();
    finalizeGameOver(presentation);
    syncGameOverVisibility();
    frames.invalidate();
  }

  function offerExtraChance(presentation: GameOverPresentation, rescued: GameState): void {
    if (!adDialog || adDialog.element.open) return;
    const title = 'Extra Chance';
    const score = resultNumber.format(presentation.run.score);
    adDialog.show({
      title,
      description: `Out of moves. Score ${score}. Watch an ad to get ${LEVEL_DOUGH_RELIEF} moves back and keep playing.`,
      primary: { label: 'Watch ad', activate: event => {
        if (event.isTrusted && hostPaused) wake();
        if (!foreground() || otherDialogOpen() || adPlayback || gameOver !== presentation) return;
        if (!monetization?.available('extra-chance')) {
          declineExtraChance(presentation);
          return;
        }
        if (event.isTrusted) sound.activate();
        extraChanceUsed = true;
        requestAd('extra-chance', () => gameOver === presentation && extraChance === rescued, outcome => {
          if (outcome.status !== 'completed') {
            declineExtraChance(presentation);
            return;
          }
          abandonment = presentation;
          gameOver = null;
          extraChance = null;
          boardDebug?.applied(state, rescued, { kind: 'extra-chance' });
          const spentAtLoss = state.doughMeter ?? DOUGH_METER_LIMIT;
          scene.clearMoveCosts({ doughMeter: spentAtLoss });
          const restored = spentAtLoss - (rescued.doughMeter ?? 0);
          state = rescued;
          gestures.reset();
          scene.showGameOverCue(null, motion.matches);
          setResultsVisible(false);
          draw(false);
          const now = performance.now();
          scene.startMoveRecovery({ source: 'extra', restored, remaining: DOUGH_METER_LIMIT - (state.doughMeter ?? 0) }, now, motion.matches);
          const repair = getBoardRepair(state);
          if (repair) scene.startMove(repair.inserts, now, motion.matches);
        }, { title, description: 'Opening ad…' });
      } },
      secondary: { label: 'Skip · See results', activate: () => declineExtraChance(presentation) },
    });
    setResultsVisible(true);
    syncGameOverVisibility();
  }

  function requestAd(placement: AdPlacement, isCurrent: () => boolean,
    finish: AdPlayback['finish'], pending?: AdDialogContent): void {
    if (!monetization || adPlayback) return;
    const lease: AdPlayback = {
      attempted: false, hostPausedDuringAttempt: false, timedOut: false, recovered: false, isCurrent, finish, pending,
    };
    adPlayback = lease;
    const current = () => !leaving && !events.signal.aborted && adPlayback === lease && lease.isCurrent();
    const canShow = () => current() && foreground() && !otherDialogOpen();
    const options = {
      isCurrent: current,
      canShow,
      onAttempt() {
        if (!current()) return;
        lease.attempted = true;
        silencePresentation();
        stopWarmup();
        quality.frames.interrupt();
        syncPlaybackSuspension();
        syncGameOverVisibility();
      },
      onRecovery(resume?: () => void) {
        if (!current()) return;
        if (resume) lease.timedOut = true;
        lease.recovery = resume ? {
          title: 'Ad interrupted',
          description: 'Once the ad has closed, return to the game.',
          primary: { label: 'Return to game', activate: event => {
            if (!current() || !visibleAndFocused() || otherDialogOpen() || lease.recovered) return;
            if (event.isTrusted) sound.activate();
            wake();
            if (!canShow()) return;
            lease.recovered = true;
            lease.recovery = undefined;
            refreshAdPlayback();
            resume();
          } },
        } : undefined;
        refreshAdPlayback();
      },
    };
    if (pending) adDialog?.show(pending);
    syncGameOverVisibility();
    syncControls();
    frames.invalidate();

    const settle = (outcome: AdOutcome) => {
      if (!current()) return;
      const unconfirmed = outcome.status === 'completed' && (lease.timedOut || !lease.attempted || !outcome.attempted);
      lease.outcome = unconfirmed ? { status: 'failed', attempted: lease.attempted } : outcome;
      // A pause before a native show has no ad return event to clear it.
      if (hostPaused && !lease.hostPausedDuringAttempt) {
        lease.recovery = {
          title: 'Game paused',
          description: 'Return to the game when you’re ready.',
          primary: { label: 'Return to game', activate: () => {
            if (current() && !otherDialogOpen()) wake();
          } },
        };
      }
      refreshAdPlayback();
    };
    const fail = () => settle({ status: 'failed', attempted: lease.attempted });
    try { void monetization.request(placement, options).then(settle, fail); }
    catch { fail(); }
  }

  function refreshAdPlayback(): void {
    const lease = adPlayback;
    if (!lease || leaving || !lease.isCurrent()) return;
    // Some hosts only send onPause for the native ad. The settled outcome
    // releases that pause when the browser is already visible and focused.
    if (lease.outcome && lease.hostPausedDuringAttempt && visibleAndFocused()) hostPaused = false;
    if (lease.outcome && foreground() && !otherDialogOpen()) {
      adPlayback = null;
      adDialog?.hide();
      lease.finish(lease.outcome);
      syncPlaybackSuspension();
      syncGameOverVisibility();
      syncControls();
      frames.invalidate();
    } else if (lease.recovery && visibleAndFocused() && !otherDialogOpen()) {
      adDialog?.show(lease.recovery);
    } else if (lease.pending) {
      adDialog?.show(lease.pending);
    } else {
      adDialog?.hide();
    }
  }

  function advanceGameOver(now: number): void {
    if (!gameOver || results) return;
    const completed = gameOver.advance(now, !boardAnimating());
    scene.showGameOverCue(gameOver.cueProgress(now), motion.matches);
    if (extraChance && gameOver.ready && !adPlayback) {
      if (monetization?.available('extra-chance')) offerExtraChance(gameOver, extraChance);
      else declineExtraChance(gameOver);
    }
    if (!completed) return;
    const present = (view: ResultsSession['view']) => {
      scene.showResults(view);
      frames.invalidate();
    };
    results = new ResultsSession(completed, jokerPlaytest ? null : getFriendsScores(), present);
    scene.showResults(results.view);
    setResultsVisible(true);
  }

  function advanceScore(now: number): void {
    while (credits[0]?.at <= now) {
      const { total, reduced, level } = credits.shift()!;
      displayed = { ...displayed, score: total };
      scene.drawScore(displayed);
      scene.creditScore(now, reduced);
      if (level) level.credited = true;
    }

    const level = levels[0];
    if (level?.credited) {
      const { details, reduced, levelStartScore, nextLevelScore } = level;
      if (level.gleamAt === null) {
        level.gleamAt = now;
        scene.reachScoreGoal(now, reduced);
      }
      if (now >= level.gleamAt + GOAL_GLEAM_MS && level.settled && celebrationEnds <= now && !scene.freeBoosterDeadline) {
        levels.shift();
        celebrationEnds = now + LEVEL_CELEBRATION_MS;
        displayed = { score: displayed.score, level: details.level, rank: details.rank, levelStartScore, nextLevelScore };
        scene.drawScore(displayed);
        scene.startLevelCelebration(details, now, reduced);
        if (!level.silent) sound.levelUp();
      }
    }
    scene.showScoreEffects(now);
    // Reduced motion leaves the match's score label on the board briefly after credit.
    if (boosterDrop && boosterDrop.creditAt <= now && !levels.length && celebrationEnds <= now &&
        !awardFrame(boosterDrop.playback, now)) {
      scene.startFreeBoosterCelebration(boosterDrop.kind, now, motion.matches);
      boosterDrop = null;
    }
  }

  function silencePresentation(): void {
    sound.stop();
    scene.clearMoveCosts(state);
    landing = null;
    if (pending) pending.popAt = null;
    for (const level of levels) level.silent = true;
  }

  function playLanding(): void {
    if (!landing) return;
    const { color } = landing;
    landing = null;
    sound.landing(color);
  }

  function finishVisibleMove(): void {
    scene.finishMove();
    // A new press can reveal the previous landing before its flight would end.
    playLanding();
  }

  function cancelPresentation(): void {
    silencePresentation();
    clearHint();
    cancelBoosterPresentation();
    pending = null;
    queuedStackTaps.length = 0;
    tapOnlyPress = false;
    feedback = null;
    arrowPointer = null;
    scene.cancelMatch();
    scene.finishMove();
    scene.finishStackUnlock();
    resetScore();
  }

  function resize(): void {
    const { width, height } = app.screen;
    // Pixi's logical size may round to a fractional pixel at a fractional DPR.
    // Compare the CSS viewport so an earlier DPR change cannot affect this touch rule.
    const heightChange = renderedSize ? Math.abs(viewportHeight - renderedSize.height) : 0;
    const canRetainSelection = renderedSize?.width === viewportWidth && heightChange > 0 &&
      heightChange <= BROWSER_CHROME_HEIGHT_CHANGE && !gestures.active && !pending && !queuedStackTaps.length &&
      !scene.moveAnimating && !scene.stackUnlockAnimating;
    if (!canRetainSelection) gestures.reset();
    renderedSize = { width: viewportWidth, height: viewportHeight };
    resultsDrag = null;
    cancelPresentation();
    scene.resize(width, height, safeAreaBottom * height / viewportHeight);
    draw();
    syncControls();
  }

  function toScene(client: Point): Point {
    const rect = canvas.getBoundingClientRect();
    return scene.toLocal({
      x: (client.x - rect.left) * app.screen.width / (rect.width || 1),
      y: (client.y - rect.top) * app.screen.height / (rect.height || 1),
    });
  }

  function hit(event: PointerEvent, mode: 'tap' | 'swipe') {
    const client = { x: event.clientX, y: event.clientY };
    const local = toScene(client);
    const touch = event.pointerType === 'touch';
    const mouse = event.pointerType === 'mouse';
    let target = scene.hit(local, touch ? mode : 'exact', touch || mouse);
    if (mouse && target === 'outside' && !state.gameOver && !scene.stackUnlockAnimating) {
      const inward = local.x < VIEW_WIDTH / 2 ? MOUSE_BOARD_EDGE_SLOP : -MOUSE_BOARD_EDGE_SLOP;
      const edgeStack = scene.hit({ x: local.x + inward, y: local.y });
      if (typeof edgeStack === 'number') target = edgeStack;
    }
    return { client, local, target };
  }

  function down(event: PointerEvent): void {
    const hadAdPlayback = adPlayback !== null;
    if (hostPaused && (!monetization || event.isTrusted)) {
      if (event.isTrusted && document.hasFocus?.()) focused = true;
      wake();
    }
    const locked = pending !== null || scene.stackUnlockAnimating || queuedStackTaps.length > 0;
    if (leaving || hostPaused || hadAdPlayback || adPlayback || adDialog?.element.open || otherDialogOpen() ||
        boosters.claiming || resultsDrag || event.button !== 0 ||
        (locked && event.pointerType !== 'touch' && event.pointerType !== 'mouse')) return;
    const { client, local, target } = hit(event, 'tap');
    if (results && !gestures.active && scene.canScrollResults(local)) {
      resultsDrag = { id: event.pointerId, y: local.y };
      capture(event.pointerId);
      return;
    }
    if (locked && typeof target !== 'number') return;
    if (state.gameOver && (!results || typeof target !== 'string' || target === 'outside')) return;
    if (target === 'hint' && !syncHintAvailability()) return;
    if (target === 'joker' || target === 'sweep') {
      const button = syncBoosterAvailability()[target];
      if (!button.usable && button.mode !== 'ad') return;
    }
    if (!gestures.start(event.pointerId, client, target, event.pointerType, jokerArmed, queuedStackTaps.at(-1))) return;
    if (event.isTrusted && event.pointerType === 'mouse' && !document.hidden && !pageHidden && !hostPaused) sound.activate();
    tapOnlyPress = locked;
    if (!locked) {
      if (target !== 'hint') clearHint();
      finishVisibleMove();
      checkBoardSettled();
      feedback = null;
      arrowPointer = null;
      updateInteraction();
    }
    frames.invalidate();
    capture(event.pointerId);
  }

  function capture(pointerId: number): void {
    try {
      canvas.setPointerCapture(pointerId);
    } catch {
      // Window listeners also cover a pointer that could not be captured.
    }
  }

  function trackResultsDrag(event: PointerEvent): boolean {
    if (resultsDrag?.id !== event.pointerId) return false;
    const { y } = toScene({ x: event.clientX, y: event.clientY });
    if (scene.scrollResults(resultsDrag.y - y)) frames.invalidate();
    resultsDrag.y = y;
    return true;
  }

  function wheelResults(event: WheelEvent): void {
    if (!results || adPlayback || resultsDrag || event.ctrlKey || event.metaKey) return;
    const client = { x: event.clientX, y: event.clientY };
    const local = toScene(client);
    if (!scene.canScrollResults(local)) return;
    const unit = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? canvas.getBoundingClientRect().height : 1;
    const end = toScene({ ...client, y: client.y + event.deltaY * unit });
    if (scene.scrollResults(end.y - local.y)) frames.invalidate();
    event.preventDefault();
  }

  function track(event: PointerEvent): void {
    if (trackResultsDrag(event)) return;
    const locked = pending !== null || scene.stackUnlockAnimating || queuedStackTaps.length > 0;
    const held = gestures.owns(event.pointerId);
    const idleMouse = !locked && !gestures.active && event.pointerType === 'mouse' && gestures.source !== null;
    if (!held && !idleMouse) return;

    const { client, local, target } = hit(event, 'swipe');
    const changed = held && gestures.update(event.pointerId, client, target);
    if (tapOnlyPress) {
      if (gestures.dragSource !== null) cancel(event);
      return;
    }
    if (locked) return;
    const destination = held ? gestures.destination : target;
    const tracking = held ? destination !== null : event.buttons === 0;
    const next = tracking && (destination === null || typeof destination === 'number')
      ? { point: local, destination }
      : null;
    const redraw = changed || arrowPointer !== null || next !== null;
    arrowPointer = next;
    if (redraw) {
      updateInteraction();
      frames.invalidate();
    }
  }

  function up(event: PointerEvent): void {
    if (trackResultsDrag(event)) {
      resultsDrag = null;
      return;
    }
    if (!gestures.owns(event.pointerId)) return;
    // The browser grants touch and pen activation on pointerup.
    if (event.isTrusted && event.pointerType !== 'mouse' && !document.hidden && !pageHidden && !hostPaused) sound.activate();
    frames.invalidate();
    const { client, target } = hit(event, jokerArmed ? 'tap' : 'swipe');
    const action = gestures.finish(event.pointerId, client, target, tapOnlyPress);
    tapOnlyPress = false;
    arrowPointer = null;
    if (action?.kind === 'stack-tap') {
      queuedStackTaps.push(action.stack);
      return;
    }
    if (pending || scene.stackUnlockAnimating || queuedStackTaps.length) return;
    if (action?.kind === 'hint') {
      if (syncHintAvailability() && hintCache) {
        jokerArmed = false;
        syncBoosterAvailability();
        if (hintCache.result === undefined) hintCache.result = findSetupHint(state);
        gestures.reset();
        updateInteraction();
        scene.showHint(hintCache.result);
        hintStatusUntil = hintCache.result ? 0 : performance.now() + HINT_STATUS_MS;
      }
      return;
    }
    if (action?.kind === 'joker') {
      const button = syncBoosterAvailability().joker;
      if (button.mode === 'ad') { offerBooster('joker'); return; }
      if (button.usable) {
        jokerArmed = !jokerArmed;
        gestures.reset();
        syncBoosterAvailability();
      }
      updateInteraction();
      return;
    }
    if (action?.kind === 'joker-target') {
      if (syncBoosterAvailability().armed) {
        const next = useJokerBooster(state, action.stack);
        if (next !== state) {
          commitBooster('joker', next, action.stack);
          return;
        }
      }
      updateInteraction();
      return;
    }
    if (action?.kind === 'sweep') {
      const button = syncBoosterAvailability().sweep;
      if (button.mode === 'ad') offerBooster('sweep');
      else if (button.usable && boosterCache) commitBooster('sweep', boosterCache.swept);
      return;
    }
    if (action?.kind === 'restart') {
      const outgoing = results;
      if (!outgoing || adPlayback) return;
      if (monetization?.available('play-again')) {
        if (foreground()) requestAd('play-again', () => results === outgoing, restart);
      } else restart();
      return;
    }
    if (action?.kind === 'personal' || action?.kind === 'friends') {
      results?.select(action.kind);
      return;
    }
    if (action?.kind === 'submit') {
      void results?.submit();
      return;
    }
    if (action?.kind === 'move') {
      commitMove(action.from, action.to);
      return;
    }
    if (action?.kind === 'blocked') {
      feedback = { target: action.to, started: performance.now(), duration: 750 };
    }
    updateInteraction();
  }

  function restart(): void {
    stopFirstMatch();
    results?.close();
    results = null;
    gameOver = null;
    abandonment = null;
    extraChance = null;
    extraChanceUsed = false;
    scene.showResults(null);
    setResultsVisible(false);
    state = createRun();
    boardDebug?.restart();
    boosters = new RunBoosters();
    adStatusUntil = 0;
    bestCombo = 0;
    levelStartScore = 0;
    cancelPresentation();
    gestures.reset();
    quality.frames.interrupt();
    applyQuality();
    draw();
    syncGameOverVisibility();
    syncControls();
  }

  function commitBooster(kind: BoosterButton, next: GameState, selected?: number): void {
    if (!boosters.spend(kind)) return;
    cancelFreeBoosterPresentation(kind);
    const targets = state.stacks.flatMap((stack, index) => {
      const color = stack.at(-1);
      return color === undefined || (selected !== undefined && selected !== index) ? [] : [{ stack: index, color }];
    });
    boardDebug?.applied(state, next, kind === 'joker' ? { kind, stackIndex: selected! } : { kind });
    state = next;
    jokerArmed = false;
    gestures.reset();
    feedback = null;
    clearHint();
    scene.startBoosterCue(kind, targets, performance.now(), motion.matches);
    draw(false);
    const repair = getBoardRepair(state);
    if (repair) scene.startMove(repair.inserts, performance.now(), motion.matches);
    syncControls();
  }

  function commitMove(from: number, to: number): void {
    const before = state;
    let inserts: readonly DoughInsert[] = [];
    // Commit once so interrupted playback can immediately draw the resolved board.
    state = move(before, from, to, undefined, dough => { inserts = dough; });
    if (state === before) return;
    boardDebug?.applied(before, state, { kind: 'transfer', fromStackIndex: from, toStackIndex: to }, inserts);
    if (firstMatchProgress && state.score > before.score) {
      void firstMatchProgress.complete();
      stopFirstMatch();
    }
    bestCombo = Math.max(bestCombo, state.combo ?? 0);
    const started = performance.now();
    const spent = state.doughMeter ?? 0;
    const previousSpent = before.doughMeter ?? 0;
    const remaining = DOUGH_METER_LIMIT - spent;
    boosters.start();
    const dropLegality = !state.gameOver && state.combo === 5 ? boosterLegality() : null;
    const awarded = dropLegality
      ? boosters.grantComboDrop(5, { joker: dropLegality.joker, sweep: dropLegality.swept !== state })
      : undefined;
    syncBoosterClock(started);
    if (state.gameOver) {
      cancelFreeBoosterPresentation();
      const { score, level } = state;
      const presentation = new GameOverPresentation({ score, level, bestCombo }, personalScores, () => {
        if (gameOver === presentation && !results) frames.invalidate();
      });
      gameOver = presentation;
      extraChance = !extraChanceUsed && !jokerPlaytest && monetization?.available('extra-chance') ? previewExtraChance(state) : null;
      if (!extraChance) finalizeGameOver(presentation, started);
      syncGameOverVisibility(started);
      gestures.reset();
      queuedStackTaps.length = 0;
      feedback = null;
    }
    const playback = beginMatch(before, state, from, to, started, motion.matches);
    const level = levelReveal(before, state, motion.matches);
    if (level) levelStartScore = level.levelStartScore;
    if (playback) {
      const popAt = playback.reduced ? null : clearStart(playback) + matchPopTime(playback.runLength, playback.runLength - 1);
      pending = { playback, level, inserts, popAt };
      syncControls();
      if (level) levels.push(level);
      // A reduced-motion match can resolve ahead of a flight already in progress.
      const previous = credits.at(-1);
      const at = Math.max(scoreImpactTime(playback), previous ? previous.at + MIN_CREDIT_SPACING_MS : 0);
      credits.push({ at, total: state.score, reduced: playback.reduced, level });
      const levelMoves = level?.details.movesRestored ?? 0;
      const comboMoves = previousSpent - spent - levelMoves;
      if (levelMoves > 0) scene.startMoveRecovery({ source: 'level', restored: levelMoves, remaining: remaining - comboMoves }, at, playback.reduced);
      if (comboMoves > 0) scene.startMoveRecovery({ source: 'combo', restored: comboMoves, remaining }, at, playback.reduced);
      if (awarded && focused && !hostPaused && !document.hidden && !pageHidden) {
        boosterDrop = { kind: awarded, creditAt: at, playback };
      }
      feedback = null;
      scene.startMatch(playback);
      scene.showMatch(matchFrame(playback, started));
      scene.showMatchTail(started);
      if (playback.reduced) sound.match(playback.color);
      return;
    }
    if (state.score !== before.score || level) resetScore();
    const start = scene.topPosition(from);
    const color = before.stacks[from].at(-1)!;
    feedback = null;
    draw(false);
    scene.startMove(inserts, started, motion.matches, { to, start, color });
    if (spent === previousSpent + 1) {
      scene.startMoveCost(to, started, motion.matches, remaining);
    }
    if (motion.matches) sound.landing(color);
    else landing = { color, at: started + FLIGHT_MS };
    syncControls();
  }

  function cancel(event: PointerEvent): void {
    if (resultsDrag?.id === event.pointerId) resultsDrag = null;
    if (gestures.cancel(event.pointerId)) {
      tapOnlyPress = false;
      arrowPointer = null;
      if (!pending && !scene.stackUnlockAnimating) updateInteraction();
      frames.invalidate();
    }
  }

  function leave(event: PointerEvent): void {
    if (!arrowPointer || (!gestures.owns(event.pointerId) && (gestures.active || event.pointerType !== 'mouse'))) return;
    arrowPointer = null;
    updateInteraction();
    frames.invalidate();
  }

  function playQueuedTaps(now: number): void {
    // Resolve each tap against the board left by the previous transfer.
    // A transfer can start another match, so let playback run before taking the next pair.
    for (let stack = queuedStackTaps.shift(); stack !== undefined; stack = queuedStackTaps.shift()) {
      const action = gestures.tapStack(stack);
      if (action?.kind === 'move') {
        finishVisibleMove();
        checkBoardSettled();
        commitMove(action.from, action.to);
        return;
      }
      if (action?.kind === 'blocked') feedback = { target: action.to, started: now, duration: 750 };
    }
    updateInteraction(now);
  }

  function renderFrame(timestamp: number): boolean {
    syncViewport();
    if (painted && needsAnimation()) quality.frames.sample(timestamp);
    const now = performance.now();
    const wasLocked = pending !== null || scene.stackUnlockAnimating;
    if ((!state.gameOver || boardAnimating()) && hasJoker()) scene.showJoker(now, motion.matches);
    if (pending) {
      const { playback, level, inserts, popAt } = pending;
      const frame = matchFrame(playback, now);
      scene.showMatch(frame);
      if (popAt !== null && now >= popAt) {
        pending.popAt = null;
        sound.match(playback.color);
      }
      if (frame.phase === 'resolved') {
        pending = null;
        if (level?.details.upgrade?.kind === 'stack') {
          scene.startStackUnlock(state, inserts, now, playback.reduced);
        } else {
          draw(false);
          scene.startMove(inserts, now, playback.reduced);
        }
        unsettledLevel = level;
      }
    } else if (feedback || scene.selectionAnimating) updateInteraction(now);
    scene.showMove(now);
    if (landing && now >= landing.at) playLanding();
    if (!pending && !scene.stackUnlockAnimating) {
      if (queuedStackTaps.length) playQueuedTaps(now);
      else if (wasLocked) updateInteraction(now);
    }
    if (hintStatusUntil && now >= hintStatusUntil) clearHint();
    if (adStatusUntil && now >= adStatusUntil) adStatusUntil = 0;
    checkBoardSettled();
    if (scene.freeBoosterDeadline) scene.showFreeBoosterCelebration(now);
    advanceScore(now);
    scene.showMatchTail(now);
    scene.showMoveCosts(now);
    if (scene.boosterCueDeadline) scene.showBoosterCue(now, motion.matches);
    advanceGameOver(now);
    scene.showIcingVial(now, motion.matches || !foreground() || !!adDialog?.element.open || otherDialogOpen());
    syncControls(now);
    if (!timedWork() && !gestures.active && gestures.source === null) applyQuality();
    const guideAnimating = renderFirstMatchGuide(now);
    app.render();
    if (!painted && firstMatchProgress) firstMatchGuideAt = performance.now() + FIRST_MATCH_GUIDE_DELAY_MS;
    painted = true;
    const continuing = needsAnimation();
    if (!continuing) quality.frames.pause();
    queueDeadline(now);
    queueWarmup();
    return continuing || guideAnimating;
  }

  function syncPlaybackSuspension(): void {
    const suspended = document.hidden || pageHidden || hostPaused || adPlayback?.attempted === true || leaving;
    if (suspended && firstMatchProgress) scene.pauseFirstMatchGuide();
    frames.setSuspended(suspended);
  }

  function suspend(): void {
    resultsDrag = null;
    silencePresentation();
    cancelBoosterPresentation();
    syncGameOverVisibility();
    quality.frames.interrupt();
    syncPlaybackSuspension();
    stopWarmup();
  }

  function wake(): void {
    if (!visibleAndFocused()) return;
    hostPaused = false;
    refreshAdPlayback();
    syncGameOverVisibility();
    syncPlaybackSuspension();
    wakeViewport();
  }

  function modalChanged(): void {
    refreshAdPlayback();
    syncGameOverVisibility();
    syncControls();
    frames.invalidate();
  }

  function abandon(): void {
    if (leaving) return;
    leaving = true;
    const terminal = gameOver ?? abandonment;
    if (terminal) finalizeGameOver(terminal);
    syncBoosterClock(performance.now());
  }

  function settleInterruptedPlay(): void {
    resultsDrag = null;
    clearHint();
    cancelBoosterPresentation();
    if (pending || scene.stackUnlockAnimating || queuedStackTaps.length) {
      gestures.reset();
      cancelPresentation();
      draw();
    } else {
      silencePresentation();
      scene.finishMove();
      scene.finishStackUnlock();
      scene.cancelMatch();
      resetScore();
      gestures.cancel();
      feedback = null;
      arrowPointer = null;
      updateInteraction();
    }
    syncControls();
    quality.frames.interrupt();
    frames.invalidate();
  }

  function rendererResized(): void {
    quality.frames.interrupt();
    resize();
    frames.invalidate();
  }

  stage.addChild(scene.root);
  sizeCanvas();
  resize();
  renderer.on('resize', rendererResized);
  watchDisplay();
  canvas.addEventListener('pointerdown', down, options);
  canvas.addEventListener('pointerleave', leave, options);
  canvas.addEventListener('lostpointercapture', cancel, options);
  canvas.addEventListener('wheel', wheelResults, { ...options, passive: false });
  window.addEventListener('pointermove', track, options);
  window.addEventListener('pointerup', up, options);
  window.addEventListener('pointercancel', cancel, options);
  window.addEventListener('blur', () => {
    focused = false;
    if (firstMatchProgress) scene.pauseFirstMatchGuide();
    refreshAdPlayback();
    syncGameOverVisibility();
    settleInterruptedPlay();
  }, options);
  window.addEventListener('focus', () => {
    focused = true;
    wake();
  }, options);
  window.addEventListener('resize', wakeViewport, options);
  window.addEventListener('pagehide', event => {
    pageHidden = true;
    if (event.persisted === false) abandon();
    suspend();
  }, options);
  window.addEventListener('pageshow', () => {
    pageHidden = false;
    wake();
  }, options);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) suspend();
    else wake();
  }, options);
  motion.addEventListener('change', () => {
    scene.cancelFreeBoosterCelebration();
    scene.clearMoveCosts(state);
    quality.frames.interrupt();
    updateInteraction();
    frames.invalidate();
  }, options);

  if (document.hidden) suspend();
  syncGameOverVisibility();
  if (renderFrame(performance.now())) frames.invalidate();
  const unsubscribePause = onPause?.(() => {
    hostPaused = true;
    if (adPlayback?.attempted) adPlayback.hostPausedDuringAttempt = true;
    suspend();
    settleInterruptedPlay();
  });
  // The purchase dialog is mounted separately. Observe native modal transitions
  // so opening it between frames still stops both gameplay clocks.
  const modalObserver = adDialog && typeof MutationObserver === 'function' ? new MutationObserver(records => {
    if (records.some(record => record.target !== adDialog.element && record.target.nodeName === 'DIALOG')) modalChanged();
  }) : null;
  modalObserver?.observe(document.body, { subtree: true, attributes: true, attributeFilter: ['open'] });

  const close = () => scene.root.destroy({ children: true });
  stage.once('destroyed', close);
  scene.root.once('destroyed', () => {
    boardDebug?.dispose();
    abandon();
    results?.close();
    gameOver = null;
    events.abort();
    modalObserver?.disconnect();
    adDialog?.destroy();
    sound.destroy();
    unsubscribePause?.();
    stopWarmup();
    if (wakeAt) window.clearTimeout(wakeTimer);
    frames.dispose();
    canvas.style.touchAction = touchAction;
    renderer.off('resize', rendererResized);
    stage.off('destroyed', close);
  });
}
