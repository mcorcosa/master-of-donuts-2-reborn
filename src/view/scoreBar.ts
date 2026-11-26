import { Container, Graphics, Sprite, Text, type TextStyleOptions, Texture } from 'pixi.js';
import type { GameState } from '../game';
import { GAME_FONT_FAMILY, gameText } from './gameFont';
import type { Point } from './gestures';
import { MascotPuppet } from './mascot';
import type { MascotFrame } from './mascotMotion';
import { unit } from './movePlayback';

const BISCUIT_WIDTH = 226;
const SCORE_CENTER = BISCUIT_WIDTH / 2;
const SCORE_Y = 34;
const LEVEL_X = 268;
const LEVEL_Y = 56.5;
// Inside the jam highlights of the 92 × 95 cookie.
const JAM_CENTER_Y = 47;
const JAM_RADIUS_X = 35;
const JAM_RADIUS_Y = 33.5;
const LEVEL_ARC_RADIUS = 62;
const LEVEL_ARC_Y = 25;
const LEVEL_LETTER_GAP = 1;
const LEVEL_LINE_GAP = 4;
const SCORE_WIDTH = 172;
const SCORE_LEFT = SCORE_CENTER - SCORE_WIDTH / 2;
const SCORE_PUNCH = 1.38;
const SCORE_PUNCH_MS = 235;
const REDUCED_GLOW_MS = 155;
// Leave room for the marker and its shadow at both rounded ends of the icing.
const TRACK_WIDTH = 150;
const TRACK_LEFT = SCORE_CENTER - TRACK_WIDTH / 2;
const TRACK_Y = 54;
const TRACK_HEIGHT = 6;
const SCORE_INK = '#731328';
const LEVEL_INK = '#fff3d7';
const number = new Intl.NumberFormat();

export const GOAL_GLEAM_MS = 155;
export type ScoreDisplay = Pick<GameState, 'score' | 'level' | 'rank' | 'nextLevelScore'> & { levelStartScore: number };

function label(text: string, x: number, y: number, fontSize: number,
  fontWeight: TextStyleOptions['fontWeight'], fill: string, anchorX = 0): Text {
  return new Text({ text: gameText(text), x, y, anchor: { x: anchorX, y: 0.5 }, style: {
    fontFamily: GAME_FONT_FAMILY, fontSize, fontWeight, fill,
  } });
}

function fitText(label: Text, maxWidth: number): void {
  const width = label.getLocalBounds().width;
  label.scale.set(width > maxWidth ? maxWidth / width : 1);
}

function cookieText(text: string, fontSize: number, fontWeight: '600' | '700'): Text {
  return new Text({ text, anchor: 0.5, style: {
    fontFamily: GAME_FONT_FAMILY, fontSize, fontWeight, fill: LEVEL_INK, trim: true, padding: 3,
  } });
}

function levelCaption(): Container {
  const caption = new Container({ x: LEVEL_X, y: LEVEL_ARC_Y, label: 'level-caption' });
  const letters = Array.from(gameText('Level'), letter => {
    const glyph = caption.addChild(cookieText(letter, 15, '600'));
    return { glyph, width: glyph.getLocalBounds().width };
  });
  const width = letters.reduce((sum, letter) => sum + letter.width, (letters.length - 1) * LEVEL_LETTER_GAP);
  let left = -width / 2;
  for (const { glyph, width } of letters) {
    const angle = (left + width / 2) / LEVEL_ARC_RADIUS;
    glyph.position.set(LEVEL_ARC_RADIUS * Math.sin(angle), LEVEL_ARC_RADIUS * (1 - Math.cos(angle)));
    glyph.rotation = angle;
    left += width + LEVEL_LETTER_GAP;
  }
  const { minX, maxX } = caption.getLocalBounds();
  caption.pivot.x = (minX + maxX) / 2;
  return caption;
}

function fitLevel(level: Text, captionBottom: number): void {
  const { width, height } = level.getLocalBounds();
  const halfWidth = width / (2 * JAM_RADIUS_X);
  const halfHeight = height / (2 * JAM_RADIUS_Y);
  // Wide values can sit nearer the widest part of the jam.
  const top = captionBottom + LEVEL_LINE_GAP;
  const heightAtFullWidth = height * Math.min(1, 1 / halfWidth);
  level.y = Math.min(LEVEL_Y, Math.max(JAM_CENTER_Y + 3, top + heightAtFullWidth / 2));
  const centerOffset = (level.y - JAM_CENTER_Y) / JAM_RADIUS_Y;
  // Find the scale where the numeral's outer corners reach the safe jam ellipse.
  const a = halfWidth ** 2 + halfHeight ** 2;
  const b = centerOffset * halfHeight;
  const room = 1 - centerOffset ** 2;
  const jamScale = room / (Math.sqrt(b ** 2 + a * room) + b);
  const lineScale = (level.y - top) / (height / 2);
  level.scale.set(Math.max(0, Math.min(1, jamScale, lineScale)));
}

function art(texture: Texture, x: number, y: number, width: number, height: number): Sprite {
  return new Sprite({ texture, x, y, width, height });
}

