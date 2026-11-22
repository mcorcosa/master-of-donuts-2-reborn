import type { AdOutcome } from '@playbridge/core';
import type { Application } from 'pixi.js';
import { GameSound } from '../audio/GameSound';
import {
  canMove, canRequestSetupHint, canUseJokerBooster, createGame, type DoughInsert, findSetupHint, type GameState,
  JOKER, move, useJokerBooster, useStackSweep,
} from '../game';
import { RunBoosters } from '../game/boosters';
import type { BrowserQuality } from '../performance/browserQuality';
import { FrameLoop } from '../performance/frameLoop';
import type { FriendsScores } from '../platform/friendsScores';
import type { PersonalScores } from '../platform/personalScores';
import type { BoosterButtonView, BoosterFooterView } from './boosters';
import { GameOverPresentation } from './gameOverPresentation';
import { type BoosterButton, type Point, StackGestures } from './gestures';
import { VIEW_WIDTH } from './layout';
import { LEVEL_CELEBRATION_MS, type LevelCelebrationDetails } from './levelCelebration';
import { preloadScoreFont } from './matchEffect';
import { awardFrame, beginMatch, clearStart, matchFrame, type MatchPlayback, matchPopTime, scoreImpactTime } from './matchPlayback';
import { FLIGHT_MS } from './movePlayback';
import { ResultsSession } from './resultsSession';
import { type Feedback, GameScene, loadArt } from './scene';
import { GOAL_GLEAM_MS, type ScoreDisplay } from './scoreBar';

const MOUSE_BOARD_EDGE_SLOP = 6;
const BROWSER_CHROME_HEIGHT_CHANGE = 96;
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

function scoreDisplay({ score, level, rank, nextLevelScore }: GameState, levelStartScore: number): ScoreDisplay {
  return { score, level, rank, nextLevelScore, levelStartScore };
}

function levelReveal(before: GameState, after: GameState, reduced: boolean): LevelReveal | null {
  if (before.level === after.level) return null;
  const { level, rank, capacity, nextLevelScore, stacks } = after;
  const newStack = stacks.length > before.stacks.length;
  const newSlots = capacity > before.capacity;
  const details: LevelCelebrationDetails = { level, rank };
  if (newStack) details.upgrade = { kind: 'stack', firstNewStack: before.stacks.length, stackCount: stacks.length };
  else if (newSlots) details.upgrade = { kind: 'slots', previousCapacity: before.capacity, capacity };
  return { details, nextLevelScore, levelStartScore: before.nextLevelScore, reduced, settled: false, credited: false, gleamAt: null };
}

interface GameResultsOptions {
  jokerPlaytest: boolean;
  personalScores: Pick<PersonalScores, 'record'>;
  getFriendsScores(): FriendsScores | null;
  watchBoosterAd?(isCurrent: () => boolean): Promise<AdOutcome>;
  quality: BrowserQuality;
  onPause?(callback: () => void): () => void;
  onResultsVisibilityChange?(visible: boolean): void;
}

