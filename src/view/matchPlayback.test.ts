import { Bounds, DOMAdapter, Sprite, Text, Texture, TextureSource } from 'pixi.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { type DoughInsert, type GameState, move } from '../game';
import { StackGestures } from './gestures';
import { BOARD_FOOTER_SPACE, BOARD_TOP, layoutStacks, VIEW_WIDTH } from './layout';
import { MatchEffect } from './matchEffect';
import { awardFrame, beginMatch, matchFrame, matchLaunches, type MatchPlayback, matchPopTime, scoreSize } from './matchPlayback';
import { FLIGHT_MS, LAND_MS } from './movePlayback';
import { GameScene } from './scene';

const playback: MatchPlayback = {
  from: 0, to: 1, color: 'red', runLength: 3, points: 110, started: 0, reduced: false, arrivalMs: 220, clearMs: 320,
};

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
      effect.showTail(time);
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
    expect(award.children.map(child => (child as Text).text)).toEqual(['+110', '+110']);
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
    tick(firstPop + 420);
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
          effect.showTail(time);
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
    effect.showTail(430);
    expect(bursts.visible).toBe(true);

    const match = { ...playback, points: 170, started: 500, reduced: true, arrivalMs: 0, clearMs: 230 };
    effect.start(match, geometry, Texture.WHITE);
    effect.showPieces(matchFrame(match, 500));
    const positions = Array.from({ length: 3 }, (_, index) => [200, 280 + (2 - index) * 20, 0]);
    expect(visible().map(piece => [piece.x, piece.y, piece.rotation])).toEqual(positions);
    expect(visible().every(piece => piece.tint !== 0xffffff)).toBe(true);
    effect.showPieces(matchFrame(match, 700));
    effect.showTail(700);
    expect(visible().map(piece => [piece.x, piece.y, piece.rotation])).toEqual(positions);
    expect(visible().every(piece => piece.alpha < 1 && piece.width === geometry.width)).toBe(true);
    expect(bursts.visible).toBe(false);
    expect(bursts.children.every(child => !child.visible)).toBe(true);
    expect(award.children.map(child => (child as Text).text)).toEqual(['+170', '+170']);
    expect(award.scale).toMatchObject({ x: 1, y: 1 });
    effect.showPieces(matchFrame(match, 730));
    expect(donuts.visible).toBe(false);
    effect.root.destroy({ children: true });
  });

  it('hides only the incoming donut and the matched destination layers', () => {
    const scene = makeScene();
    const before: GameState = {
      stacks: [['blue', 'red'], ['red', 'green', 'red', 'red', 'red'], ['red', 'red']],
      score: 390, level: 2, rank: 'Pastry Pupil', capacity: 6, nextLevelScore: 1500, movesLeft: 7, gameOver: false,
    };
    const match = beginMatch(before, { ...before, score: 500 }, 0, 1, 0, false)!;
    expect(match.runLength).toBe(4);
    scene.draw(before, 0, 7);
    const visibility = () => scene['stacks'].map(stack => stack.pieces.map(layer => layer.visible));
    scene.startMatch(match);
    scene.showMatch(matchFrame(match, 110));
    expect(visibility()).toEqual([[true, false], [true, true, true, true, true], [true, true]]);
    scene.showMatch(matchFrame(match, 340));
    expect(visibility()).toEqual([[true, false], [true, true, false, false, false], [true, true]]);
    expect(scene['board'].alpha).toBe(1);
    scene.root.destroy({ children: true });
  });

  it('punches standard and larger awards on the first pop, then settles, floats and fades', () => {
    const high = { ...playback, points: 2500 };
    const pop = high.arrivalMs + matchPopTime(high.runLength, high.runLength - 1);
    const at = (age: number) => awardFrame(high, pop + age)!;
    expect(scoreSize(110)).toBe(24);
    expect(scoreSize(2500)).toBe(44);
    expect(awardFrame(playback, pop - 1)).toBeNull();
    expect(awardFrame(playback, pop + 48)).toMatchObject({ scaleX: 1.21, scaleY: 1.29, lift: 0, alpha: 1 });
    expect(at(48)).toMatchObject({ scaleX: expect.closeTo(1.34), scaleY: expect.closeTo(1.42), lift: 0, alpha: 1 });
    expect(at(149)).toMatchObject({ scaleX: 1, scaleY: 1, rotation: 0 });
    expect(at(500).lift).toBeGreaterThan(at(149).lift);
    expect(at(525).alpha).toBeLessThan(at(500).alpha);
    expect(awardFrame(high, pop + 550)).toBeNull();
  });

  it('suppresses score motion and accents and starts the reduced clear without flight', () => {
    const reduced = { ...playback, points: 2500, reduced: true, arrivalMs: 0, clearMs: 230 };
    expect(matchFrame(reduced, 0)).toEqual({ phase: 'clear', progress: 0 });
    expect(awardFrame(reduced, 25)).toMatchObject({ alpha: 0.5, scaleX: 1, scaleY: 1, rotation: 0, lift: 0 });
    expect(awardFrame(reduced, 180)).toMatchObject({ alpha: 1, scaleX: 1, scaleY: 1, rotation: 0, lift: 0 });
    expect(matchFrame(reduced, 230).phase).toBe('resolved');
  });
});

describe('move presentation', () => {
  const state: GameState = {
    stacks: [['blue'], ['green', 'red'], ['red']], score: 0, level: 5, rank: 'Glaze Guru',
    capacity: 7, nextLevelScore: 4500, movesLeft: 1, gameOver: false,
  };

  it('presses before selection and keeps the release hit area stable', () => {
    const scene = makeScene();
    scene.draw(state, 0, 7);
    const gestures = new StackGestures(() => true, () => true);
    const stack = scene['stacks'][0];
    const point = { x: stack.slot.x, y: stack.slot.base };
    const y = stack.top!.y;

    gestures.start(1, point, 0);
    expect(gestures.source).toBeNull();
    scene.showInteraction(gestures, false, null, 0, false);
    expect(stack.mark.visible).toBe(true);
    expect(stack.top!.scale.y).toBeLessThan(1);
    expect(stack.top!.y).toBe(y);
    expect(scene.hit(point)).toBe(0);

    gestures.finish(1, point, 0);
    scene.showInteraction(gestures, false, null, 1, false);
    expect(stack.top!.scale.y).toBe(1);
    expect(stack.top!.y).toBeLessThan(y);
    scene.showInteraction(gestures, false, null, 2, true);
    expect(stack.top!.y).toBe(y);
    expect(stack.mark.visible).toBe(true);
    scene.root.destroy({ children: true });
  });

  it('lands before a pressure refill pushes the receiving stack upward and settles', () => {
    const scene = makeScene();
    const before = { ...state, stacks: [['blue', 'red', 'green', 'blue'], ['green'], ['red', 'green', 'red', 'green']] };
    scene.draw(before, 0, 7);
    const start = scene.topPosition(0);
    let inserts: readonly DoughInsert[] = [];
    const resolved = move(before, 0, 1, () => 0, dough => { inserts = dough; });
    expect(inserts.map(insert => insert.stack)).toEqual([1, 0]);
    scene.draw(resolved, 0, 7);
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
    scene.draw({ ...state, movesLeft: 7 }, 0, 7);
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
    scene.draw({ ...state, stacks: [['blue'], ['red', 'red', 'red'], []] }, 0, 7);
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
    scene.draw({ ...state, gameOver: true, stacks: [['blue'], ['green', 'red', 'red'], []] }, 0, 7);
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
