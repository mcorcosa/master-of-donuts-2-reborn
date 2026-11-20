import { Container, Graphics, Text, type TextStyleOptions } from 'pixi.js';
import type { GameState } from '../game';
import { VIEW_WIDTH } from './layout';

const WIDTH = 370;
const HEIGHT = 49;
const INSET = 12;
const RIGHT = WIDTH - INSET;
const SCORE_LABEL_X = 86;
const SCORE_RIGHT = SCORE_LABEL_X - 8;
const TRACK_WIDTH = 251;
const TRACK_Y = 32;
const GOAL_WIDTH = RIGHT - (INSET + TRACK_WIDTH) - 10;
const INK = '#483d42';
const SECONDARY_INK = '#5f4840';
const number = new Intl.NumberFormat();
const compactNumber = new Intl.NumberFormat(undefined, { notation: 'compact', maximumSignificantDigits: 3 });

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
  readonly root = new Container({ x: (VIEW_WIDTH - WIDTH) / 2, y: 30 });
  private readonly progress = new Graphics();
  private readonly score = label('', SCORE_RIGHT, 16, 21, '800', INK, 1);
  private readonly scoreLabel = label('Score', SCORE_LABEL_X, 18, 12, '600', SECONDARY_INK);
  private readonly rank = label('', RIGHT, 17, 14, '700', INK, 1);
  private readonly goal = label('', RIGHT, 34, 12, '600', SECONDARY_INK, 1);

  constructor() {
    const inlay = new Graphics().roundRect(0, 0, WIDTH, HEIGHT, 12)
      .fill({ color: 0xffcdac, alpha: 0.9 })
      .stroke({ color: 0xfae1c8, width: 0.8 });
    const track = new Graphics()
      .roundRect(INSET, TRACK_Y + 1, TRACK_WIDTH, 4, 2).fill(0xffdebf)
      .roundRect(INSET, TRACK_Y, TRACK_WIDTH, 3, 1.5).fill(0xd79e83);
    this.root.addChild(inlay, track, this.progress, this.score, this.scoreLabel, this.rank, this.goal);
  }

  draw({ score, level, rank, nextLevelScore }: GameState, levelStartScore: number): void {
    fitNumber(this.score, score, SCORE_RIGHT - INSET);
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
}
