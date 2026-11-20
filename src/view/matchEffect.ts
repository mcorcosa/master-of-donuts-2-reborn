import { Container, DOMAdapter, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import type { Point } from './gestures';
import { BOARD_FOOTER_SPACE, BOARD_TOP, VIEW_WIDTH } from './layout';
import { awardFrame, type MatchFrame, type MatchPlayback, scoreAccents, scoreEmphasis, scoreSize } from './matchPlayback';

const FONT = 'Reborn Fredoka';
const CREAM = 0xfff3d1;
const SCORE_SCALE = 1.32;
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

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

interface MatchGeometry {
  start: Point;
  landing: Point;
  width: number;
  height: number;
  step: number;
  viewHeight: number;
}

export class MatchEffect {
  readonly root = new Container();
  private readonly donuts = new Container();
  private readonly award = new Container();
  private readonly ring = new Graphics();
  private readonly pieces: Sprite[];
  private readonly outline: Text;
  private readonly face: Text;
  private readonly accents = Array.from({ length: 6 }, () => new Graphics().poly([-2, 0, 0, -5, 2, 0, 0, 5]).fill(0xffffff));
  private origin: Point = { x: 0, y: 0 };
  private radius: Point = { x: 0, y: 0 };
  private accentCount = 0;
  private tiltDirection = 1;
  private current: { playback: MatchPlayback; geometry: MatchGeometry; texture: Texture } | null = null;

  constructor(initialTexture: Texture) {
    const style = {
      fontFamily: [FONT, 'Comic Sans MS', 'cursive'],
      fontSize: 24 * SCORE_SCALE, fontWeight: '600' as const,
    };
    this.outline = new Text({ text: '', style: { ...style, stroke: { color: 0x734d13, width: 3.2 * SCORE_SCALE } } });
    this.face = new Text({ text: '', style: { ...style, stroke: { color: CREAM, width: 1.2 * SCORE_SCALE } } });
    this.outline.anchor.set(0.5);
    this.face.anchor.set(0.5);
    this.award.addChild(...this.accents, this.outline, this.face);
    this.donuts.addChild(this.ring);
    this.pieces = Array.from({ length: 3 }, () => {
      const piece = new Sprite(initialTexture);
      piece.anchor.set(0.5, 1);
      return this.donuts.addChild(piece);
    });
    this.root.addChild(this.donuts, this.award);
    this.cancel();
  }

  start(playback: MatchPlayback, geometry: MatchGeometry, texture: Texture): void {
    this.current = { playback, geometry, texture };
    const fill = DONUT_FILLS[playback.color] ?? CREAM;
    const size = scoreSize(playback.points) * SCORE_SCALE;
    const emphasis = scoreEmphasis(playback.points);
    this.accentCount = scoreAccents(playback);
    for (const layer of [this.outline, this.face]) {
      layer.text = `+${number.format(playback.points)}`;
      layer.style.fill = fill;
      layer.style.fontSize = size;
      layer.y = 0;
    }
    this.outline.style.stroke = { color: deepHue(fill), width: 3.2 * SCORE_SCALE };

    const bounds = this.outline.getLocalBounds();
    this.outline.y = this.face.y = -(bounds.minY + bounds.maxY) / 2;
    const labelWidth = 2 * Math.max(Math.abs(bounds.minX), Math.abs(bounds.maxX));
    const labelHeight = bounds.height;
    this.radius = { x: labelWidth / 2 + 8, y: labelHeight / 2 + 5 };
    const spread = this.accentCount ? 32 : 0;
    const peakX = playback.reduced ? 1 : 1.08 + 0.22 * emphasis;
    const peakY = playback.reduced ? 1 : 1.08 + 0.32 * emphasis;
    const tilt = playback.reduced ? 0 : Math.sin(5 * emphasis * Math.PI / 180);
    const marginX = (labelWidth * peakX + labelHeight * tilt) / 2 + spread + 6;
    const marginY = (labelHeight * peakY + labelWidth * tilt) / 2 + spread;

    const { landing, width, height, viewHeight } = geometry;
    const travel = playback.reduced ? 0 : 12 + 6 * emphasis;
    this.origin = {
      x: clamp(landing.x, marginX, VIEW_WIDTH - marginX),
      y: clamp(landing.y - height - 20, BOARD_TOP + marginY + travel, viewHeight - BOARD_FOOTER_SPACE - marginY),
    };
    this.tiltDirection = landing.x < VIEW_WIDTH / 2 ? 1 : -1;
    this.accents.forEach((accent, index) => {
      accent.tint = index % 2 ? CREAM : fill;
      accent.scale.set(playback.points >= 2500 ? 1.2 : 0.9);
    });

    for (const piece of this.pieces) piece.texture = texture;
    this.ring.clear().ellipse(0, 0, width * 0.67, height * 0.40)
      .stroke({ color: CREAM, width: 3 });
    this.donuts.visible = true;
    this.award.visible = false;
  }

  showPieces(frame: MatchFrame): void {
    if (!this.current) return;
    if (frame.phase === 'resolved') {
      this.donuts.visible = false;
      return;
    }

    const { playback, geometry, texture } = this.current;
    const { start, landing, width, height, step } = geometry;
    const { phase, progress } = frame;
    this.ring.visible = phase === 'clear';
    if (phase === 'arrival') {
      const arc = clamp(Math.min(start.y, landing.y) - height - BOARD_TOP, 4, 45);
      const travel = 1 - (1 - progress) ** 2;
      const piece = this.pieces[2];
      this.pieces[0].visible = this.pieces[1].visible = false;
      piece.visible = true;
      piece.alpha = 1;
      piece.rotation = 0;
      piece.scale.set(width / texture.width, height / texture.height);
      piece.position.set(start.x + (landing.x - start.x) * travel,
        start.y + (landing.y - start.y) * travel - Math.sin(Math.PI * progress) * arc);
      return;
    }

    const split = playback.reduced ? 0 : 1 - (1 - clamp(progress / 0.56, 0, 1)) ** 2;
    const fade = 1 - clamp((progress - 0.48) / 0.52, 0, 1) ** 1.5;
    const spread = width * 0.5;
    const fanCenter = clamp(landing.x, width + 6, VIEW_WIDTH - width - 6);
    const fanOffset = (fanCenter - landing.x) * split;
    this.pieces.forEach((piece, index) => {
      const direction = index - 1;
      const scale = 1 + 0.10 * split;
      piece.visible = true;
      piece.alpha = fade;
      piece.rotation = direction * 0.14 * split;
      piece.scale.set(scale * width / texture.width, scale * height / texture.height);
      piece.position.set(landing.x + fanOffset + direction * spread * split,
        landing.y + (2 - index) * step - (8 + index * 7) * split);
    });
    this.ring.position.set(landing.x + fanOffset, landing.y + step - height / 2);
    this.ring.scale.set(1 + 0.48 * split);
    this.ring.alpha = 0.84 * fade;
  }

  showAward(now: number): void {
    if (!this.current) return;
    const frame = awardFrame(this.current.playback, now);
    this.award.visible = frame !== null;
    if (!frame) {
      if (!this.donuts.visible) this.current = null;
      return;
    }
    this.award.position.set(this.origin.x, this.origin.y - frame.lift);
    this.award.scale.set(frame.scaleX, frame.scaleY);
    this.award.rotation = this.tiltDirection * frame.rotation;
    this.award.alpha = frame.alpha;
    this.accents.forEach((accent, index) => {
      accent.visible = index < this.accentCount && frame.accentProgress < 1;
      if (!accent.visible) return;
      const angle = index / this.accentCount * Math.PI * 2 - Math.PI / 2;
      const spread = 10 * frame.accentProgress;
      accent.rotation = angle;
      accent.position.set(Math.cos(angle) * (this.radius.x + spread), Math.sin(angle) * (this.radius.y + spread));
      accent.alpha = (1 - frame.accentProgress) ** 2;
    });
  }

  cancel(): void {
    this.current = null;
    this.donuts.visible = this.award.visible = false;
  }
}
