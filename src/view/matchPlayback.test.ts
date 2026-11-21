import { Bounds, DOMAdapter, Sprite, Text, Texture, TextureSource } from 'pixi.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DoughInsert, type GameState, move } from '../game';
import { StackGestures } from './gestures';
import { BOARD_FOOTER_SPACE, BOARD_TOP, layoutStacks, stackHit, VIEW_WIDTH } from './layout';
import { LevelCelebration } from './levelCelebration';
import { MatchEffect } from './matchEffect';
import {
  awardFrame, beginMatch, matchFrame, matchLaunches, type MatchPlayback, matchPopTime,
  scoreFlightFrame, scoreFlightPosition, scoreImpactTime, scoreSize,
} from './matchPlayback';
import { FLIGHT_MS, LAND_MS } from './movePlayback';
import { GameScene } from './scene';
import { ScoreBar } from './scoreBar';

const playback: MatchPlayback = {
  from: 0, to: 1, color: 'red', runLength: 3, points: 110, combo: 0, started: 0, reduced: false, arrivalMs: 220, clearMs: 320,
};
const counter = { x: 118, y: 84 };

function makeScene(): GameScene {
  vi.spyOn(Text.prototype, 'getLocalBounds').mockReturnValue(new Bounds(-34, -18, 34, 18));
  const imageData = (width: number, height: number) => ({ data: new Uint8ClampedArray(width * height * 4) });
  const context = {
    createRadialGradient: () => ({ addColorStop() {} }), fillRect() {}, drawImage() {}, putImageData() {},
    createImageData: imageData, getImageData: (_x: number, _y: number, width: number, height: number) => imageData(width, height),
  };
  vi.spyOn(DOMAdapter.get(), 'createCanvas').mockImplementation((width, height) =>
    ({ width, height, getContext: () => context }) as unknown as HTMLCanvasElement);
  vi.spyOn(Texture, 'from').mockReturnValue(new Texture({ source: new TextureSource({ width: 64, height: 64 }) }));
  const art = new Map(['kitchen', 'logo', 'clear', 'blue', 'red', 'green', 'gold', 'yellow'].map(name => [name, Texture.WHITE]));
  const scene = new GameScene(art);
  scene.resize(320, 568);
  return scene;
}

afterEach(() => vi.restoreAllMocks());

