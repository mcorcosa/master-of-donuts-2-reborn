import { Container, Graphics, GraphicsContext, Sprite, Text, type Texture } from 'pixi.js';
import { GAME_FONT_FAMILY, gameText } from './gameFont';
import type { Point } from './gestures';
import type { JokerArt } from './jokerArt';
import { BOARD_FOOTER_SPACE, BOARD_TOP, VIEW_WIDTH } from './layout';
import {
  awardFrame, clamp, clearStart, comboPopPeak, launchedDonut, type MatchFrame, type MatchGeometry, matchLaunches,
  type MatchPlayback, scoreFlightFrame, scoreFlightPosition, scorePopPeak, scoreSize,
} from './matchPlayback';
import { flightPosition, unit } from './movePlayback';

const CREAM = 0xfff3d1;
const COMBO_GAP = 5;
const SPRINKLES = 6;
const STREAKS = 2;
const BURST_MS = 142;
const DONUT_FILLS: Record<string, number> = {
  gold: 0xff861b, red: 0xef3e48, yellow: 0xf6d62b, choco: 0xc97954,
  gray: 0x84929d, purple: 0x9c50ec, blue: 0x3049c8, green: 0x32c96a,
};
const number = new Intl.NumberFormat();

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

type JokerMatchArt = Pick<JokerArt, 'texture' | 'morph'>;

export class MatchEffect {
  readonly root = new Container();
  private readonly donuts = new Container();
  private readonly bursts = new Container();
  private readonly award = new Container();
  private readonly score = new Container();
  private readonly comboBadge = new Container();
  private readonly comboBacking = new Graphics();
  private readonly glaze = new Container();
  private readonly trail = Array.from({ length: 6 }, (_, index) => this.glaze.addChild(new Graphics()
    .ellipse(0, 0, 4.5 - index * 0.38, 2.8 - index * 0.27).fill(0xffffff)));
  private readonly sprinkleShape = new GraphicsContext().roundRect(-4, -1.5, 8, 3, 1.5).fill(0xffffff);
  private readonly streakShape = new GraphicsContext().poly([-9, 0, 1, -2.4, 7, 0, 1, 2.4]).fill(0xffffff);
  private readonly flashShape = new GraphicsContext()
    .poly([0, -22, 3.6, -4, 25, 0, 3.6, 4, 0, 22, -3.6, 4, -25, 0, -3.6, -4]).fill(CREAM)
    .poly([0, -10, 2, -2.2, 12, 0, 2, 2.2, 0, 10, -2, 2.2, -12, 0, -2, -2.2]).fill(0xffffff);
  private readonly pieces: Sprite[] = [];
  private readonly burstPool: Burst[] = [];
  private readonly outline: Text;
  private readonly face: Text;
  private readonly combo: Text;
  private origin: Point = { x: 0, y: 0 };
  private scoreY = 0;
  private scoreFit = 1;
  private comboFit = 1;
  private current: {
    playback: MatchPlayback;
    geometry: MatchGeometry;
    texture: Texture;
    joker?: JokerMatchArt;
    launches: ReturnType<typeof matchLaunches>;
  } | null = null;

  constructor() {
    const style = {
      fontFamily: GAME_FONT_FAMILY,
      fontSize: scoreSize(0), fontWeight: '700' as const,
    };
    this.outline = new Text({ text: '', style: { ...style, stroke: { color: 0x734d13, width: 9, join: 'round' } } });
    this.face = new Text({ text: '', style: { ...style, stroke: { color: CREAM, width: 4, join: 'round' } } });
    this.combo = new Text({ text: '', style: {
      ...style, fontSize: 26, fill: CREAM,
    } });
    this.outline.anchor.set(0.5);
    this.face.anchor.set(0.5);
    this.combo.anchor.set(0.5);
    this.score.addChild(this.outline, this.face);
    this.comboBadge.addChild(this.comboBacking, this.combo);
    this.award.addChild(this.score, this.comboBadge);
    this.root.addChild(this.donuts, this.bursts, this.award, this.glaze);
    this.root.once('destroyed', () => {
      this.sprinkleShape.destroy();
      this.streakShape.destroy();
      this.flashShape.destroy();
    });
    this.cancel();
  }

  get active(): boolean {
    return this.current !== null;
  }

  *warmup(reduced: boolean): Generator<GraphicsContext | undefined> {
    // The first ordinary clear uses three pieces. Grow larger pools only on demand.
    for (let count = 1; count <= 3; count++) {
      this.ensurePieces(count);
      if (!reduced) this.ensureBursts(count);
      yield;
    }
    if (!reduced) {
      yield this.flashShape;
      yield this.sprinkleShape;
      yield this.streakShape;
    }
  }

