import type { Application } from 'pixi.js';
import { canMove, createGame, move } from '../game';
import { StackGestures } from './gestures';
import { preloadScoreFont } from './matchEffect';
import { beginMatch, matchFrame, type MatchPlayback } from './matchPlayback';
import { type Feedback, GameScene, loadArt } from './scene';

export async function mountGame(app: Application): Promise<void> {
  const [art] = await Promise.all([loadArt(), preloadScoreFont().catch(error => {
    console.warn('The bundled score font could not be loaded.', error);
  })]);
  const scene = new GameScene(art);
  const { canvas, renderer, stage, ticker } = app;
  const window = canvas.ownerDocument.defaultView!;
  const events = new AbortController();
  const options = { signal: events.signal };
  const touchAction = canvas.style.touchAction;
  canvas.style.touchAction = 'none';

  let state = createGame();
  let levelStartScore = 0;
  const pressureLimit = state.movesLeft;
  let feedback: Feedback | null = null;
  let pending: { playback: MatchPlayback; levelUp: boolean } | null = null;
  const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
  const gestures = new StackGestures(index => state.stacks[index].length > 0, (from, to) => canMove(state, from, to));

  function updateInteraction(): void {
    const now = performance.now();
    if (feedback && now - feedback.started >= feedback.duration) feedback = null;
    const { source, destination } = gestures;
    const legal = source !== null && destination !== null && canMove(state, source, destination);
    scene.showInteraction(gestures, legal, feedback, now);
  }

  function draw(): void {
    scene.draw(state, levelStartScore, pressureLimit);
    updateInteraction();
  }

  function cancelPresentation(): void {
    pending = null;
    feedback = null;
    scene.cancelMatch();
  }

  function resize(): void {
    gestures.reset();
    cancelPresentation();
    scene.resize(app.screen.width, app.screen.height);
    draw();
  }

  function point(event: PointerEvent) {
    const rect = canvas.getBoundingClientRect();
    return scene.toLocal({
      x: (event.clientX - rect.left) * app.screen.width / (rect.width || 1),
      y: (event.clientY - rect.top) * app.screen.height / (rect.height || 1),
    });
  }

  function down(event: PointerEvent): void {
    if (pending || event.button !== 0) return;
    const position = point(event);
    if (!gestures.start(event.pointerId, position, scene.hit(position))) return;
    try {
      canvas.setPointerCapture(event.pointerId);
    } catch {
      // Window listeners also cover a pointer that could not be captured.
    }
  }

  function drag(event: PointerEvent): void {
    if (!gestures.owns(event.pointerId)) return;
    const position = point(event);
    if (gestures.update(event.pointerId, position, scene.hit(position))) updateInteraction();
  }

  function up(event: PointerEvent): void {
    if (!gestures.owns(event.pointerId)) return;
    const position = point(event);
    const action = gestures.finish(event.pointerId, position, scene.hit(position));
    if (action?.kind === 'restart') {
      state = createGame();
      levelStartScore = 0;
      cancelPresentation();
      gestures.reset();
      draw();
      return;
    }
    if (action?.kind === 'move') {
      const { from, to } = action;
      const before = state;
      // Commit once so an interrupted match can immediately draw the resolved board.
      state = move(before, from, to);
      const started = performance.now();
      const levelUp = state.level !== before.level;
      if (levelUp) levelStartScore = before.nextLevelScore;
      const playback = beginMatch(before, state, from, to, started, motion.matches);
      if (playback) {
        pending = { playback, levelUp };
        feedback = null;
        scene.startMatch(playback);
        scene.showMatch(matchFrame(playback, started));
        scene.showAward(started);
        return;
      }
      const newDough = state.movesLeft > before.movesLeft;
      const start = !motion.matches && !newDough ? scene.topPosition(from) : undefined;
      feedback = { target: to, started, duration: 280, start, color: before.stacks[from].at(-1) };
      draw();
      return;
    }
    if (action?.kind === 'blocked') {
      feedback = { target: action.to, started: performance.now(), duration: 750 };
    }
    updateInteraction();
  }

  function cancel(event: PointerEvent): void {
    if (gestures.cancel(event.pointerId)) updateInteraction();
  }

  stage.addChild(scene.root);
  resize();
  renderer.on('resize', resize);
  const tick = () => {
    const now = performance.now();
    if (pending) {
      const { playback, levelUp } = pending;
      const frame = matchFrame(playback, now);
      scene.showMatch(frame);
      if (frame.phase === 'resolved') {
        pending = null;
        if (levelUp) {
          feedback = { target: playback.to, started: now, duration: 750, color: playback.color, levelUp };
        }
        draw();
      }
    } else if (feedback) updateInteraction();
    scene.showAward(now);
  };
  ticker.add(tick);
  canvas.addEventListener('pointerdown', down, options);
  canvas.addEventListener('lostpointercapture', cancel, options);
  window.addEventListener('pointermove', drag, options);
  window.addEventListener('pointerup', up, options);
  window.addEventListener('pointercancel', cancel, options);
  window.addEventListener('blur', () => {
    if (pending) {
      cancelPresentation();
      draw();
    } else if (gestures.cancel()) updateInteraction();
  }, options);

  const close = () => scene.root.destroy({ children: true });
  stage.once('destroyed', close);
  scene.root.once('destroyed', () => {
    events.abort();
    canvas.style.touchAction = touchAction;
    renderer.off('resize', resize);
    ticker.remove(tick);
    stage.off('destroyed', close);
  });
}