export class ScoreBar {
  readonly root = new Container({ x: 97, y: 72, label: 'score-and-level' });
  private readonly progress = new Graphics();
  private readonly marker = new Graphics().circle(0, 0.7, 5.4).fill({ color: 0x995617, alpha: 0.4 })
    .circle(0, 0, 5.1).fill(0xfec40b).circle(-1.3, -1.6, 1.65).fill({ color: 0xffed93, alpha: 0.65 });
  private readonly goalGleam = new Graphics().roundRect(TRACK_LEFT, TRACK_Y - 1, TRACK_WIDTH, 8, 4).fill(0xffc347)
    .roundRect(TRACK_LEFT + 1, TRACK_Y, TRACK_WIDTH - 2, 2, 1).fill(0xfff3b3);
  private readonly glow = new Graphics().roundRect(SCORE_LEFT - 4, SCORE_Y - 17, SCORE_WIDTH + 8, 34, 12).fill(0xffcc75);
  private readonly score = label('', SCORE_CENTER, SCORE_Y, 34, '700', SCORE_INK, 0.5);
  private readonly levelLabel = levelCaption();
  private readonly levelCaptionBottom = this.levelLabel.y + this.levelLabel.getLocalBounds().maxY;
  private readonly level = cookieText('', 53, '700');
  private readonly mascot: MascotPuppet;
  private scoreScale = 1;
  private impact: { started: number; reduced: boolean } | null = null;
  private gleam: { started: number; reduced: boolean } | null = null;

  constructor(wavingMascot: Texture, biscuit = Texture.EMPTY, jamCookie = Texture.EMPTY, gloves?: readonly [Texture, Texture]) {
    this.root.scale.set(0.76);
    this.level.position.set(LEVEL_X, LEVEL_Y);
    this.level.style.dropShadow = { color: '#4f0919', alpha: 0.78, blur: 1, angle: Math.PI / 2, distance: 1.5 };
    const track = new Graphics()
      .roundRect(TRACK_LEFT, TRACK_Y + 1, TRACK_WIDTH, TRACK_HEIGHT, 3).fill(0xfffae9)
      .roundRect(TRACK_LEFT, TRACK_Y, TRACK_WIDTH, TRACK_HEIGHT, 3).fill(0xdca775)
      .roundRect(TRACK_LEFT + 1, TRACK_Y + 1, TRACK_WIDTH - 2, 2, 1).fill({ color: 0x995b30, alpha: 0.25 });
    this.mascot = new MascotPuppet(wavingMascot, gloves);
    this.root.addChild(art(biscuit, 0, 7, BISCUIT_WIDTH, 83), art(jamCookie, LEVEL_X - 46, 1, 92, 95),
      this.mascot.root, track, this.progress, this.goalGleam, this.marker, this.glow,
      this.score, this.levelLabel, this.level);
    this.resetEffects();
  }

  setMascot(texture: Texture, frame: MascotFrame): void {
    this.mascot.show(texture, frame);
  }

  settleMascot(): void {
    this.mascot.settle();
  }

  get creditTarget(): Point {
    return {
      x: this.root.x + this.score.x * this.root.scale.x,
      y: this.root.y + this.score.y * this.root.scale.y,
    };
  }

  get animating(): boolean {
    return this.glow.visible || this.goalGleam.visible;
  }

  draw({ score, level, nextLevelScore, levelStartScore }: ScoreDisplay): void {
    const formatted = number.format(score);
    if (formatted !== this.score.text) {
      this.score.text = formatted;
      fitText(this.score, SCORE_WIDTH / SCORE_PUNCH);
      this.scoreScale = this.score.scale.x;
    }
    const levelNumber = number.format(level);
    if (levelNumber !== this.level.text) {
      this.level.text = levelNumber;
      fitLevel(this.level, this.levelCaptionBottom);
    }

    const levelRange = nextLevelScore - levelStartScore;
    const progress = levelRange > 0 ? (score - levelStartScore) / levelRange : 0;
    const fillWidth = TRACK_WIDTH * Math.max(0, Math.min(progress, 1));
    this.progress.clear();
    if (fillWidth > 0) {
      this.progress.roundRect(TRACK_LEFT, TRACK_Y, fillWidth, TRACK_HEIGHT, Math.min(3, fillWidth / 2)).fill(SCORE_INK);
    }
    this.marker.position.set(TRACK_LEFT + fillWidth, TRACK_Y + TRACK_HEIGHT / 2);
  }

  credit(now: number, reduced: boolean): void {
    this.impact = { started: now, reduced };
  }

  reachGoal(now: number, reduced: boolean): void {
    this.gleam = { started: now, reduced };
  }

  showEffects(now: number): void {
    const impact = this.impact;
    const age = impact ? Math.max(0, now - impact.started) : SCORE_PUNCH_MS;
    const punch = !impact || impact.reduced ? 0 : age < 36 ? 0.55 + 0.45 * unit(age / 36)
      : (1 - unit((age - 36) / (SCORE_PUNCH_MS - 36))) ** 2.4;
    this.score.scale.set(this.scoreScale * (1 + (SCORE_PUNCH - 1) * punch));
    const glow = impact?.reduced && age < REDUCED_GLOW_MS ? 0.56 : 0.72 * punch;
    this.glow.visible = glow > 0;
    this.glow.alpha = glow;

    const gleam = this.gleam;
    const light = gleam ? 1 - unit((now - gleam.started) / GOAL_GLEAM_MS) : 0;
    this.goalGleam.visible = light > 0;
    this.goalGleam.alpha = gleam?.reduced ? 0.94 : 0.36 + 0.64 * light;
  }

  resetEffects(): void {
    this.impact = this.gleam = null;
    this.showEffects(0);
  }
}