describe('match presentation', () => {
  it('compresses, launches and pops all three, with the award and fragments starting at the first pop', () => {
    vi.spyOn(Text.prototype, 'getLocalBounds').mockReturnValue(new Bounds(-34, -18, 34, 18));
    const effect = new MatchEffect();
    const [donuts, bursts, award] = effect.root.children;
    const visible = () => donuts.children.filter((child): child is Sprite => child instanceof Sprite && child.visible);
    const geometry = { start: { x: 70, y: 350 }, landing: { x: 200, y: 325 }, width: 100, height: 75, step: 24, viewHeight: 700 };
    const launches = matchLaunches(playback, geometry);
    const firstPop = playback.arrivalMs + matchPopTime(3, 2);
    const tick = (time: number) => {
      effect.showPieces(matchFrame(playback, time));
      effect.showTail(time, counter);
    };
    effect.start(playback, geometry, Texture.WHITE);

    tick(110);
    expect(visible()).toHaveLength(1);
    expect(visible()[0].x).toBeGreaterThan(geometry.start.x);
    expect(bursts.visible).toBe(false);
    expect(award.visible).toBe(false);

    tick(220);
    expect(visible()).toHaveLength(3);
    expect(visible().at(-1)?.position).toMatchObject(geometry.landing);
    const seated = visible().map(piece => ({ y: piece.y, height: piece.height }));
    tick(250);
    expect(visible()[0]).toMatchObject(seated[0]);
    expect(visible().at(-1)!.height).toBeLessThan(seated[2].height);
    tick(320);
    expect(visible().at(-1)!.height).toBeGreaterThan(seated[2].height);

    tick(firstPop - 1);
    expect(visible().every((piece, index) => piece.y < seated[index].y - 70 && piece.texture === Texture.WHITE)).toBe(true);
    expect(Math.min(...visible().map(piece => piece.x))).toBeLessThan(geometry.landing.x - 70);
    expect(Math.max(...visible().map(piece => piece.x))).toBeGreaterThan(geometry.landing.x + 70);
    expect(bursts.visible).toBe(false);
    expect(award.visible).toBe(false);

    tick(firstPop);
    const leadFlash = effect['burstPool'][2].flash;
    expect(leadFlash.visible).toBe(true);
    expect(leadFlash.position).toMatchObject(launches[2].burst);
    expect(award.visible).toBe(true);
    expect(award.children.filter(child => child.visible).map(child => (child as Text).text)).toEqual(['+110', '+110']);
    expect(effect['burstPool'][2].fragments.some(fragment => fragment.tint === 0xef3e48)).toBe(true);
    tick(firstPop + 14);
    expect(visible()[2].width).toBeLessThan(geometry.width / 2);
    tick(firstPop + 32);
    expect(visible()).toHaveLength(2);
    expect(effect['burstPool'][1].flash.visible).toBe(false);
    tick(firstPop + 38);
    expect(effect['burstPool'][1].flash.position).toMatchObject(launches[1].burst);
    expect(effect['burstPool'][1].flash.visible).toBe(true);

    tick(520);
    expect(visible()).toHaveLength(0);
    tick(540);
    expect(donuts.visible).toBe(false);
    expect(bursts.visible).toBe(true);
    expect(award.visible).toBe(true);
    tick(640);
    expect(bursts.visible).toBe(false);
    expect(award.visible).toBe(true);
    tick(scoreImpactTime(playback));
    expect(award.visible).toBe(false);
    effect.root.destroy({ children: true });
  });

  it.each([[3, 3, 540], [3, 6, 540], [6, 9, 540], [8, 10, 540], [8, 10, 740]])(
    'keeps the %i-stack formation and %i-donut launch within the %i-high board', (count, runLength, viewHeight) => {
      vi.spyOn(Text.prototype, 'getLocalBounds').mockReturnValue(new Bounds(-34, -18, 34, 18));
      const effect = new MatchEffect();
      const { slots, donutWidth: width, donutHeight: height, step } = layoutStacks(viewHeight, count);
      const [donuts, bursts] = effect.root.children;
      const match = { ...playback, runLength };

      for (const target of slots) {
        const geometry = { start: { x: 200, y: 320 }, landing: { x: target.x, y: target.base - (runLength - 1) * step },
          width, height, step, viewHeight };
        effect.start(match, geometry, Texture.WHITE);
        const launches = matchLaunches(match, geometry);
        expect(launches.every(({ seat, apex }) => seat.y - apex.y > height * 0.14)).toBe(true);
        for (const [index, launch] of launches.entries()) {
          const others = launches.slice(index + 1);
          expect(others.every(other => Math.hypot(launch.burst.x - other.burst.x,
            launch.burst.y - other.burst.y) > height * 0.67)).toBe(true);
        }
        for (let time = 220; time <= 640; time += 8) {
          effect.showPieces(matchFrame(match, time));
          effect.showTail(time, counter);
          for (const layer of [donuts, bursts]) {
            if (!layer.visible) continue;
            for (const child of layer.children.filter(child => child.visible)) {
              const bounds = child.getBounds();
              expect(bounds.minX).toBeGreaterThanOrEqual(0);
              expect(bounds.maxX).toBeLessThanOrEqual(VIEW_WIDTH);
              expect(bounds.minY).toBeGreaterThanOrEqual(BOARD_TOP);
              expect(bounds.maxY).toBeLessThanOrEqual(viewHeight - BOARD_FOOTER_SPACE);
            }
          }
        }
      }
      effect.root.destroy({ children: true });
    },
  );

  it('fades in place under reduced motion even after reusing a normal match effect', () => {
    vi.spyOn(Text.prototype, 'getLocalBounds').mockReturnValue(new Bounds(-34, -18, 34, 18));
    const effect = new MatchEffect();
    const [donuts, bursts, award] = effect.root.children;
    const visible = () => donuts.children.filter((child): child is Sprite => child instanceof Sprite && child.visible);
    const geometry = { start: { x: 70, y: 310 }, landing: { x: 200, y: 280 }, width: 80, height: 60, step: 20, viewHeight: 700 };
    effect.start({ ...playback, runLength: 8 }, geometry, Texture.WHITE);
    effect.showTail(430, counter);
    expect(bursts.visible).toBe(true);

    const match = { ...playback, points: 170, started: 500, reduced: true, arrivalMs: 0, clearMs: 230 };
    effect.start(match, geometry, Texture.WHITE);
    effect.showPieces(matchFrame(match, 500));
    const positions = Array.from({ length: 3 }, (_, index) => [200, 280 + (2 - index) * 20, 0]);
    expect(visible().map(piece => [piece.x, piece.y, piece.rotation])).toEqual(positions);
    expect(visible().every(piece => piece.tint !== 0xffffff)).toBe(true);
    effect.showPieces(matchFrame(match, 700));
    effect.showTail(700, counter);
    expect(visible().map(piece => [piece.x, piece.y, piece.rotation])).toEqual(positions);
    expect(visible().every(piece => piece.alpha < 1 && piece.width === geometry.width)).toBe(true);
    expect(bursts.visible).toBe(false);
    expect(bursts.children.every(child => !child.visible)).toBe(true);
    expect(award.children.filter(child => child.visible).map(child => (child as Text).text)).toEqual(['+170', '+170']);
    expect(award.scale).toMatchObject({ x: 1, y: 1 });
    effect.showPieces(matchFrame(match, 730));
    expect(donuts.visible).toBe(false);
    effect.root.destroy({ children: true });
  });

  it.each([
    { combo: 2, reduced: false },
    { combo: 3, reduced: true },
    { combo: 12, reduced: false },
  ])('keeps the $combo× award together at both board edges (reduced motion: $reduced)', ({ combo, reduced }) => {
    const pointsBounds = new Bounds(-34, -18, 34, 18);
    const comboBounds = new Bounds(-63, -10, 63, 10);
    vi.spyOn(Text.prototype, 'getLocalBounds').mockImplementation(function (this: Text) {
      return this.text.endsWith(' Combo') ? comboBounds : pointsBounds;
    });
    const effect = new MatchEffect();
    const award = effect.root.children[2];
    const labels = () => award.children.filter(child => child.visible).map(child => (child as Text).text);
    const match = { ...playback, runLength: 10, combo, reduced, arrivalMs: reduced ? 0 : 220 };
    const onset = match.arrivalMs + (reduced ? 0 : matchPopTime(10, 9));
    const viewHeight = 540;
    const { slots, donutWidth: width, donutHeight: height, step } = layoutStacks(viewHeight, 8);

    for (const slot of [slots[4], slots[7]]) {
      const geometry = { start: { x: 200, y: 320 }, landing: { x: slot.x, y: slot.base - 9 * step }, width, height, step, viewHeight };
      effect.start(match, geometry, Texture.WHITE);
      effect.showTail(onset - 1, counter);
      expect(award.visible).toBe(false);
      expect(labels()).toEqual(['+110', '+110', `${combo}× Combo`]);
      const [outline, , streak] = award.children;
      expect(streak.y + comboBounds.minY).toBeGreaterThan(outline.y + pointsBounds.maxY);

      for (const time of [onset + 12, onset + 48, onset + 149, reduced ? onset + 400 : 579]) {
        effect.showTail(time, counter);
        expect(award.visible).toBe(true);
        expect(award.alpha).toBeGreaterThan(0);
        for (const label of [outline, streak]) {
          const bounds = (label as Text).getLocalBounds();
          for (const x of [bounds.minX, bounds.maxX]) {
            for (const y of [bounds.minY, bounds.maxY]) {
              const point = label.toGlobal({ x, y });
              expect(point.x).toBeGreaterThanOrEqual(0);
              expect(point.x).toBeLessThanOrEqual(VIEW_WIDTH);
              expect(point.y).toBeGreaterThanOrEqual(BOARD_TOP);
              expect(point.y).toBeLessThanOrEqual(viewHeight - BOARD_FOOTER_SPACE);
            }
          }
        }
      }
      if (reduced) {
        expect(award.scale).toMatchObject({ x: 1, y: 1 });
        expect(award.rotation).toBe(0);
      }
      if (!reduced) {
        const comboPoint = streak.toGlobal({ x: 0, y: 0 });
        effect.showTail(700, counter);
        expect(streak.toGlobal({ x: 0, y: 0 })).toEqual(comboPoint);
        expect(outline.toGlobal({ x: 0, y: 0 }).y).toBeLessThan(comboPoint.y - 24);
        expect(effect.root.children[3].visible).toBe(true);
        effect.showTail(scoreImpactTime(match) - 0.01, counter);
        expect(outline.toGlobal({ x: 0, y: 0 })).toMatchObject({
          x: expect.closeTo(counter.x, 1), y: expect.closeTo(counter.y, 1),
        });
      } else {
        expect(effect.root.children[3].visible).toBe(false);
      }
      effect.showTail(reduced ? onset + 420 : scoreImpactTime(match), counter);
      expect(award.visible).toBe(false);
      effect.start({ ...match, combo: 1 }, geometry, Texture.WHITE);
      effect.showTail(onset + 50, counter);
      expect(labels()).toEqual(['+110', '+110']);
      expect((streak as Text).text).toBe('');
    }
    effect.root.destroy({ children: true });
  });

  it('hides only the incoming donut and the matched destination layers', () => {
    const scene = makeScene();
    const before: GameState = {
      stacks: [['blue', 'red'], ['red', 'green', 'red', 'red', 'red'], ['red', 'red']],
      score: 390, level: 2, rank: 'Pastry Pupil', capacity: 6, nextLevelScore: 1500, movesLeft: 7, gameOver: false,
    };
    const match = beginMatch(before, { ...before, score: 500 }, 0, 1, 0, false)!;
    expect(match).toMatchObject({ runLength: 4, combo: 0, points: 110 });
    scene.draw(before, 7);
    const gestures = new StackGestures(() => true, () => true);
    const point = scene.topPosition(0);
    gestures.start(1, point, 0);
    gestures.finish(1, point, 0);
    scene.showInteraction(gestures, { point, destination: 1, blocked: false }, null, 0, false);
    expect(scene['arrow'].root.visible).toBe(true);
    const visibility = () => scene['stacks'].map(stack => stack.pieces.map(layer => layer.visible));
    scene.startMatch(match);
    expect(scene['arrow'].root.visible).toBe(false);
    scene.showMatch(matchFrame(match, 110));
    expect(visibility()).toEqual([[true, false], [true, true, true, true, true], [true, true]]);
    scene.showMatch(matchFrame(match, 340));
    expect(visibility()).toEqual([[true, false], [true, true, false, false, false], [true, true]]);
    expect(scene['board'].alpha).toBe(1);
    scene.root.destroy({ children: true });
  });

  it('punches standard and larger awards on the first pop, holds through the last pop, then flies to the counter', () => {
    const high = { ...playback, points: 2500 };
    const pop = high.arrivalMs + matchPopTime(high.runLength, high.runLength - 1);
    const at = (age: number) => awardFrame(high, pop + age)!;
    expect(scoreSize(110)).toBe(24);
    expect(scoreSize(2500)).toBe(44);
    expect(awardFrame(playback, pop - 1)).toBeNull();
    expect(awardFrame(playback, pop + 48)).toMatchObject({ scaleX: 1.21, scaleY: 1.29, alpha: 1 });
    expect(at(48)).toMatchObject({ scaleX: expect.closeTo(1.34), scaleY: expect.closeTo(1.42), alpha: 1 });
    expect(at(149)).toMatchObject({ scaleX: 1, scaleY: 1, rotation: 0 });
    expect(at(165).alpha).toBe(1);
    expect(at(166)).toBeNull();
    expect(scoreFlightFrame(high, 579)).toBeNull();
    expect(scoreFlightFrame(high, 580)).toBe(0);
    expect(scoreFlightFrame(high, 715)).toBe(0.5);
    expect(scoreFlightFrame(high, scoreImpactTime(high))).toBeNull();
    const origin = { x: 330, y: 320 };
    expect(scoreFlightPosition(origin, counter, 0)).toEqual(origin);
    expect(scoreFlightPosition(origin, counter, 1)).toEqual(counter);
  });

  it('suppresses score motion and accents and starts the reduced clear without flight', () => {
    const reduced = { ...playback, points: 2500, reduced: true, arrivalMs: 0, clearMs: 230 };
    expect(matchFrame(reduced, 0)).toEqual({ phase: 'clear', progress: 0 });
    expect(awardFrame(reduced, 25)).toMatchObject({ alpha: 0.5, scaleX: 1, scaleY: 1, rotation: 0 });
    expect(awardFrame(reduced, 180)).toMatchObject({ alpha: 1, scaleX: 1, scaleY: 1, rotation: 0 });
    expect(scoreFlightFrame(reduced, 280)).toBeNull();
    expect(scoreImpactTime(reduced)).toBe(230);
    expect(matchFrame(reduced, 230).phase).toBe('resolved');
  });

  it('keeps the older score flight visible while the next normal match arrives', () => {
    const scene = makeScene();
    const board: GameState = {
      stacks: [['red'], ['red', 'red'], ['blue']], score: 0, level: 1, rank: 'Dough Enthusiast',
      capacity: 5, nextLevelScore: 500, movesLeft: 7, gameOver: false,
    };
    scene.draw(board, 7);
    scene.startMatch(playback);
    scene.showMatch(matchFrame(playback, 540));
    scene.draw(board, 7);
    const next = { ...playback, started: 540 };
    scene.startMatch(next);
    scene.showMatch(matchFrame(next, 700));
    scene.showMatchTail(700);
    const [first, second] = scene['matchPool'];
    expect(first['glaze'].visible).toBe(true);
    expect(second['donuts'].visible).toBe(true);
    scene.showMatchTail(850);
    expect(first.active).toBe(false);
    expect(second.active).toBe(true);
    scene.root.destroy({ children: true });
  });
});