  start(playback: MatchPlayback, geometry: MatchGeometry, texture: Texture, joker?: JokerMatchArt): void {
    this.cancel();
    const launches = playback.reduced ? [] : matchLaunches(playback, geometry);
    this.current = { playback, geometry, texture, launches, joker };
    const fill = DONUT_FILLS[playback.color] ?? CREAM;
    const { marginX, marginY } = this.prepareAward(playback, fill);
    this.trail.forEach((piece, index) => { piece.tint = index % 3 === 2 ? CREAM : fill; });

    const { landing, width, height, viewHeight } = geometry;
    const lead = launches.at(-1)?.burst;
    const preferredY = lead ? lead.y - marginY - 9 : landing.y - height - marginY - 5;
    const minimumY = BOARD_TOP + marginY;
    const anchorX = lead?.x ?? landing.x;
    const offset = playback.combo >= 2 && preferredY < minimumY ? marginX + (lead ? 25 : width / 2) : 0;
    this.origin = {
      x: clamp(anchorX + (anchorX < VIEW_WIDTH / 2 ? offset : -offset), marginX, VIEW_WIDTH - marginX),
      y: clamp(preferredY, minimumY, viewHeight - BOARD_FOOTER_SPACE - marginY),
    };
    this.prepareBursts(launches.length, fill);

    this.ensurePieces(playback.runLength);
    this.pieces.forEach((piece, index) => {
      piece.visible = false;
      if (index < playback.runLength) {
        piece.texture = texture;
        piece.tint = 0xffffff;
      }
    });
    this.donuts.visible = true;
  }

  private prepareAward(playback: MatchPlayback, fill: number) {
    const size = scoreSize(playback.points);
    const text = `+${number.format(playback.points)}`;
    for (const layer of [this.outline, this.face]) {
      layer.text = text;
      layer.style.fill = fill;
      layer.style.fontSize = size;
    }
    this.outline.style.stroke = { color: deepHue(fill), width: 9, join: 'round' };
    const bounds = this.outline.getLocalBounds();
    const x = -(bounds.minX + bounds.maxX) / 2;
    const y = -(bounds.minY + bounds.maxY) / 2;
    this.outline.position.set(x, y);
    this.face.position.set(x, y);
    this.scoreFit = Math.min(1, 248 / Math.max(1, bounds.width));
    const scorePeak = playback.reduced ? { x: 1, y: 1 } : scorePopPeak(playback.points);
    let halfWidth = bounds.width * this.scoreFit * scorePeak.x / 2;
    const scoreHeight = bounds.height * this.scoreFit * scorePeak.y;

    this.scoreY = 0;
    let extraHeight = 0;
    if (playback.combo >= 2) {
      this.combo.text = gameText(`${number.format(playback.combo)}× Combo`);
      const bounds = this.combo.getLocalBounds();
      this.combo.position.set(-(bounds.minX + bounds.maxX) / 2, -(bounds.minY + bounds.maxY) / 2);
      const width = bounds.width + 26;
      const height = bounds.height + 8;
      this.comboFit = Math.min(1, 232 / (width + 2));
      const comboPeak = playback.reduced ? 1 : comboPopPeak(playback.combo);
      const badgeHeight = (height + 2) * this.comboFit * comboPeak;
      const border = playback.combo >= 5 ? 0xffd477 : 0xe9ae73;
      this.comboBacking.clear().roundRect(-width / 2, -height / 2, width, height, height / 2)
        .fill(0x713526).stroke({ color: border, width: 2 });
      halfWidth = Math.max(halfWidth, (width + 2) * this.comboFit * comboPeak / 2);
      extraHeight = COMBO_GAP + badgeHeight;
      this.scoreY = -extraHeight / 2;
      this.comboBadge.y = (scoreHeight + COMBO_GAP) / 2;
    }
    return { marginX: halfWidth + 6, marginY: (scoreHeight + extraHeight) / 2 + 3 };
  }

  private ensurePieces(count: number): void {
    while (this.pieces.length < count) {
      const piece = new Sprite();
      piece.anchor.set(0.5, 1);
      piece.visible = false;
      this.pieces.push(this.donuts.addChild(piece));
    }
  }

