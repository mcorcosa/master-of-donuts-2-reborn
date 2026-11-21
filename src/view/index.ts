import type { Application } from 'pixi.js';
import { canMove, canRequestSetupHint, createGame, type DoughInsert, findSetupHint, type GameState, JOKER, move } from '../game';
import type { BrowserQuality } from '../performance/browserQuality';
import { FrameLoop } from '../performance/frameLoop';
import type { FriendsScores } from '../platform/friendsScores';
import type { PersonalScores } from '../platform/personalScores';
import { GameOverPresentation } from './gameOverPresentation';
import { type Point, StackGestures } from './gestures';
import { LEVEL_CELEBRATION_MS, type LevelCelebrationDetails } from './levelCelebration';
import { preloadScoreFont } from './matchEffect';
import { beginMatch, matchFrame, type MatchPlayback, scoreImpactTime } from './matchPlayback';
import { ResultsSession } from './resultsSession';
import { type Feedback, GameScene, loadArt } from './scene';
import { GOAL_GLEAM_MS, type ScoreDisplay } from './scoreBar';

const TOUCH_SWIPE_DISTANCE = 12;
const BROWSER_CHROME_HEIGHT_CHANGE = 96;
const MIN_CREDIT_SPACING_MS = 55;
const HINT_STATUS_MS = 1500;
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
  quality: BrowserQuality;
  onPause?(callback: () => void): () => void;
}

