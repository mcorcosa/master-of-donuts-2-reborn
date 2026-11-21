import { Container, Graphics, Sprite, Text, type TextStyleOptions, type Texture } from 'pixi.js';
import type { GameState } from '../game';
import type { Point } from './gestures';
import { VIEW_WIDTH } from './layout';
import { unit } from './movePlayback';

const COMPANION_WIDTH = 68;
const COMPANION_HEIGHT = 64;
const COMPANION_GAP = 8;
const WIDTH = 252;
const HEIGHT = 49;
const PANEL_X = (VIEW_WIDTH - WIDTH + COMPANION_WIDTH + COMPANION_GAP) / 2 - 5;
const INSET = 12;
const RIGHT = WIDTH - INSET;
const SCORE_X = 49;
const SCORE_Y = 16;
const LEVEL_LABEL_X = 174;
const LEVEL_X = 191;
const SCORE_WIDTH = LEVEL_LABEL_X - SCORE_X - 8;
const SCORE_PUNCH = 1.27;
const SCORE_PUNCH_MS = 235;
const REDUCED_GLOW_MS = 155;
const TRACK_WIDTH = WIDTH - INSET * 2;
const TRACK_Y = 42;
const INK = '#483d42';
const SECONDARY_INK = '#5f4840';
const number = new Intl.NumberFormat();

export const GOAL_GLEAM_MS = 155;
export type ScoreDisplay = Pick<GameState, 'score' | 'level' | 'rank' | 'nextLevelScore'> & { levelStartScore: number };

function label(text: string, x: number, y: number, fontSize: number,
  fontWeight: TextStyleOptions['fontWeight'], fill: string): Text {
  return new Text({ text, x, y, anchor: { x: 0, y: 0.5 }, style: {
    fontFamily: 'Trebuchet MS, Arial, sans-serif', fontSize, fontWeight, fill,
  } });
}

function fitText(label: Text, maxWidth: number): void {
  const width = label.getLocalBounds().width;
  label.scale.set(width > maxWidth ? maxWidth / width : 1);
}

export class ScoreBar {
  readonly root = new Container({ x: PANEL_X, y: 68 });
  private readonly progress = new Graphics();
  private readonly goalGleam = new Graphics().roundRect(INSET, TRACK_Y - 1, TRACK_WIDTH, 5, 2.5).fill(0xffc347)
    .roundRect(INSET + 1, TRACK_Y, TRACK_WIDTH - 2, 1.5, 0.75).fill(0xfff3b3);
  private readonly glow = new Graphics().roundRect(SCORE_X - 4, 3, SCORE_WIDTH + 8, 26, 11).fill(0xffe9a5);
  private readonly score = label('', SCORE_X, SCORE_Y, 21, '800', INK);
  private readonly scoreLabel = label('Score', INSET, SCORE_Y + 1, 12, '600', SECONDARY_INK);
  private readonly rank = label('', INSET, 33, 13, '700', INK);
  private readonly levelLabel = label('Lv', LEVEL_LABEL_X, 19, 12, '600', SECONDARY_INK);
  private readonly level = label('', LEVEL_X, 18, 25, '800', INK);
  private scoreScale = 1;
  private impact: { started: number; reduced: boolean } | null = null;
  private gleam: { started: number; reduced: boolean } | null = null;

  constructor(companionTexture: Texture) {
    const companion = new Sprite({ texture: companionTexture, anchor: { x: 0.5, y: 1 },
      x: -COMPANION_GAP - COMPANION_WIDTH / 2, y: HEIGHT + 3 });
    companion.scale.set(Math.min(COMPANION_WIDTH / companionTexture.width, COMPANION_HEIGHT / companionTexture.height));
    const inlay = new Graphics().roundRect(0, 0, WIDTH, HEIGHT, 12)
      .fill({ color: 0xffcdac, alpha: 0.9 })
      .stroke({ color: 0xfae1c8, width: 0.8 });
    const track = new Graphics()
      .roundRect(INSET, TRACK_Y + 1, TRACK_WIDTH, 4, 2).fill(0xffdebf)
      .roundRect(INSET, TRACK_Y, TRACK_WIDTH, 3, 1.5).fill(0xd79e83);
    this.root.addChild(inlay, track, this.progress, this.goalGleam, this.glow, this.score, this.scoreLabel,
      this.rank, this.levelLabel, this.level, companion);
    this.resetEffects();
  }

  get creditTarget(): Point {
    return { x: this.root.x + this.score.x + 7 * this.scoreScale, y: this.root.y + this.score.y };
  }

  get animating(): boolean {
    return this.glow.visible || this.goalGleam.visible;
  }

  draw({ score, level, rank, nextLevelScore, levelStartScore }: ScoreDisplay): void {
    const formatted = number.format(score);
    if (formatted !== this.score.text) {
      this.score.text = formatted;
      fitText(this.score, SCORE_WIDTH / SCORE_PUNCH);
      this.scoreScale = this.score.scale.x;
    }
    this.rank.text = rank;
    fitText(this.rank, LEVEL_LABEL_X - INSET - 8);
    this.level.text = number.format(level);
    fitText(this.level, RIGHT - LEVEL_X);

    const levelRange = nextLevelScore - levelStartScore;
    const progress = levelRange > 0 ? (score - levelStartScore) / levelRange : 0;
    const fillWidth = TRACK_WIDTH * Math.max(0, Math.min(progress, 1));
    this.progress.clear();
    if (fillWidth > 0) {
      this.progress.roundRect(INSET, TRACK_Y, fillWidth, 3, Math.min(1.5, fillWidth / 2)).fill(0x9e625e);
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
