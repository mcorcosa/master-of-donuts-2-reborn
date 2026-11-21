import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import type { Point, ResultsAction } from './gestures';
import { contains, type Rect, VIEW_WIDTH } from './layout';
import type { ResultsTab, ResultsView, ScoreSubmission } from './resultsSession';

const WIDTH = 352;
const CENTER = WIDTH / 2;
const INSET = 16;
const INNER_WIDTH = WIDTH - INSET * 2;
const INK = '#542e24';
const SOFT_INK = '#74443a';
const CREAM = '#fff5e9';
const FIRST_ROW_Y = 278;
const ROW_PITCH = 27;
const TAB_WIDTH = INNER_WIDTH / 2 - 6;
const PERSONAL_TAB: Rect = { x: INSET, y: 243, width: TAB_WIDTH, height: 34 };
const FRIENDS_TAB: Rect = { ...PERSONAL_TAB, x: WIDTH - INSET - TAB_WIDTH };
const SUBMIT: Rect = { x: INSET, y: 411, width: INNER_WIDTH, height: 34 };
const SUBMISSION_LABELS: Record<ScoreSubmission, string> = {
  idle: 'Submit score', submitting: 'Submitting score…', sent: 'Score submitted', error: 'Couldn’t submit · Retry',
};
const number = new Intl.NumberFormat();

function label(parent: Container, text: string, x: number, y: number, size: number, options: {
  align?: number;
  fill?: string;
  maxWidth?: number;
} = {}): Text {
  const display = new Text({ text, x, y, anchor: { x: options.align ?? 0, y: 0.5 }, style: {
    fontFamily: ['Reborn Fredoka', 'Trebuchet MS', 'sans-serif'], fontSize: size, fontWeight: '600',
    fill: options.fill ?? INK,
  } });
  if (options.maxWidth !== undefined) {
    display.scale.set(Math.min(1, options.maxWidth / display.getLocalBounds().width));
  }
  return parent.addChild(display);
}

export class ResultsPanel {
  readonly root = new Container({ label: 'end-game-results' });
  private restart: Rect = { x: INSET, y: 0, width: INNER_WIDTH, height: 46 };
  private view: ResultsView | null = null;

  constructor(private readonly companionTexture: Texture) {}

  show(view: ResultsView, viewHeight: number): void {
    this.view = view;
    const { personal: { run, rows, isPersonalBest }, tab, friends } = view;
    for (const child of this.root.removeChildren()) child.destroy({ children: true });
    this.restart.y = friends ? 455 : FIRST_ROW_Y + rows.length * ROW_PITCH + 10;
    this.resize(viewHeight);

    const { x, y, width, height } = this.restart;
    const panelHeight = this.height;
    this.root.addChild(new Graphics()
      .roundRect(0, 7, WIDTH, panelHeight, 25).fill({ color: 0x572920, alpha: 0.52 })
      .roundRect(0, 0, WIDTH, panelHeight, 25).fill(0xffefdf).stroke({ color: 0xfff9ef, width: 1.5 })
      .roundRect(10, 10, WIDTH - 20, 150, 19).fill(0xffc6a7).stroke({ color: 0xffdbc2, width: 1 })
      .roundRect(x, y + 3, width, height, 14).fill(0x78271f)
      .roundRect(x, y, width, height, 14).fill(0xa13935).stroke({ color: 0x8c302d, width: 1 }));

    const companion = new Sprite({ texture: this.companionTexture, x: 290, y: 150, anchor: { x: 0.5, y: 1 } });
    companion.scale.set(Math.min(78 / companion.texture.width, 98 / companion.texture.height));
    this.root.addChild(companion);
    label(this.root, 'Game Over', 29, 41, 29);
    label(this.root, 'Final score', 30, 73, 17, { fill: SOFT_INK });
    label(this.root, number.format(run.score), 29, 105, 38, { maxWidth: 214 }).label = 'result-score-value';
    if (isPersonalBest) {
      this.root.addChild(new Graphics().roundRect(27, 129, 154, 22, 11).fill(0xffebcb));
      label(this.root, 'New personal best!', 104, 140, 15, { align: 0.5 }).label = 'result-personal-best';
    }

    this.stat('Level', number.format(run.level), INSET, 'result-level-value');
    this.stat('Best combo', `${number.format(run.bestCombo)}×`, FRIENDS_TAB.x, 'result-combo-value');
    if (friends) {
      this.tab(PERSONAL_TAB, 'Personal', 'personal', tab);
      this.tab(FRIENDS_TAB, 'Friends', 'friends', tab);
    }
    if (tab === 'friends' && friends) this.drawFriends(friends);
    else this.drawPersonal(rows, friends !== null);

    label(this.root, 'Play Again', CENTER, y + height / 2, 24, { align: 0.5, fill: CREAM }).label = 'result-restart';
  }

