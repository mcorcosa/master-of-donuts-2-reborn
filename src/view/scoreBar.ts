import { Container, Graphics, Sprite, Text, type TextStyleOptions, type Texture } from 'pixi.js';
import type { GameState } from '../game';
import type { Point } from './gestures';
import { VIEW_WIDTH } from './layout';
import { unit } from './movePlayback';

const COMPANION_WIDTH = 68;
const COMPANION_HEIGHT = 64;
const COMPANION_GAP = 8;
const WIDTH = 252;
const HEIGHT = 54;
const RADIUS = 14;
const PANEL_X = (VIEW_WIDTH - WIDTH + COMPANION_WIDTH + COMPANION_GAP) / 2 - 5;
const INSET = 12;
const CREAM_RIGHT = 150;
const SCORE_Y = 23;
const LEVEL_X = 211;
const LEVEL_WIDTH = 64;
const SCORE_WIDTH = CREAM_RIGHT - INSET;
const SCORE_PUNCH = 1.27;
const SCORE_PUNCH_MS = 235;
const REDUCED_GLOW_MS = 155;
const TRACK_WIDTH = SCORE_WIDTH;
const TRACK_Y = 45;
const SCORE_INK = '#a63850';
const LEVEL_INK = '#fff4d6';
const number = new Intl.NumberFormat();

export const GOAL_GLEAM_MS = 155;
export type ScoreDisplay = Pick<GameState, 'score' | 'level' | 'rank' | 'nextLevelScore'> & { levelStartScore: number };

function label(text: string, x: number, y: number, fontSize: number,
  fontWeight: TextStyleOptions['fontWeight'], fill: string, anchorX = 0): Text {
  return new Text({ text, x, y, anchor: { x: anchorX, y: 0.5 }, style: {
    fontFamily: ['Reborn Fredoka', 'Trebuchet MS', 'sans-serif'], fontSize, fontWeight, fill,
  } });
}

function fitText(label: Text, maxWidth: number): void {
  const width = label.getLocalBounds().width;
  label.scale.set(width > maxWidth ? maxWidth / width : 1);
}

function glazeFace(): Graphics {
  return new Graphics()
    .roundRect(0, 2, WIDTH, HEIGHT, RADIUS).fill({ color: 0x9a4b42, alpha: 0.27 })
    .roundRect(0, 0, WIDTH, HEIGHT, RADIUS).fill(0xffebcf)
    .roundRect(2, 2, WIDTH - 4, 28, 12).fill({ color: 0xfffbe7, alpha: 0.68 })
    .moveTo(178, 0).lineTo(WIDTH - RADIUS, 0)
    .quadraticCurveTo(WIDTH, 0, WIDTH, RADIUS).lineTo(WIDTH, HEIGHT - RADIUS)
    .quadraticCurveTo(WIDTH, HEIGHT, WIDTH - RADIUS, HEIGHT).lineTo(184, HEIGHT)
    .bezierCurveTo(157, HEIGHT, 152, 19, 178, 0).closePath().fill(0xb34861)
    .moveTo(178, 1).lineTo(WIDTH - RADIUS, 1)
    .quadraticCurveTo(WIDTH - 1, 1, WIDTH - 1, RADIUS).lineTo(WIDTH - 1, 34)
    .bezierCurveTo(242, 24, 188, 12, 163, 30)
    .bezierCurveTo(163, 16, 171, 7, 178, 1).closePath().fill(0xc45a70)
    .moveTo(170, 17).bezierCurveTo(178, 5, 193, 4, 207, 5)
    .bezierCurveTo(189, 7, 181, 11, 170, 17).closePath()
    .fill({ color: 0xffc6bc, alpha: 0.72 })
    .roundRect(0, 0, WIDTH, HEIGHT, RADIUS).stroke({ color: 0xfff4d7, width: 1 });
}

export class ScoreBar {
  readonly root = new Container({ x: PANEL_X, y: 68 });
  private readonly progress = new Graphics();
  private readonly goalGleam = new Graphics().roundRect(INSET, TRACK_Y - 1, TRACK_WIDTH, 5, 2.5).fill(0xffc347)
    .roundRect(INSET + 1, TRACK_Y, TRACK_WIDTH - 2, 1.5, 0.75).fill(0xfff3b3);
  private readonly glow = new Graphics().roundRect(INSET - 4, SCORE_Y - 14, SCORE_WIDTH + 8, 28, 11).fill(0xffe194);
  private readonly score = label('', INSET, SCORE_Y, 24, '700', SCORE_INK);
  private readonly levelLabel = label('Level', LEVEL_X, 10, 11, '600', LEVEL_INK, 0.5);
  private readonly level = label('', LEVEL_X, 32, 32, '700', LEVEL_INK, 0.5);
  private scoreScale = 1;
  private impact: { started: number; reduced: boolean } | null = null;
  private gleam: { started: number; reduced: boolean } | null = null;

  constructor(companionTexture: Texture) {
    const companion = new Sprite({ texture: companionTexture, anchor: { x: 0.5, y: 1 },
      x: -COMPANION_GAP - COMPANION_WIDTH / 2, y: 52 });
    companion.scale.set(Math.min(COMPANION_WIDTH / companionTexture.width, COMPANION_HEIGHT / companionTexture.height));
    const track = new Graphics()
      .roundRect(INSET, TRACK_Y + 1, TRACK_WIDTH, 4, 2).fill(0xfff6e3)
      .roundRect(INSET, TRACK_Y, TRACK_WIDTH, 4, 2).fill(0xdeb1a7);
    this.root.addChild(glazeFace(), track, this.progress, this.goalGleam, this.glow, this.score,
      this.levelLabel, this.level, companion);
    this.resetEffects();
  }

  get creditTarget(): Point {
    return { x: this.root.x + this.score.x + 7 * this.scoreScale, y: this.root.y + this.score.y };
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
    this.level.text = number.format(level);
    fitText(this.level, LEVEL_WIDTH);

    const levelRange = nextLevelScore - levelStartScore;
    const progress = levelRange > 0 ? (score - levelStartScore) / levelRange : 0;
    const fillWidth = TRACK_WIDTH * Math.max(0, Math.min(progress, 1));
    this.progress.clear();
    if (fillWidth > 0) {
      this.progress.roundRect(INSET, TRACK_Y, fillWidth, 4, Math.min(2, fillWidth / 2)).fill(0xb64760);
    }
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
    const glow = impact?.reduced && age < REDUCED_GLOW_MS ? 0.43 : 0.54 * punch;
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