describe('score and level effects', () => {
  it('fits and punches the exact large score and uses a stationary highlight in reduced motion', () => {
    vi.spyOn(Text.prototype, 'getLocalBounds').mockReturnValue(new Bounds(-210, -14, 0, 14));
    const bar = new ScoreBar();
    const score = 123456789.5;
    bar.draw({ score, level: 8, rank: 'Doughnut Dynamo', nextLevelScore: score * 2, levelStartScore: 0 });
    const digits = bar['score'];
    const fitted = digits.scale.x;
    expect(digits.text).toBe(new Intl.NumberFormat().format(score));
    bar.credit(0, false);
    bar.showEffects(36);
    expect(digits.scale.x).toBeCloseTo(fitted * 1.27);
    expect(digits.getLocalBounds().width * digits.scale.x).toBeLessThan(bar.creditTarget.x);
    expect(bar['glow'].visible).toBe(true);

    bar.credit(100, true);
    bar.showEffects(100);
    const glow = bar['glow'].alpha;
    bar.showEffects(200);
    expect(bar['glow'].visible).toBe(true);
    expect(bar['glow'].alpha).toBe(glow);
    expect(digits.scale.x).toBe(fitted);
    bar.showEffects(255);
    expect(bar['glow'].visible).toBe(false);
    bar.root.destroy({ children: true });
  });

  it('shows the exact rank and static board focus without rays or stars in reduced motion', () => {
    vi.spyOn(Text.prototype, 'getLocalBounds').mockReturnValue(new Bounds(-34, -18, 34, 18));
    const level = new LevelCelebration();
    const { root } = level;
    const [markers, rays, particles, hero] = root.children;
    level.start({ level: 3, rank: 'Fryer Fighter', upgrade: { kind: 'stack', firstNewStack: 3, stackCount: 4 } },
      [{ x: 320, y: 300, width: 65, height: 86 }], 0, true, 540);
    expect(hero.children.slice(1).map(child => (child as Text).text)).toEqual(['Level 3', 'Fryer Fighter', 'New stack']);
    expect(markers.getLocalBounds().width).toBeGreaterThan(60);
    expect(rays.visible).toBe(false);
    expect(particles.visible).toBe(false);
    const position = { x: hero.x, y: hero.y };
    level.show(500);
    expect(hero.position).toMatchObject(position);
    expect(hero.scale.x).toBe(1);
    level.show(1040);
    expect(root.visible).toBe(false);
    root.destroy({ children: true });
  });
});