export async function mountGame(app: Application, {
  jokerPlaytest, personalScores, getFriendsScores, quality, onPause,
}: GameResultsOptions): Promise<void> {
  const [art] = await Promise.all([loadArt(), preloadScoreFont().catch(error => {
    console.warn('The bundled score font could not be loaded.', error);
  })]);
  const scene = new GameScene(art);
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
  let gameOver: GameOverPresentation | null = null;
  let levelStartScore = 0;
  let displayed = scoreDisplay(state, levelStartScore);
  const credits: ScoreCredit[] = [];
  const levels: LevelReveal[] = [];
  let unsettledLevel: LevelReveal | null = null;
  let celebrationEnds = 0;
  let feedback: Feedback | null = null;
  let renderedSize: { width: number; height: number } | null = null;
  let pending: { playback: MatchPlayback; level: LevelReveal | null; inserts: readonly DoughInsert[] } | null = null;
  let tapOnlyPress = false;
  let queuedMove: { from: number; to: number } | null = null;
  let arrowPointer: { point: Point; destination: number | null } | null = null;
  let hintCache: { state: GameState; eligible: boolean; result?: ReturnType<typeof findSetupHint> } | null = null;
  let hintAvailable = false;
  let hintStatusUntil = 0;
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
      credits.length > 0 || levels.length > 0;
  }

  function timedWork(): boolean {
    return boardAnimating() || (!motion.matches && gameOver?.cueAnimating === true);
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
    const settled = !state.gameOver && !pending && !scene.moveAnimating && !scene.stackUnlockAnimating;
    if (settled && hintCache?.state !== state) hintCache = { state, eligible: canRequestSetupHint(state) };
    const available = settled && hintCache?.eligible === true;
    if (available !== hintAvailable) {
      hintAvailable = available;
      scene.setHintAvailable(available);
    }
    return available;
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
      if (now >= level.gleamAt + GOAL_GLEAM_MS && level.settled && celebrationEnds <= now) {
        levels.shift();
        celebrationEnds = now + LEVEL_CELEBRATION_MS;
        displayed = { score: displayed.score, level: details.level, rank: details.rank, levelStartScore, nextLevelScore };
        scene.drawScore(displayed);
        scene.startLevelCelebration(details, now, reduced);
      }
    }
    scene.showScoreEffects(now);
  }

  function cancelPresentation(): void {
    clearHint();
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
    cancelPresentation();
    scene.resize(width, height);
    draw();
    syncHintAvailability();
  }

  function hit(event: PointerEvent, mode: 'tap' | 'swipe') {
    const client = { x: event.clientX, y: event.clientY };
    const rect = canvas.getBoundingClientRect();
    const local = scene.toLocal({
      x: (client.x - rect.left) * app.screen.width / (rect.width || 1),
      y: (client.y - rect.top) * app.screen.height / (rect.height || 1),
    });
    const touch = event.pointerType === 'touch';
    const target = scene.hit(local, touch ? mode : 'exact', touch || event.pointerType === 'mouse');
    return { client, local, target };
  }

  function down(event: PointerEvent): void {
    if (hostPaused && !document.hidden) wake();
    const locked = pending !== null || scene.stackUnlockAnimating;
    if (queuedMove || event.button !== 0 || (locked && event.pointerType !== 'touch' && event.pointerType !== 'mouse')) return;
    const { client, target } = hit(event, 'tap');
    if (locked && typeof target !== 'number') return;
    if (state.gameOver && (!results || typeof target !== 'string' || target === 'outside')) return;
    if (target === 'hint' && !syncHintAvailability()) return;
    const swipeDistance = event.pointerType === 'touch' ? TOUCH_SWIPE_DISTANCE : undefined;
    if (!gestures.start(event.pointerId, client, target, swipeDistance)) return;
    tapOnlyPress = locked;
    if (!locked) {
      if (target !== 'hint') clearHint();
      scene.finishMove();
      checkBoardSettled();
      feedback = null;
      arrowPointer = null;
      updateInteraction();
    }
    frames.invalidate();
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Window listeners also cover a pointer that could not be captured.
    }
  }

  function track(event: PointerEvent): void {
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
    if (!gestures.owns(event.pointerId)) return;
    frames.invalidate();
    const { client, target } = hit(event, 'swipe');
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
        if (hintCache.result === undefined) hintCache.result = findSetupHint(state);
        gestures.reset();
        updateInteraction();
        scene.showHint(hintCache.result);
        hintStatusUntil = hintCache.result ? 0 : performance.now() + HINT_STATUS_MS;
      }
      return;
    }
    if (action?.kind === 'restart') {
      results?.close();
      results = null;
      gameOver = null;
      scene.showResults(null);
      state = createRun();
      bestCombo = 0;
      levelStartScore = 0;
      cancelPresentation();
      gestures.reset();
      quality.frames.interrupt();
      applyQuality();
      draw();
      syncHintAvailability();
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

  function commitMove(from: number, to: number): void {
    const before = state;
    let inserts: readonly DoughInsert[] = [];
    // Commit once so interrupted playback can immediately draw the resolved board.
    state = move(before, from, to, undefined, dough => { inserts = dough; });
    bestCombo = Math.max(bestCombo, state.combo ?? 0);
    const started = performance.now();
    if (state.gameOver) {
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
      pending = { playback, level, inserts };
      syncHintAvailability();
      if (level) levels.push(level);
      // A reduced-motion match can resolve ahead of a flight already in progress.
      const previous = credits.at(-1);
      const at = Math.max(scoreImpactTime(playback), previous ? previous.at + MIN_CREDIT_SPACING_MS : 0);
      credits.push({ at, total: state.score, reduced: playback.reduced, level });
      feedback = null;
      scene.startMatch(playback);
      scene.showMatch(matchFrame(playback, started));
      scene.showMatchTail(started);
      return;
    }
    if (state.score !== before.score || level) resetScore();
    const start = scene.topPosition(from);
    const color = before.stacks[from].at(-1)!;
    if (!state.gameOver) feedback = { target: to, started, duration: 280, color };
    draw();
    scene.startMove(inserts, started, motion.matches, { to, start, color });
    syncHintAvailability();
  }

  function cancel(event: PointerEvent): void {
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
      const { playback, level, inserts } = pending;
      const frame = matchFrame(playback, now);
      scene.showMatch(frame);
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
    if (wasLocked && !pending && !scene.stackUnlockAnimating) {
      if (queuedMove) {
        const { from, to } = queuedMove;
        queuedMove = null;
        scene.finishMove();
        checkBoardSettled();
        if (canMove(state, from, to)) commitMove(from, to);
      } else updateInteraction(now);
    }
    syncHintAvailability();
    if (hintStatusUntil && now >= hintStatusUntil) clearHint();
    checkBoardSettled();
    advanceScore(now);
    scene.showMatchTail(now);
    advanceGameOver(now);
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
    clearHint();
    if (pending || scene.stackUnlockAnimating) {
      gestures.reset();
      cancelPresentation();
      draw();
    } else {
      scene.finishMove();
      scene.finishStackUnlock();
      scene.cancelMatch();
      resetScore();
      gestures.cancel();
      feedback = null;
      arrowPointer = null;
      updateInteraction();
    }
    syncHintAvailability();
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
    unsubscribePause?.();
    stopWarmup();
    if (wakeAt) window.clearTimeout(wakeTimer);
    frames.dispose();
    canvas.style.touchAction = touchAction;
    renderer.off('resize', rendererResized);
    stage.off('destroyed', close);
  });
}
