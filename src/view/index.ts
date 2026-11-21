import type { Application } from 'pixi.js';
import { canMove, createGame, type DoughInsert, type GameState, move } from '../game';
import { createFriendsScores } from '../platform/friendsScores';
import { PersonalScores } from '../platform/personalScores';
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

export async function mountGame(app: Application): Promise<void> {
  const [art] = await Promise.all([loadArt(), preloadScoreFont().catch(error => {
    console.warn('The bundled score font could not be loaded.', error);
  })]);
  const scene = new GameScene(art);
  const { canvas, renderer, stage, ticker } = app;
  const window = canvas.ownerDocument.defaultView!;
  const personalScores = new PersonalScores(() => window.localStorage);
  const events = new AbortController();
  const options = { signal: events.signal };
  const touchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  let state = createGame();
  let bestCombo = 0;
  let results: ResultsSession | null = null;
  let levelStartScore = 0;
  let displayed = scoreDisplay(state, levelStartScore);
  const credits: ScoreCredit[] = [];
  const levels: LevelReveal[] = [];
  let unsettledLevel: LevelReveal | null = null;
  let celebrationEnds = 0;
  let feedback: Feedback | null = null;
  let renderedSize: { width: number; height: number } | null = null;
  let pending: { playback: MatchPlayback; level: LevelReveal | null; inserts: readonly DoughInsert[] } | null = null;
  let arrowPointer: { point: Point; destination: number | null } | null = null;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const gestures = new StackGestures(index => state.stacks[index].length > 0, (from, to) => canMove(state, from, to));

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

  function showResultsIfSettled(): void {
    if (results || !state.gameOver || pending || scene.moveAnimating || scene.stackUnlockAnimating) return;
    const { score, level } = state;
    const completed = personalScores.record({ score, level, bestCombo });
    results = new ResultsSession(completed, createFriendsScores(), view => scene.showResults(view));
    scene.showResults(results.view);
  }

  function advanceScore(now: number): void {
    if (state.gameOver && !pending && !scene.moveAnimating && !scene.stackUnlockAnimating) {
      if (credits.length || levels.length || celebrationEnds > now) {
        scene.cancelMatch();
        resetScore();
      }
      showResultsIfSettled();
      scene.showScoreEffects(now);
      return;
    }

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
    pending = null;
    feedback = null;
    arrowPointer = null;
    scene.cancelMatch();
    scene.finishMove();
    scene.finishStackUnlock();
    resetScore();
  }

  function resize(): void {
    const { width, height } = app.screen;
    const heightChange = renderedSize ? Math.abs(height - renderedSize.height) : 0;
    const canRetainSelection = renderedSize?.width === width && heightChange > 0 &&
      heightChange <= BROWSER_CHROME_HEIGHT_CHANGE && !gestures.active && !pending &&
      !scene.moveAnimating && !scene.stackUnlockAnimating;
    if (!canRetainSelection) gestures.reset();
    renderedSize = { width, height };
    cancelPresentation();
    scene.resize(width, height);
    draw();
    showResultsIfSettled();
  }

  function hit(event: PointerEvent, mode: 'tap' | 'swipe') {
    const client = { x: event.clientX, y: event.clientY };
    const rect = canvas.getBoundingClientRect();
    const local = scene.toLocal({
      x: (client.x - rect.left) * app.screen.width / (rect.width || 1),
      y: (client.y - rect.top) * app.screen.height / (rect.height || 1),
    });
    return { client, local, target: scene.hit(local, event.pointerType === 'touch' ? mode : 'exact') };
  }

  function down(event: PointerEvent): void {
    if (pending || scene.stackUnlockAnimating || event.button !== 0) return;
    const { client, target } = hit(event, 'tap');
    if (state.gameOver && (!results || typeof target !== 'string' || target === 'outside')) return;
    const swipeDistance = event.pointerType === 'touch' ? TOUCH_SWIPE_DISTANCE : undefined;
    if (!gestures.start(event.pointerId, client, target, swipeDistance)) return;
    scene.finishMove();
    checkBoardSettled();
    feedback = null;
    arrowPointer = null;
    updateInteraction();
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Window listeners also cover a pointer that could not be captured.
    }
  }

  function track(event: PointerEvent): void {
    if (pending || scene.stackUnlockAnimating) return;
    const held = gestures.owns(event.pointerId);
    const idleMouse = !gestures.active && event.pointerType === 'mouse' && gestures.source !== null;
    if (!held && !idleMouse) return;

    const { client, local, target } = hit(event, 'swipe');
    const changed = held && gestures.update(event.pointerId, client, target);
    const tracking = held ? gestures.dragSource !== null : event.buttons === 0;
    const next = tracking && (target === null || typeof target === 'number')
      ? { point: local, destination: target }
      : null;
    const redraw = changed || arrowPointer !== null || next !== null;
    arrowPointer = next;
    if (redraw) updateInteraction();
  }

  function up(event: PointerEvent): void {
    if (!gestures.owns(event.pointerId)) return;
    const { client, target } = hit(event, 'swipe');
    const action = gestures.finish(event.pointerId, client, target);
    arrowPointer = null;
    if (action?.kind === 'restart') {
      results?.close();
      results = null;
      scene.showResults(null);
      state = createGame();
      bestCombo = 0;
      levelStartScore = 0;
      cancelPresentation();
      gestures.reset();
      draw();
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
      const { from, to } = action;
      const before = state;
      let inserts: readonly DoughInsert[] = [];
      // Commit once so interrupted playback can immediately draw the resolved board.
      state = move(before, from, to, undefined, dough => { inserts = dough; });
      bestCombo = Math.max(bestCombo, state.combo ?? 0);
      const started = performance.now();
      const playback = beginMatch(before, state, from, to, started, motion.matches);
      const level = levelReveal(before, state, motion.matches);
      if (level) levelStartScore = level.levelStartScore;
      if (playback) {
        pending = { playback, level, inserts };
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
      feedback = { target: to, started, duration: 280, color };
      draw();
      scene.startMove(inserts, started, motion.matches, { to, start, color });
      return;
    }
    if (action?.kind === 'blocked') {
      feedback = { target: action.to, started: performance.now(), duration: 750 };
    }
    updateInteraction();
  }

  function cancel(event: PointerEvent): void {
    if (gestures.cancel(event.pointerId)) {
      arrowPointer = null;
      updateInteraction();
    }
  }

  function leave(event: PointerEvent): void {
    if (!arrowPointer || (!gestures.owns(event.pointerId) && (gestures.active || event.pointerType !== 'mouse'))) return;
    arrowPointer = null;
    updateInteraction();
  }

  stage.addChild(scene.root);
  resize();
  renderer.on('resize', resize);
  const tick = () => {
    const now = performance.now();
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
    checkBoardSettled();
    advanceScore(now);
    scene.showMatchTail(now);
  };
  ticker.add(tick);
  canvas.addEventListener('pointerdown', down, options);
  canvas.addEventListener('pointerleave', leave, options);
  canvas.addEventListener('lostpointercapture', cancel, options);
  window.addEventListener('pointermove', track, options);
  window.addEventListener('pointerup', up, options);
  window.addEventListener('pointercancel', cancel, options);
  window.addEventListener('blur', () => {
    if (pending || scene.stackUnlockAnimating) {
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
    showResultsIfSettled();
  }, options);

  const close = () => scene.root.destroy({ children: true });
  stage.once('destroyed', close);
  scene.root.once('destroyed', () => {
    results?.close();
    events.abort();
    canvas.style.touchAction = touchAction;
    renderer.off('resize', resize);
    ticker.remove(tick);
    stage.off('destroyed', close);
  });
}