describe('move presentation', () => {
  const state: GameState = {
    stacks: [['blue'], ['green', 'red'], ['red']], score: 0, level: 5, rank: 'Glaze Guru',
    capacity: 7, nextLevelScore: 4500, movesLeft: 1, gameOver: false,
  };

  it('presses before selection and keeps the release hit area stable', () => {
    const scene = makeScene();
    scene.draw(state, 7);
    const gestures = new StackGestures(() => true, () => true);
    const stack = scene['stacks'][0];
    const point = { x: stack.slot.x, y: stack.slot.base };
    const y = stack.top!.y;

    gestures.start(1, point, 0);
    expect(gestures.source).toBeNull();
    scene.showInteraction(gestures, null, null, 0, false);
    expect(scene['arrow'].root.visible).toBe(false);
    expect(stack.top!.scale.y).toBeLessThan(1);
    expect(stack.top!.y).toBe(y);
    expect(scene.hit(point)).toBe(0);

    gestures.finish(1, point, 0);
    scene.showInteraction(gestures, null, null, 1, false);
    scene.showInteraction(gestures, null, null, 106, false);
    expect(stack.top!.scale.y).toBe(1);
    expect(stack.top!.y).toBeLessThan(y);
    scene.showInteraction(gestures, null, null, 107, true);
    expect(stack.top!.y).toBe(y);
    expect(scene['selectionCue'].visible).toBe(true);
    scene.root.destroy({ children: true });
  });

  it('anchors the arrow to the lifted source and visible top or first empty seat', () => {
    const scene = makeScene();
    scene.draw({ ...state, stacks: [['blue', 'red', 'green'], ['red'], []] }, 7);
    const arrow = scene['arrow'];
    const show = vi.spyOn(arrow, 'show');
    const [source, target, empty] = scene['stacks'];
    const center = scene['layout'].donutHeight * 0.58;
    const gestures = new StackGestures(index => index !== 2, () => true);
    const point = { x: source.slot.x, y: source.slot.base };
    gestures.start(1, point, 0);
    gestures.finish(1, point, 0);

    const preview = { point, destination: 1, blocked: false };
    scene.showInteraction(gestures, preview, null, 0, false);
    expect(source.top!.y).toBe(source.topY);
    scene.showInteraction(gestures, preview, null, 35, false);
    expect(scene.selectionAnimating).toBe(true);
    expect(source.top!.rotation).toBeGreaterThan(0.025);
    expect(show.mock.lastCall?.[0]).toEqual({
      x: source.top!.x + Math.sin(source.top!.rotation) * center,
      y: source.top!.y - Math.cos(source.top!.rotation) * center,
    });
    scene.showInteraction(gestures, { ...preview, destination: 2 }, null, 2565, false);
    expect(source.top!.rotation).toBeLessThan(-0.04);
    scene.showInteraction(gestures, preview, null, 2835, false);
    expect(scene.selectionAnimating).toBe(true);
    expect(source.top!.rotation).toBeGreaterThan(0.04);
    expect(source.top!.y).toBeLessThan(source.topY);
    expect(arrow.root.eventMode).toBe('none');
    expect(arrow.root.visible).toBe(true);
    expect(show).toHaveBeenLastCalledWith(
      { x: source.top!.x + Math.sin(source.top!.rotation) * center,
        y: source.top!.y - Math.cos(source.top!.rotation) * center },
      { x: target.top!.x, y: target.top!.y - center }, 'move',
    );

    scene.showInteraction(gestures, { ...preview, destination: 2 }, null, 271, true);
    expect(source.top!.y).toBe(source.topY);
    expect(show).toHaveBeenLastCalledWith(
      { x: source.top!.x, y: source.topY - center }, { x: empty.slot.x, y: empty.slot.base - center }, 'move',
    );
    scene.showInteraction(gestures, { ...preview, blocked: true }, null, 272, true);
    expect(show.mock.lastCall?.[2]).toBe('blocked');
    const gap = { x: 195, y: 230 };
    const pathStarts = vi.spyOn(arrow.root, 'moveTo');
    const filledTip = vi.spyOn(arrow.root, 'poly');
    scene.showInteraction(gestures, { point: gap, destination: null, blocked: false }, null, 273, true);
    expect(show.mock.lastCall?.slice(1)).toEqual([gap, 'gap']);
    expect(pathStarts.mock.calls.length).toBeGreaterThan(4);
    expect(filledTip).not.toHaveBeenCalled();
    scene.showInteraction(gestures, { ...preview, destination: 0 }, null, 274, true);
    expect(arrow.root.visible).toBe(false);
    const close = { x: source.top!.x + 4, y: source.topY - center };
    scene.showInteraction(gestures, { point: close, destination: null, blocked: false }, null, 275, true);
    expect(arrow.root.visible).toBe(false);
    scene.root.destroy({ children: true });
  });

  it('keeps wiggling after pointer cancellation and restores artwork on deselection or resize', () => {
    const scene = makeScene();
    scene.draw(state, 7);
    const gestures = new StackGestures(() => true, () => true);
    const stack = scene['stacks'][0];
    const point = scene.topPosition(0);
    const tap = () => {
      gestures.start(1, point, 0);
      gestures.finish(1, point, 0);
    };
    tap();
    scene.showInteraction(gestures, null, null, 0, false);
    gestures.start(1, point, 0);
    gestures.cancel(1);
    scene.showInteraction(gestures, null, null, 35, false);
    expect(scene.selectionAnimating).toBe(true);
    expect(stack.top!.rotation).toBeGreaterThan(0.025);
    expect(stack.top!.y).toBeLessThan(stack.topY);
    tap();
    scene.showInteraction(gestures, null, null, 50, false);
    expect(stack.top!.y).toBe(stack.topY);
    tap();
    scene.showInteraction(gestures, null, null, 60, false);
    scene.showInteraction(gestures, null, null, 95, false);
    expect(stack.top!.rotation).not.toBe(0);
    scene.resize(390, 662);
    expect(stack.top!.rotation).toBe(0);
    expect(stack.top!.y).toBe(stack.topY);
    expect(scene.selectionAnimating).toBe(false);
    scene.root.destroy({ children: true });
  });

  it.each([[320, 568], [390, 662]])('replays the empty-slot edge tap at %i×%i', (width, height) => {
    const scene = makeScene();
    scene.resize(width, height);
    scene.draw({ ...state, stacks: [['gold', 'blue', 'red'], [], ['green']] }, 7);
    const { slots, donutHeight, step } = scene['layout'];
    const source = { x: slots[0].x, y: slots[0].base - 32 };
    const nearEmpty = { x: slots[1].x, y: stackHit(slots[1], 0, donutHeight, step).y - 10 };
    const gestures = new StackGestures(index => index !== 1, () => true);
    gestures.start(1, source, scene.hit(source, 'tap'));
    gestures.finish(1, source, scene.hit(source, 'swipe'));
    expect(gestures.source).toBe(0);
    expect(scene.hit(nearEmpty)).toBeNull();
    gestures.start(1, nearEmpty, scene.hit(nearEmpty, 'tap'));
    expect(gestures.finish(1, nearEmpty, scene.hit(nearEmpty, 'swipe'))).toEqual({ kind: 'move', from: 0, to: 1 });
    scene.root.destroy({ children: true });
  });

  it.each([[320, 568], [390, 662]])('keeps exact targets ahead of nearby snaps in two rows at %i×%i', (width, height) => {
    const scene = makeScene();
    scene.resize(width, height);
    const stacks = [['gold'], [], ['green'], ['blue'], [], ['red'], Array<string>(10).fill('green'), ['gold']];
    scene.draw({ ...state, capacity: 10, stacks }, 7);
    const [, , , , empty, short, full] = scene['stacks'];
    const nearShort = { x: short.slot.x, y: short.hit.y - 18 };
    expect(scene.hit({ ...nearShort, y: short.hit.y - 10 }, 'tap')).toBe(5);
    expect(scene.hit(nearShort, 'tap')).toBeNull();
    expect(scene.hit(nearShort, 'swipe')).toBe(5);
    expect(scene.hit({ x: full.hit.x + 1, y: nearShort.y }, 'swipe')).toBe(6);
    expect(scene.hit({ x: empty.hit.x + empty.hit.width, y: nearShort.y }, 'swipe')).toBeNull();
    expect(scene.hit({ x: empty.hit.x - 3, y: empty.slot.base }, 'swipe')).toBe('outside');

    const source = { x: scene['stacks'][0].slot.x, y: scene['stacks'][0].slot.base };
    const gestures = new StackGestures(index => stacks[index].length > 0, (_from, to) => stacks[to].length < 10);
    gestures.start(1, source, scene.hit(source, 'tap'));
    gestures.update(1, nearShort, scene.hit(nearShort, 'swipe'));
    expect(gestures.destination).toBe(5);
    expect(gestures.finish(1, nearShort, scene.hit(nearShort, 'swipe'))).toEqual({ kind: 'move', from: 0, to: 5 });
    scene.root.destroy({ children: true });
  });

  it('lands before a pressure refill pushes the receiving stack upward and settles', () => {
    const scene = makeScene();
    const before = { ...state, stacks: [['blue', 'red', 'green', 'blue'], ['green'], ['red', 'green', 'red', 'green']] };
    scene.draw(before, 7);
    const start = scene.topPosition(0);
    let inserts: readonly DoughInsert[] = [];
    const resolved = move(before, 0, 1, () => 0, dough => { inserts = dough; });
    expect(inserts.map(insert => insert.stack)).toEqual([1, 0]);
    scene.draw(resolved, 7);
    const target = scene['stacks'][1];
    const [newDough, formerBase] = target.pieces;
    const top = target.top!;
    const finalY = top.y;
    const { base } = target.slot;
    const step = scene['layout'].step;
    const atCapacity = { x: target.slot.x, y: base + 10 };

    scene.startMove(inserts, 0, false, { to: 1, start, color: 'blue', pressure: { movesLeft: 7, limit: 7 } });
    expect(scene['flight'].visible).toBe(true);
    expect(top.visible).toBe(false);
    expect(newDough.alpha).toBe(0);
    expect(formerBase.y).toBe(base);
    expect(scene['pressure'].text).toBe('New dough');

    scene.showMove(FLIGHT_MS + 27);
    expect(scene['flight'].visible).toBe(false);
    expect(top.visible).toBe(true);
    expect(top.y).toBeCloseTo(finalY + step);
    expect(top.scale.y).toBeCloseTo(0.88);
    expect(newDough.alpha).toBe(0);
    expect(scene['pressure'].text).toBe('New dough');

    scene.showMove(FLIGHT_MS + LAND_MS + 42);
    expect(newDough.alpha).toBeGreaterThan(0);
    expect(newDough.y).toBe(base);
    expect(formerBase.y).toBeLessThan(base);
    expect(target.refillCue.visible).toBe(true);
    expect(scene['pressure'].text).toBe('New dough in 7');
    expect(scene.hit(atCapacity)).toBe(1);

    scene.finishMove();
    expect(formerBase.y).toBeCloseTo(base - step);
    expect(top.y).toBe(finalY);
    expect(top.scale.y).toBe(1);
    expect(newDough.alpha).toBe(1);
    expect(target.refillCue.visible).toBe(false);
    expect(scene.hit(atCapacity)).toBe(1);
    scene.root.destroy({ children: true });
  });

  it('shows a stationary full pressure rail before the refill and resets it if play interrupts', () => {
    const scene = makeScene();
    const inserts = [{ stack: 1, depth: 0, color: 'red' }];
    const transfer = { to: 1, start: { x: 100, y: 200 }, color: 'blue', pressure: { movesLeft: 7, limit: 7 } };
    scene.draw({ ...state, movesLeft: 7 }, 7);
    const { pieces } = scene['stacks'][1];
    const positions = pieces.map(piece => piece.y);

    scene.startMove(inserts, 0, true, transfer);
    scene.showMove(60);
    expect(scene['pressure'].text).toBe('New dough');
    expect(scene['flight'].visible).toBe(false);
    expect(pieces[0].alpha).toBe(0);
    scene.finishMove();
    expect(scene['pressure'].text).toBe('New dough in 7');
    expect(pieces.map(piece => piece.y)).toEqual(positions);

    scene.startMove(inserts, 100, true, transfer);
    scene.showMove(215);
    expect(scene['pressure'].text).toBe('New dough in 7');
    expect(pieces.map(piece => piece.y)).toEqual(positions);
    expect(pieces.map(piece => piece.scale.y)).toEqual([1, 1]);
    expect(pieces[0].alpha).toBeGreaterThan(0.6);
    scene.root.destroy({ children: true });
  });

  it('introduces repeated bottom inserts separately even when the donuts share a color', () => {
    const scene = makeScene();
    const inserts = [{ stack: 1, depth: 0, color: 'red' }, { stack: 1, depth: 0, color: 'red' }];
    scene.draw({ ...state, stacks: [['blue'], ['red', 'red', 'red'], []] }, 7);
    const { pieces: [second, first, original], slot } = scene['stacks'][1];

    scene.startMove(inserts, 0, false);
    scene.showMove(65);
    expect(first.alpha).toBeGreaterThan(0.75);
    expect(first.y).toBe(slot.base);
    expect(original.y).toBeLessThan(slot.base);
    expect(second.alpha).toBe(0);

    scene.showMove(175);
    expect(second.alpha).toBeGreaterThan(0.75);
    expect(second.y).toBe(slot.base);
    expect(first.y).toBeLessThan(second.y);
    expect(original.y).toBeLessThan(first.y);
    scene.showMove(300);
    expect(first.y - original.y).toBeCloseTo(second.y - first.y);
    scene.root.destroy({ children: true });
  });

  it('reveals top rescue dough in place in reduced motion and shows game over after the cue', () => {
    const scene = makeScene();
    scene.draw({ ...state, gameOver: true, stacks: [['blue'], ['green', 'red', 'red'], []] }, 7);
    const { pieces } = scene['stacks'][1];
    const positions = pieces.map(piece => piece.y);
    scene.startMove([{ stack: 1, depth: 1, color: 'red' }, { stack: 1, depth: 2, color: 'red' }], 0, true);
    expect(scene['overlay'].visible).toBe(false);
    expect(pieces.map(piece => piece.alpha)).toEqual([1, 0.6, 0.6]);
    scene.showMove(45);
    expect(pieces.map(piece => piece.y)).toEqual(positions);
    expect(pieces.map(piece => piece.scale.y)).toEqual([1, 1, 1]);
    scene.showMove(150);
    expect(scene['overlay'].visible).toBe(true);
    expect(pieces.map(piece => piece.alpha)).toEqual([1, 1, 1]);
    scene.root.destroy({ children: true });
  });
});
