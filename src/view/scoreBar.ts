import { Container, Graphics, Text, type TextStyleOptions } from 'pixi.js';
import type { GameState } from '../game';
import type { Point } from './gestures';
import { VIEW_WIDTH } from './layout';
import { unit } from './movePlayback';

const WIDTH = 370;
const HEIGHT = 49;
const INSET = 12;
const RIGHT = WIDTH - INSET;
const SCORE_LABEL_X = 120;
const SCORE_RIGHT = SCORE_LABEL_X - 8;
const SCORE_Y = 16;
const SCORE_WIDTH = SCORE_RIGHT - INSET;
const SCORE_PUNCH = 1.27;
const SCORE_PUNCH_MS = 235;
const REDUCED_GLOW_MS = 155;
const TRACK_WIDTH = 251;
const TRACK_Y = 32;
const GOAL_WIDTH = RIGHT - (INSET + TRACK_WIDTH) - 10;
const INK = '#483d42';
const SECONDARY_INK = '#5f4840';
const number = new Intl.NumberFormat();
const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumSignificantDigits: 3 });

export const GOAL_GLEAM_MS = 155;
export type ScoreDisplay = Pick<GameState, 'score' | 'level' | 'rank' | 'nextLevelScore'> & { levelStartScore: number };

function label(text: string, x: number, y: number, fontSize: number,
  fontWeight: TextStyleOptions['fontWeight'], fill: string, align = 0): Text {
  return new Text({ text, x, y, anchor: { x: align, y: 0.5 }, style: {
    fontFamily: 'Trebuchet MS, Arial, sans-serif', fontSize, fontWeight, fill,
  } });
}

function fitText(label: Text, maxWidth: number): void {
  const width = label.getLocalBounds().width;
  label.scale.set(width > maxWidth ? maxWidth / width : 1);
}

function fitNumber(label: Text, value: number, maxWidth: number, prefix = ''): void {
  label.text = prefix + number.format(value);
  if (label.getLocalBounds().width * 0.8 > maxWidth) {
    label.text = prefix + compactNumber.format(value);
  }
  fitText(label, maxWidth);
}

export class ScoreBar {
  readonly root = new Container({ x: (VIEW_WIDTH - WIDTH) / 2, y: 68 });
  private readonly progress = new Graphics();
  private readonly goalGleam = new Graphics().roundRect(INSET, TRACK_Y - 1, TRACK_WIDTH, 5, 2.5).fill(0xffc347)
    .roundRect(INSET + 1, TRACK_Y, TRACK_WIDTH - 2, 1.5, 0.75).fill(0xfff3b3);
  private readonly glow = new Graphics().roundRect(INSET - 4, 3, SCORE_WIDTH + 9, 26, 11).fill(0xffe9a5);
  private readonly score = label('', SCORE_RIGHT, SCORE_Y, 21, '800', INK, 1);
  private readonly scoreLabel = label('Score', SCORE_LABEL_X, 18, 12, '600', SECONDARY_INK);
  private readonly rank = label('', RIGHT, 17, 14, '700', INK, 1);
  private readonly goal = label('', RIGHT, 34, 12, '600', SECONDARY_INK, 1);
  private scoreScale = 1;
  private impact: { started: number; reduced: boolean } | null = null;
  private gleam: { started: number; reduced: boolean } | null = null;

  constructor() {
    const inlay = new Graphics().roundRect(0, 0, WIDTH, HEIGHT, 12)
      .fill({ color: 0xffcdac, alpha: 0.9 })
      .stroke({ color: 0xfae1c8, width: 0.8 });
    const track = new Graphics()
      .roundRect(INSET, TRACK_Y + 1, TRACK_WIDTH, 4, 2).fill(0xffdebf)
      .roundRect(INSET, TRACK_Y, TRACK_WIDTH, 3, 1.5).fill(0xd79e83);
    this.root.addChild(inlay, track, this.progress, this.goalGleam, this.glow, this.score, this.scoreLabel, this.rank, this.goal);
    this.resetEffects();
  }

  get creditTarget(): Point {
    return { x: this.root.x + this.score.x - 7 * this.scoreScale, y: this.root.y + this.score.y };
  }

  draw({ score, level, rank, nextLevelScore, levelStartScore }: ScoreDisplay): void {
    const formatted = number.format(score);
    if (formatted !== this.score.text) {
      this.score.text = formatted;
      fitText(this.score, SCORE_WIDTH / SCORE_PUNCH);
      this.scoreScale = this.score.scale.x;
    }
    this.rank.text = `Lv ${level} · ${rank}`;
    fitText(this.rank, 185);
    fitNumber(this.goal, nextLevelScore, GOAL_WIDTH, 'Goal ');

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
