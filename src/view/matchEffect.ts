import { Container, DOMAdapter, Graphics, GraphicsContext, Sprite, Text, type Texture } from 'pixi.js';
import type { Point } from './gestures';
import { BOARD_FOOTER_SPACE, BOARD_TOP, VIEW_WIDTH } from './layout';
import {
  awardFrame, clamp, launchedDonut, type MatchFrame, type MatchGeometry, matchLaunches, type MatchPlayback, scoreEmphasis, scoreSize,
} from './matchPlayback';
import { flightPosition, unit } from './movePlayback';

const FONT = 'Reborn Fredoka';
const CREAM = 0xfff3d1;
const SCORE_SCALE = 1.32;
const SPRINKLES = 6;
const STREAKS = 2;
const BURST_MS = 142;
const DONUT_FILLS: Record<string, number> = {
  gold: 0xff861b, red: 0xef3e48, yellow: 0xf6d62b, choco: 0xc97954,
  gray: 0x84929d, purple: 0x9c50ec, blue: 0x3049c8, green: 0x32c96a,
};
const number = new Intl.NumberFormat();
let fontReady: Promise<void> | undefined;

export function preloadScoreFont(): Promise<void> {
  if (typeof FontFace === 'undefined') return Promise.resolve();
  fontReady ??= new FontFace(FONT, `url("${import.meta.env.BASE_URL}fonts/Fredoka.ttf")`, { weight: '300 700' })
    .load().then(font => { DOMAdapter.get().getFontFaceSet()?.add(font); })
    .catch(error => { fontReady = undefined; throw error; });
  return fontReady;
}

function deepHue(color: number): number {
  const red = Math.round((color >> 16 & 255) * 0.48);
  const green = Math.round((color >> 8 & 255) * 0.48);
  const blue = Math.round((color & 255) * 0.48);
  return (red << 16) | (green << 8) | blue;
}

interface Burst {
  flash: Graphics;
  fragments: Graphics[];
}

export class MatchEffect {
  readonly root = new Container();
  private readonly donuts = new Container();
  private readonly bursts = new Container();
  private readonly award = new Container();
  private readonly sprinkleShape = new GraphicsContext().roundRect(-4, -1.5, 8, 3, 1.5).fill(0xffffff);
  private readonly streakShape = new GraphicsContext().poly([-9, 0, 1, -2.4, 7, 0, 1, 2.4]).fill(0xffffff);
  private readonly flashShape = new GraphicsContext()
    .poly([0, -22, 3.6, -4, 25, 0, 3.6, 4, 0, 22, -3.6, 4, -25, 0, -3.6, -4]).fill(CREAM)
    .poly([0, -10, 2, -2.2, 12, 0, 2, 2.2, 0, 10, -2, 2.2, -12, 0, -2, -2.2]).fill(0xffffff);
  private readonly pieces: Sprite[] = [];
  private readonly burstPool: Burst[] = [];
  private readonly outline: Text;
  private readonly face: Text;
  private origin: Point = { x: 0, y: 0 };
  private tiltDirection = 1;
  private current: {
    playback: MatchPlayback;
    geometry: MatchGeometry;
    texture: Texture;
    launches: ReturnType<typeof matchLaunches>;
  } | null = null;

  constructor() {
    const style = {
      fontFamily: [FONT, 'Comic Sans MS', 'cursive'],
      fontSize: 24 * SCORE_SCALE, fontWeight: '700' as const,
    };
    this.outline = new Text({ text: '', style: { ...style, stroke: { color: 0x734d13, width: 4.2 * SCORE_SCALE } } });
    this.face = new Text({ text: '', style: { ...style, stroke: { color: CREAM, width: 1.2 * SCORE_SCALE } } });
    this.outline.anchor.set(0.5);
    this.face.anchor.set(0.5);
    this.award.addChild(this.outline, this.face);
    this.root.addChild(this.donuts, this.bursts, this.award);
    this.root.once('destroyed', () => {
      this.sprinkleShape.destroy();
      this.streakShape.destroy();
      this.flashShape.destroy();
    });
    this.cancel();
  }