  showPieces(frame: MatchFrame): void {
    if (!this.current) return;
    if (frame.phase === 'resolved') {
      this.donuts.visible = false;
      return;
    }

    const { playback, geometry, texture, launches, joker } = this.current;
    const { start, landing, width, height, step } = geometry;
    const { runLength, jokerIndex } = playback;
    const { phase, progress } = frame;
    if (phase === 'arrival') {
      const arc = clamp(Math.min(start.y, landing.y) - height - BOARD_TOP, 0, 45);
      const piece = this.pieces[runLength - 1];
      piece.texture = jokerIndex === runLength - 1 && joker ? joker.texture : texture;
      piece.visible = true;
      piece.alpha = 1;
      piece.rotation = 0;
      piece.scale.set(width / piece.texture.width, height / piece.texture.height);
      piece.position.copyFrom(flightPosition(start, landing, progress, arc));
      return;
    }

    const age = progress * playback.clearMs;
    for (let index = 0; index < runLength; index++) {
      const piece = this.pieces[index];
      piece.texture = phase === 'morph' && index === jokerIndex && joker ? joker.morph(texture, progress) : texture;
      const pose = phase === 'morph' || playback.reduced ? {
        x: landing.x, y: landing.y + (runLength - 1 - index) * step,
        alpha: phase === 'morph' ? 1 : 1 - unit((age - 48) / (playback.clearMs - 48)), rotation: 0,
        scaleX: 1, scaleY: 1,
      } : launchedDonut(launches[index], geometry, age);
      piece.visible = pose !== null;
      if (!pose) continue;
      piece.alpha = pose.alpha;
      piece.rotation = pose.rotation;
      piece.scale.set(pose.scaleX * width / piece.texture.width, pose.scaleY * height / piece.texture.height);
      piece.position.copyFrom(pose);
      if (playback.reduced) piece.tint = 0xffeac4;
    }
  }

  showTail(now: number, target: Point): void {
    const current = this.current;
    if (!current) return;
    const { playback, geometry, launches } = current;
    const age = now - clearStart(playback);
    this.bursts.visible = false;
    launches.forEach(({ pop, burst }, index) => this.showBurst(index, age - pop, burst, geometry));

    const frame = awardFrame(playback, now);
    const flight = scoreFlightFrame(playback, now);
    this.award.visible = frame !== null || flight !== null;
    this.glaze.visible = flight !== null;
    if (flight !== null) {
      this.flyScore(flight, target, playback.combo >= 2);
      return;
    }
    if (!frame) {
      if (!this.donuts.visible && !this.bursts.visible) this.current = null;
      return;
    }
    this.award.position.copyFrom(this.origin);
    this.award.alpha = frame.alpha;
    this.score.position.set(0, this.scoreY);
    this.score.scale.set(this.scoreFit * frame.scaleX, this.scoreFit * frame.scaleY);
    this.comboBadge.visible = playback.combo >= 2 && frame.comboAlpha > 0;
    this.comboBadge.alpha = frame.comboAlpha;
    this.comboBadge.scale.set(this.comboFit * frame.comboScale);
  }

  private flyScore(progress: number, target: Point, combo: boolean): void {
    const start = { x: this.origin.x, y: this.origin.y + this.scoreY };
    const position = scoreFlightPosition(start, target, progress);
    this.award.position.copyFrom(this.origin);
    this.award.alpha = 1;
    this.comboBadge.visible = combo && progress < 0.7;
    this.comboBadge.alpha = 1 - unit((progress - 0.24) / 0.46);
    this.comboBadge.scale.set(this.comboFit);
    const shrink = 1 - 0.82 * progress ** 1.15;
    this.score.position.set(position.x - this.origin.x, position.y - this.origin.y);
    this.score.scale.set(this.scoreFit * shrink);

    this.trail.forEach((piece, index) => {
      const lag = (index + 1) * 0.066;
      piece.visible = progress > lag;
      if (!piece.visible) return;
      piece.position.copyFrom(scoreFlightPosition(start, target, progress - lag));
      piece.alpha = (0.92 - index * 0.12) * unit((progress - lag) / 0.1);
      piece.scale.set(0.65 + 0.4 * progress);
    });
  }

  private ensureBursts(count: number): void {
    while (this.burstPool.length < count) {
      const flash = this.bursts.addChild(new Graphics(this.flashShape));
      flash.visible = false;
      const fragments = Array.from({ length: SPRINKLES + STREAKS }, (_, index) =>
        this.bursts.addChild(new Graphics({ context: index < SPRINKLES ? this.sprinkleShape : this.streakShape, visible: false })));
      this.burstPool.push({ flash, fragments });
    }
  }

  private prepareBursts(count: number, fill: number): void {
    this.ensureBursts(count);
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
    this.comboBadge.visible = false;
    this.combo.text = '';
    this.donuts.visible = this.bursts.visible = this.award.visible = this.glaze.visible = false;
  }
}