  private drawPersonal(rows: ResultsView['personal']['rows'], withTabs: boolean): void {
    if (withTabs) {
      label(this.root, 'On this device', 22, 291, 14, { fill: SOFT_INK });
    } else {
      label(this.root, 'Personal scores', 22, 255, 21);
      label(this.root, 'On this device', WIDTH - 22, 256, 14, { align: 1, fill: SOFT_INK });
    }

    for (const row of rows) {
      const rowY = (withTabs ? 303 : FIRST_ROW_Y) + (row.rank - 1) * ROW_PITCH;
      const group = this.root.addChild(new Container({ y: rowY,
        label: row.current ? 'leaderboard-current-score' : 'leaderboard-score' }));
      const backing = new Graphics().roundRect(INSET, 0, INNER_WIDTH, 24, 8)
        .fill(row.current ? 0xffc5a5 : 0xfae2d1);
      if (row.current) backing.stroke({ color: 0xb26444, width: 1 });
      group.addChild(backing);
      label(group, `${row.rank}.`, 29, 12, 16, { fill: SOFT_INK });
      if (row.current) label(group, 'This run', 59, 12, 14);
      label(group, number.format(row.score), WIDTH - 29, 12, 18, { align: 1, maxWidth: 204 });
    }
  }

  private drawFriends({ list, submission }: NonNullable<ResultsView['friends']>): void {
    if (list.status === 'ready' && list.scores.length) {
      const ordered = [...list.scores].sort((first, second) => first.rank - second.rank);
      const scores = ordered.slice(0, 5);
      const own = ordered.find((score, index) => index >= scores.length && score.current);
      if (own) scores[4] = own;
      scores.forEach(({ rank, name, score, current }, index) => {
        const group = this.root.addChild(new Container({ y: 284 + index * 21,
          label: current ? 'friends-current-score' : 'friends-score' }));
        const backing = new Graphics().roundRect(INSET, 0, INNER_WIDTH, 19, 7).fill(current ? 0xffc5a5 : 0xfae2d1);
        if (current) backing.stroke({ color: 0xb26444, width: 1 });
        group.addChild(backing);
        label(group, `${number.format(rank)}.`, 26, 9.5, 14, { maxWidth: 40, fill: SOFT_INK });
        const characters = Array.from(name);
        const nameText = characters.length > 18 ? `${characters.slice(0, 17).join('')}…` : name;
        label(group, nameText, 72, 9.5, 16, { maxWidth: 102 });
        label(group, number.format(score), WIDTH - 25, 9.5, 16, { align: 1, maxWidth: 142 });
      });
    } else {
      const message = list.status === 'error' ? 'Couldn’t load scores. Tap Friends to retry.'
        : list.status === 'ready' ? 'No friends scores yet.' : 'Loading friends scores…';
      label(this.root, message, CENTER, 331, 17, { align: 0.5, maxWidth: INNER_WIDTH - 12 }).label = 'friends-list-status';
    }
    label(this.root, 'Share your final score on the Facebook friends leaderboard.', CENTER, 398, 15,
      { align: 0.5, fill: SOFT_INK, maxWidth: INNER_WIDTH }).label = 'friends-submit-disclosure';

    const enabled = submission === 'idle' || submission === 'error';
    this.button(SUBMIT, SUBMISSION_LABELS[submission], enabled, 17).label = 'friends-submit';
  }

  private tab(rect: Rect, caption: string, tab: ResultsTab, active: ResultsTab): void {
    this.button(rect, caption, tab === active, 17).label = `results-tab-${tab}`;
  }

  private button({ x, y, width, height }: Rect, caption: string, filled: boolean, size: number): Text {
    this.root.addChild(new Graphics().roundRect(x, y, width, height, 10)
      .fill(filled ? 0x874335 : 0xf7d8c3).stroke({ color: filled ? 0x874335 : 0xe0ac93, width: 1 }));
    return label(this.root, caption, x + width / 2, y + height / 2, size,
      { align: 0.5, fill: filled ? CREAM : SOFT_INK });
  }

  private stat(caption: string, value: string, x: number, id: string): void {
    const width = INNER_WIDTH / 2 - 6;
    const center = x + width / 2;
    this.root.addChild(new Graphics().roundRect(x, 171, width, 61, 13).fill(0xffdec7));
    label(this.root, caption, center, 188, 15, { align: 0.5, fill: SOFT_INK });
    label(this.root, value, center, 213, 25, { align: 0.5, maxWidth: width - 24 }).label = id;
  }

  private get height(): number {
    return this.restart.y + this.restart.height + INSET;
  }

  resize(viewHeight: number): void {
    this.root.position.set((VIEW_WIDTH - WIDTH) / 2, (viewHeight - this.height) / 2);
  }

  hit(point: Point): ResultsAction | null {
    if (!this.view) return null;
    const local = { x: point.x - this.root.x, y: point.y - this.root.y };
    const { x, y, width, height } = this.restart;
    if (contains({ x, y: y - 5, width, height: height + 10 }, local)) return 'restart';

    const { tab, friends } = this.view;
    if (!friends) return null;
    if (contains(PERSONAL_TAB, local)) return 'personal';
    if (contains(FRIENDS_TAB, local)) return 'friends';
    if (tab === 'friends' && (friends.submission === 'idle' || friends.submission === 'error') && contains(SUBMIT, local)) {
      return 'submit';
    }
    return null;
  }
}