  start(playback: MatchPlayback, geometry: MatchGeometry, texture: Texture): void {
    this.cancel();
    const launches = playback.reduced ? [] : matchLaunches(playback, geometry);
    this.current = { playback, geometry, texture, launches };
    const fill = DONUT_FILLS[playback.color] ?? CREAM;
    const size = scoreSize(playback.points) * SCORE_SCALE;
    const emphasis = scoreEmphasis(playback.points);
    for (const layer of [this.outline, this.face]) {
      layer.text = `+${number.format(playback.points)}`;
      layer.style.fill = fill;
      layer.style.fontSize = size;
      layer.y = 0;
    }
    this.outline.style.stroke = { color: deepHue(fill), width: 4.2 * SCORE_SCALE };

    const bounds = this.outline.getLocalBounds();
    this.outline.y = this.face.y = -(bounds.minY + bounds.maxY) / 2;
    const labelWidth = 2 * Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX));
    const labelHeight = bounds.height;
    const peakX = playback.reduced ? 1 : 1.34;
    const peakY = playback.reduced ? 1 : 1.42;
    const tilt = playback.reduced ? 0 : 0.09;
    const marginX = (labelWidth * peakX + labelHeight * tilt) / 2 + 6;
    const marginY = (labelHeight * peakY + labelWidth * tilt) / 2 + 3;

    const { landing, height, viewHeight } = geometry;
    const lead = launches.at(-1)?.burst;
    const travel = playback.reduced ? 0 : 12 + 6 * emphasis;
    this.origin = {
      x: clamp(lead?.x ?? landing.x, marginX, VIEW_WIDTH - marginX),
      y: clamp(lead ? lead.y - marginY - 9 : landing.y - height - 20,
        BOARD_TOP + marginY + travel, viewHeight - BOARD_FOOTER_SPACE - marginY),
    };
    this.tiltDirection = landing.x < VIEW_WIDTH / 2 ? 1 : -1;
    this.prepareBursts(launches.length, fill);

    while (this.pieces.length < playback.runLength) {
      const piece = new Sprite(texture);
      piece.anchor.set(0.5, 1);
      this.pieces.push(this.donuts.addChild(piece));
    }
    this.pieces.forEach((piece, index) => {
      piece.visible = false;
      if (index < playback.runLength) {
        piece.texture = texture;
        piece.tint = 0xffffff;
      }
    });
    this.donuts.visible = true;
  }

  showPieces(frame: MatchFrame): void {
    if (!this.current) return;
    if (frame.phase === 'resolved') {
      this.donuts.visible = false;
      return;
    }

    const { playback, geometry, texture, launches } = this.current;
    const { start, landing, width, height, step } = geometry;
    const { runLength } = playback;
    const { phase, progress } = frame;
    if (phase === 'arrival') {
      const arc = clamp(Math.min(start.y, landing.y) - height - BOARD_TOP, 0, 45);
      const piece = this.pieces[runLength - 1];
      piece.visible = true;
      piece.alpha = 1;
      piece.rotation = 0;
      piece.scale.set(width / texture.width, height / texture.height);
      piece.position.copyFrom(flightPosition(start, landing, progress, arc));
      return;
    }

    const age = progress * playback.clearMs;
    for (let index = 0; index < runLength; index++) {
      const piece = this.pieces[index];
      const pose = playback.reduced ? {
        x: landing.x, y: landing.y + (runLength - 1 - index) * step,
        alpha: 1 - unit((age - 48) / (playback.clearMs - 48)), rotation: 0,
        scaleX: 1, scaleY: 1,
      } : launchedDonut(launches[index], geometry, age);
      piece.visible = pose !== null;
      if (!pose) continue;
      piece.alpha = pose.alpha;
      piece.rotation = pose.rotation;
      piece.scale.set(pose.scaleX * width / texture.width, pose.scaleY * height / texture.height);
      piece.position.copyFrom(pose);
      if (playback.reduced) piece.tint = 0xffeac4;
    }
  }

  showTail(now: number): void {
    const current = this.current;
    if (!current) return;
    const { playback, geometry, launches } = current;
    const age = now - playback.started - playback.arrivalMs;
    this.bursts.visible = false;
    launches.forEach(({ pop, burst }, index) => this.showBurst(index, age - pop, burst, geometry));

    const frame = awardFrame(playback, now);
    this.award.visible = frame !== null;
    if (!frame) {
      if (!this.donuts.visible && !this.bursts.visible) this.current = null;
      return;
    }
    this.award.position.set(this.origin.x, this.origin.y - frame.lift);
    this.award.scale.set(frame.scaleX, frame.scaleY);
    this.award.rotation = this.tiltDirection * frame.rotation;
    this.award.alpha = frame.alpha;
  }

  private prepareBursts(count: number, fill: number): void {
    while (this.burstPool.length < count) {
      const flash = this.bursts.addChild(new Graphics(this.flashShape));
      const fragments = Array.from({ length: SPRINKLES + STREAKS }, (_, index) =>
        this.bursts.addChild(new Graphics(index < SPRINKLES ? this.sprinkleShape : this.streakShape)));
      this.burstPool.push({ flash, fragments });
    }
    this.burstPool.forEach(({ flash, fragments }) => {
      flash.visible = false;
      fragments.forEach((fragment, index) => {
        fragment.visible = false;
        fragment.tint = index < SPRINKLES - 1 ? fill : CREAM;
      });
    });
  }

  private showBurst(index: number, age: number, origin: Point, { width, viewHeight }: MatchGeometry): void {
    const { flash, fragments } = this.burstPool[index];
    const active = age >= 0 && age < BURST_MS;
    flash.visible = active && age < 64;
    if (flash.visible) {
      const radius = Math.min(origin.x, VIEW_WIDTH - origin.x, origin.y - BOARD_TOP,
        viewHeight - BOARD_FOOTER_SPACE - origin.y);
      const scale = Math.min(radius / 25, 0.56 + 0.46 * unit(age / 28));
      flash.position.copyFrom(origin);
      flash.scale.set(scale);
      flash.alpha = (1 - unit(age / 64)) ** 1.1;
    }

    fragments.forEach((fragment, particle) => {
      fragment.visible = active;
      if (!active) return;
      const streak = particle >= SPRINKLES;
      const angle = particle * (2 * Math.PI / fragments.length) + index * 0.73;
      const progress = age / BURST_MS;
      const travel = 1 - (1 - progress) ** 2;
      const reach = Math.max(24, Math.min(46, width * 0.56)) * (0.69 + (particle % 3) * 0.19);
      const distance = (streak ? 1.27 : 1) * (5 + reach * travel);
      const edge = streak ? 10 : 6;
      fragment.position.set(
        clamp(origin.x + Math.cos(angle) * distance, edge, VIEW_WIDTH - edge),
        clamp(origin.y + Math.sin(angle) * distance + 12 * progress ** 2,
          BOARD_TOP + edge, viewHeight - BOARD_FOOTER_SPACE - edge),
      );
      fragment.rotation = angle + (streak ? 0 : progress * (particle % 2 ? 1.9 : -1.9));
      fragment.scale.set(streak ? 0.78 + 0.22 * travel : 0.98 - 0.35 * progress, 1 - 0.68 * progress);
      fragment.alpha = (1 - progress) ** (streak ? 2 : 0.85);
    });
    if (active) this.bursts.visible = true;
  }

  cancel(): void {
    this.current = null;
    this.donuts.visible = this.bursts.visible = this.award.visible = false;
  }
}