export async function mountGame(app: Application, {
  jokerPlaytest, personalScores, getFriendsScores, watchBoosterAd, quality, onPause, onResultsVisibilityChange,
}: GameResultsOptions): Promise<void> {
  const [art] = await Promise.all([loadArt(), preloadScoreFont().catch(error => {
    console.warn('The bundled score font could not be loaded.', error);
  })]);
  const scene = new GameScene(art);
  const sound = new GameSound();
  const { canvas, renderer, stage } = app;
  const document = canvas.ownerDocument;
  const window = document.defaultView!;
  const createRun = jokerPlaytest ? (): GameState => ({
    stacks: [[JOKER], ['red', 'blue'], ['red', 'blue']],
    score: 0, combo: 0, level: 1, rank: 'Dough Enthusiast', capacity: 5, nextLevelScore: 500, movesLeft: 7, gameOver: false,
  }) : createGame;
  const events = new AbortController();
  const options = { signal: events.signal };
  const touchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  let state = createRun();
  let bestCombo = 0;
  let results: ResultsSession | null = null;
  let resultsDrag: { id: number; y: number } | null = null;
  let gameOver: GameOverPresentation | null = null;
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
  let queuedMove: { from: number; to: number } | null = null;
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
    return pending !== null || scene.moveAnimating || scene.stackUnlockAnimating || scene.effectsAnimating ||
      scene.selectionAnimating || (feedback !== null && !motion.matches) ||
      credits.length > 0 || levels.length > 0 || (!motion.matches && scene.boosterCueDeadline > 0);
  }

  function timedWork(): boolean {
    return boardAnimating() || boosterDrop !== null || scene.freeBoosterAnimating ||
      (!motion.matches && gameOver?.cueAnimating === true);
  }

  function needsAnimation(): boolean {
    return timedWork() || (!state.gameOver && !motion.matches && hasJoker());
  }

  function queueDeadline(now: number): void {
    let next = hintStatusUntil;
    const gameOverDeadline = results ? 0 : gameOver?.deadline(motion.matches) ?? 0;
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
    if (!warmup || cancelWarmup || state.gameOver || document.hidden || hostPaused || gestures.active || needsAnimation()) return;
    const run = (deadline?: IdleDeadline) => {
      cancelWarmup = undefined;
      if (!warmup || state.gameOver || document.hidden || hostPaused || gestures.active || needsAnimation()) return;
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

  function syncViewport(): void {
    if (!viewportDirty) return;
    viewportDirty = false;
    const dpr = quality.nativeDpr;
    quality.syncDisplay();
    if (dpr !== quality.nativeDpr) watchDisplay();
    const { innerWidth, innerHeight } = window;
    if (innerWidth === viewportWidth && innerHeight === viewportHeight) {
      if (renderer.resolution !== quality.frames.resolution) {
        renderer.resolution = quality.frames.resolution;
        resolutionChanged();
      }
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
    const settled = !state.gameOver && !boosters.claiming && !pending && !scene.moveAnimating && !scene.stackUnlockAnimating;
    if (settled && hintCache?.state !== state) hintCache = { state, eligible: canRequestSetupHint(state) };
    const available = settled && hintCache?.eligible === true;
    if (available !== hintAvailable) {
      hintAvailable = available;
      scene.setHintAvailable(available);
    }
    return available;
  }

  function canOfferBoosters(): boolean {
    return !!watchBoosterAd && focused && !document.hidden && !pageHidden && !hostPaused;
  }

  function syncBoosterClock(now: number): void {
    boosters.setActive(!state.gameOver && canOfferBoosters(), now);
  }

  function syncBoosterAvailability(now = performance.now()): BoosterFooterView {
    const visible = !state.gameOver;
    const settled = visible && !pending && !queuedMove && !scene.moveAnimating && !scene.stackUnlockAnimating &&
      !scene.effectsAnimating && !scene.boosterCueDeadline && !credits.length && !levels.length &&
      !boosters.claiming && !hostPaused && !document.hidden && !pageHidden;
    if (settled && boosterCache?.state !== state) {
      // Keep the validated Sweep board so a completed press commits the exact preview.
      boosterCache = { state, joker: canUseJokerBooster(state), swept: useStackSweep(state) };
    }
    const progress = Math.floor(boosters.progress(now) * 100) / 100;
    const canOffer = !!watchBoosterAd && boosters.hasOffersLeft;
    const button = (kind: BoosterButton, legal: boolean): BoosterButtonView => {
      const source = boosters.source(kind);
      if (source) return { usable: legal, mode: source === 'free' ? 'free' : 'held' };
      if (boosters.claiming === kind) return { usable: false, mode: 'loading' };
      if (!canOffer) return { usable: false, mode: 'locked' };
      return { usable: false, mode: legal && canOfferBoosters() && boosters.canClaim(kind, now) ? 'ad' : 'charging' };
    };
    const joker = button('joker', settled && boosterCache?.joker === true);
    const sweep = button('sweep', settled && boosterCache !== null && boosterCache.swept !== state);
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

  async function claimBooster(kind: BoosterButton): Promise<void> {
    const run = boosters;
    if (!watchBoosterAd || !run.beginClaim(kind, performance.now())) return;
    jokerArmed = false;
    adStatusUntil = 0;
    gestures.reset();
    clearHint();
    updateInteraction();
    syncControls();
    frames.invalidate();
    const isCurrentRun = () => !events.signal.aborted && boosters === run && !state.gameOver;
    let outcome: AdOutcome = { status: 'failed', attempted: false };
    try { outcome = await watchBoosterAd(() => isCurrentRun() && canOfferBoosters()); }
    catch { /* Keep the offer available after a host error. */ }
    if (!isCurrentRun()) return;
    run.finishClaim(outcome.status === 'completed');
    const now = performance.now();
    if (outcome.status !== 'completed' && outcome.status !== 'cancelled') adStatusUntil = now + AD_STATUS_MS;
    if (outcome.attempted && focused && !document.hidden && !pageHidden) wake();
    syncBoosterClock(now);
    syncControls(now);
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

  function updateInteraction(now = performance.now()): void {
    if (feedback && now - feedback.started >= feedback.duration) feedback = null;
    const { source } = gestures;
    const preview = arrowPointer && source !== null && arrowPointer.destination !== source
      ? { ...arrowPointer, blocked: arrowPointer.destination !== null && !canMove(state, source, arrowPointer.destination) }
      : null;
    scene.showInteraction(gestures, preview, feedback, now, motion.matches);
  }

  function draw(): void {
    scene.draw(state);
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
    gameOver?.setVisible(focused && !pageHidden && !document.hidden && !hostPaused, now);
    syncBoosterClock(now);
    queueDeadline(now);
  }

  function advanceGameOver(now: number): void {
    if (!gameOver || results) return;
    const completed = gameOver.advance(now, !boardAnimating());
    scene.showGameOverCue(gameOver.cueProgress(now), motion.matches);
    if (!completed) return;
    const present = (view: ResultsSession['view']) => {
      scene.showResults(view);
      frames.invalidate();
    };
    results = new ResultsSession(completed, jokerPlaytest ? null : getFriendsScores(), present);
    scene.showResults(results.view);
    onResultsVisibilityChange?.(true);
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
    queuedMove = null;
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
      heightChange <= BROWSER_CHROME_HEIGHT_CHANGE && !gestures.active && !pending &&
      !scene.moveAnimating && !scene.stackUnlockAnimating;
    if (!canRetainSelection) gestures.reset();
    renderedSize = { width: viewportWidth, height: viewportHeight };
    resultsDrag = null;
    cancelPresentation();
    scene.resize(width, height);
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
    if (hostPaused && !document.hidden) wake();
    const locked = pending !== null || scene.stackUnlockAnimating;
    if (boosters.claiming || queuedMove || resultsDrag || event.button !== 0 ||
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
    if (!gestures.start(event.pointerId, client, target, event.pointerType, jokerArmed)) return;
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
    if (!results || resultsDrag || event.ctrlKey || event.metaKey) return;
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
    const locked = pending !== null || scene.stackUnlockAnimating;
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
    const tracking = held ? gestures.dragSource !== null : event.buttons === 0;
    const next = tracking && (target === null || typeof target === 'number')
      ? { point: local, destination: target }
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
    if (tapOnlyPress) {
      gestures.update(event.pointerId, client, target);
      if (gestures.dragSource !== null) {
        cancel(event);
        return;
      }
    }
    tapOnlyPress = false;
    const action = gestures.finish(event.pointerId, client, target);
    arrowPointer = null;
    if (pending || scene.stackUnlockAnimating) {
      if (action?.kind === 'move') queuedMove = action;
      return;
    }
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
      if (button.mode === 'ad') { void claimBooster('joker'); return; }
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
      if (button.mode === 'ad') void claimBooster('sweep');
      else if (button.usable && boosterCache) commitBooster('sweep', boosterCache.swept);
      return;
    }
    if (action?.kind === 'restart') {
      results?.close();
      results = null;
      gameOver = null;
      scene.showResults(null);
      onResultsVisibilityChange?.(false);
      state = createRun();
      boosters = new RunBoosters();
      adStatusUntil = 0;
      bestCombo = 0;
      levelStartScore = 0;
      cancelPresentation();
      gestures.reset();
      quality.frames.interrupt();
      applyQuality();
      draw();
      syncControls();
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

  function commitBooster(kind: BoosterButton, next: GameState, selected?: number): void {
    if (!boosters.spend(kind)) return;
    cancelFreeBoosterPresentation(kind);
    const targets = state.stacks.flatMap((stack, index) => {
      const color = stack.at(-1);
      return color === undefined || (selected !== undefined && selected !== index) ? [] : [{ stack: index, color }];
    });
    state = next;
    jokerArmed = false;
    gestures.reset();
    feedback = null;
    clearHint();
    scene.startBoosterCue(kind, targets, performance.now(), motion.matches);
    draw();
    syncControls();
  }

  function commitMove(from: number, to: number): void {
    const before = state;
    let inserts: readonly DoughInsert[] = [];
    // Commit once so interrupted playback can immediately draw the resolved board.
    state = move(before, from, to, undefined, dough => { inserts = dough; });
    if (state === before) return;
    bestCombo = Math.max(bestCombo, state.combo ?? 0);
    const started = performance.now();
    boosters.start();
    const awarded = !state.gameOver && state.combo === 5
      ? boosters.grantComboDrop(state.combo, canUseJokerBooster(state) ? 'joker' : 'sweep')
      : undefined;
    syncBoosterClock(started);
    if (state.gameOver) {
      cancelFreeBoosterPresentation();
      const { score, level } = state;
      const presentation = new GameOverPresentation({ score, level, bestCombo }, started, personalScores, () => {
        if (gameOver === presentation && !results) frames.invalidate();
      });
      gameOver = presentation;
      syncGameOverVisibility(started);
      gestures.reset();
      queuedMove = null;
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
    draw();
    scene.startMove(inserts, started, motion.matches, { to, start, color });
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
          draw();
          scene.startMove(inserts, now, playback.reduced);
        }
        unsettledLevel = level;
      }
    } else if (feedback || scene.selectionAnimating) updateInteraction(now);
    scene.showMove(now);
    if (landing && now >= landing.at) playLanding();
    if (wasLocked && !pending && !scene.stackUnlockAnimating) {
      if (queuedMove) {
        const { from, to } = queuedMove;
        queuedMove = null;
        finishVisibleMove();
        checkBoardSettled();
        if (canMove(state, from, to)) commitMove(from, to);
      } else updateInteraction(now);
    }
    if (hintStatusUntil && now >= hintStatusUntil) clearHint();
    if (adStatusUntil && now >= adStatusUntil) adStatusUntil = 0;
    checkBoardSettled();
    if (scene.freeBoosterDeadline) scene.showFreeBoosterCelebration(now);
    advanceScore(now);
    scene.showMatchTail(now);
    if (scene.boosterCueDeadline) scene.showBoosterCue(now, motion.matches);
    advanceGameOver(now);
    syncControls(now);
    if (!timedWork() && !gestures.active && gestures.source === null) applyQuality();
    app.render();
    painted = true;
    const continuing = needsAnimation();
    if (!continuing) quality.frames.pause();
    queueDeadline(now);
    queueWarmup();
    return continuing;
  }

  function suspend(): void {
    resultsDrag = null;
    silencePresentation();
    cancelBoosterPresentation();
    syncGameOverVisibility();
    quality.frames.interrupt();
    frames.setSuspended(true);
    stopWarmup();
  }

  function wake(): void {
    if (document.hidden || pageHidden) return;
    hostPaused = false;
    syncGameOverVisibility();
    frames.setSuspended(false);
    wakeViewport();
  }

  function settleInterruptedPlay(): void {
    resultsDrag = null;
    clearHint();
    cancelBoosterPresentation();
    if (pending || scene.stackUnlockAnimating) {
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
    syncGameOverVisibility();
    settleInterruptedPlay();
  }, options);
  window.addEventListener('focus', () => {
    focused = true;
    wake();
  }, options);
  window.addEventListener('resize', wakeViewport, options);
  window.addEventListener('pagehide', () => {
    pageHidden = true;
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
    quality.frames.interrupt();
    updateInteraction();
    frames.invalidate();
  }, options);

  if (document.hidden) suspend();
  if (renderFrame(performance.now())) frames.invalidate();
  const unsubscribePause = onPause?.(() => {
    hostPaused = true;
    suspend();
    settleInterruptedPlay();
  });

  const close = () => scene.root.destroy({ children: true });
  stage.once('destroyed', close);
  scene.root.once('destroyed', () => {
    results?.close();
    gameOver = null;
    events.abort();
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
