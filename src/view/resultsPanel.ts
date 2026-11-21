import { Container, Graphics, GraphicsContext, Sprite, Text, type Texture } from 'pixi.js';
import type { Point, ResultsAction } from './gestures';
import { contains, type Rect, VIEW_WIDTH } from './layout';
import type { ResultsView, ScoreSubmission } from './resultsSession';

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

function fitText(display: Text, value: string, maxWidth: number): void {
  if (display.text === value) return;
  display.text = value;
  display.scale.set(Math.min(1, maxWidth / Math.max(1, display.getLocalBounds().width)));
}

type WarmItem = Text | GraphicsContext;

export class ResultsPanel {
  readonly root = new Container({ label: 'end-game-results' });
  private readonly hidden = new Container();
  private readonly restart: Rect = { x: INSET, y: 0, width: INNER_WIDTH, height: 46 };
  private readonly backgrounds = new Map<number, GraphicsContext>();
  private readonly normalRow = new GraphicsContext().roundRect(INSET, 0, INNER_WIDTH, 24, 8).fill(0xfae2d1);
  private readonly currentRow = new GraphicsContext().roundRect(INSET, 0, INNER_WIDTH, 24, 8)
    .fill(0xffc5a5).stroke({ color: 0xb26444, width: 1 });
  private readonly personalRows: ReturnType<ResultsPanel['makeRow']>[] = [];
  private shell?: ReturnType<ResultsPanel['buildShell']>;
  private view: ResultsView | null = null;
  private renderedFriends: ResultsView['friends'] = null;

  constructor(private readonly companionTexture: Texture) {
    this.root.once('destroyed', () => {
      this.hidden.destroy({ children: true });
      for (const context of this.backgrounds.values()) context.destroy();
      this.normalRow.destroy();
      this.currentRow.destroy();
    });
  }

  *warmup(): Generator<WarmItem> {
    const shell = this.shell ??= this.buildShell();
    for (const child of [...this.root.children, ...this.hidden.children]) {
      if (child instanceof Text && child !== shell.score && child !== shell.level && child !== shell.combo) yield child;
      else if (child instanceof Graphics && child !== shell.backing) yield child.context;
      else if (child === shell.best || child === shell.deviceWithTabs || child === shell.deviceWithoutTabs ||
        child === shell.personalTab || child === shell.friendsTab) {
        for (const part of child.children) {
          if (part instanceof Text) yield part;
          else if (part instanceof Graphics) yield part.context;
        }
      }
    }
    // History has at most five rows, and the Friends layout always has the same height.
    yield this.background(455);
    for (let rows = 1; rows <= 5; rows++) {
      yield this.background(FIRST_ROW_Y + rows * ROW_PITCH + 10);
    }
    yield this.normalRow;
    yield this.currentRow;
    for (let rank = 1; rank <= 5; rank++) {
      const row = this.row(rank);
      yield row.rank;
      if (rank === 1) yield row.current;
    }
  }

  show(view: ResultsView, viewHeight: number): void {
    const { personal: { run, rows, isPersonalBest }, tab, friends } = view;
    const shell = this.shell ??= this.buildShell();
    const restartY = friends ? 455 : FIRST_ROW_Y + rows.length * ROW_PITCH + 10;
    if (this.restart.y !== restartY) {
      this.restart.y = restartY;
      shell.backing.context = this.background(restartY);
      shell.restart.y = restartY + this.restart.height / 2;
    }
    this.resize(viewHeight);
    this.attach(shell.best, isPersonalBest);
    fitText(shell.score, number.format(run.score), 214);
    fitText(shell.level, number.format(run.level), TAB_WIDTH - 24);
    fitText(shell.combo, `${number.format(run.bestCombo)}×`, TAB_WIDTH - 24);
    this.attach(shell.personalTab, !!friends);
    this.attach(shell.friendsTab, !!friends);
    if ((this.view?.tab ?? 'personal') !== tab) {
      this.drawButton(shell.personalButton, PERSONAL_TAB, tab === 'personal');
      this.drawButton(shell.friendsButton, FRIENDS_TAB, tab === 'friends');
    }

    const showFriends = tab === 'friends' && friends !== null;
    this.attach(shell.deviceWithTabs, !showFriends && !!friends);
    this.attach(shell.deviceWithoutTabs, !showFriends && !friends);
    for (const row of this.personalRows) {
      if (showFriends || row.index > rows.length) this.attach(row.group, false);
    }
    if (!showFriends) {
      for (const entry of rows) {
        const row = this.row(entry.rank);
        row.group.y = (friends ? 303 : FIRST_ROW_Y) + (entry.rank - 1) * ROW_PITCH;
        row.group.label = entry.current ? 'leaderboard-current-score' : 'leaderboard-score';
        if (row.isCurrent !== entry.current) {
          row.isCurrent = entry.current;
          row.backing.context = entry.current ? this.currentRow : this.normalRow;
          if (entry.current) {
            row.group.addChild(row.current);
          } else this.hidden.addChild(row.current);
        }
        fitText(row.score, number.format(entry.score), 204);
        this.attach(row.group, true);
      }
    }
    if (showFriends) {
      if (this.renderedFriends?.list !== friends.list || this.renderedFriends.submission !== friends.submission) {
        for (const child of shell.friendsBody.removeChildren()) child.destroy({ children: true });
        this.drawFriends(shell.friendsBody, friends);
        this.renderedFriends = friends;
      }
      this.attach(shell.friendsBody, true);
    } else this.attach(shell.friendsBody, false);
    this.view = view;
  }

  private attach(part: Container, visible: boolean): void {
    const parent = visible ? this.root : this.hidden;
    if (part.parent !== parent) parent.addChild(part);
  }

  private buildShell() {
    const backing = this.root.addChild(new Graphics());
    const companion = new Sprite({ texture: this.companionTexture, x: 290, y: 150, anchor: { x: 0.5, y: 1 } });
    companion.scale.set(Math.min(78 / companion.texture.width, 98 / companion.texture.height));
    this.root.addChild(companion);
    label(this.root, 'Game Over', 29, 41, 29);
    label(this.root, 'Final score', 30, 73, 17, { fill: SOFT_INK });
    const score = label(this.root, '', 29, 105, 38);
    score.label = 'result-score-value';
    const best = this.hidden.addChild(new Container());
    best.addChild(new Graphics().roundRect(27, 129, 154, 22, 11).fill(0xffebcb));
    label(best, 'New personal best!', 104, 140, 15, { align: 0.5 }).label = 'result-personal-best';

    const level = this.stat('Level', INSET, 'result-level-value');
    const combo = this.stat('Best combo', FRIENDS_TAB.x, 'result-combo-value');
    const restart = label(this.root, 'Play Again', CENTER, 0, 24, { align: 0.5, fill: CREAM });
    restart.label = 'result-restart';
    const personalTab = this.hidden.addChild(new Container());
    const friendsTab = this.hidden.addChild(new Container());
    const personalButton = this.button(personalTab, PERSONAL_TAB, 'Personal', 'results-tab-personal');
    const friendsButton = this.button(friendsTab, FRIENDS_TAB, 'Friends', 'results-tab-friends');
    this.drawButton(personalButton, PERSONAL_TAB, true);
    this.drawButton(friendsButton, FRIENDS_TAB, false);

    const deviceWithTabs = this.hidden.addChild(new Container());
    label(deviceWithTabs, 'On this device', 22, 291, 14, { fill: SOFT_INK });
    const deviceWithoutTabs = this.hidden.addChild(new Container());
    label(deviceWithoutTabs, 'Personal scores', 22, 255, 21);
    label(deviceWithoutTabs, 'On this device', WIDTH - 22, 256, 14, { align: 1, fill: SOFT_INK });

    return { backing, score, best, level, combo, restart, personalTab, friendsTab, personalButton, friendsButton,
      deviceWithTabs, deviceWithoutTabs, friendsBody: this.hidden.addChild(new Container()) };
  }

  private background(y: number): GraphicsContext {
    const cached = this.backgrounds.get(y);
    if (cached) return cached;
    const { x, width, height } = this.restart;
    const panelHeight = y + height + INSET;
    const context = new GraphicsContext()
      .roundRect(0, 7, WIDTH, panelHeight, 25).fill({ color: 0x572920, alpha: 0.52 })
      .roundRect(0, 0, WIDTH, panelHeight, 25).fill(0xffefdf).stroke({ color: 0xfff9ef, width: 1.5 })
      .roundRect(10, 10, WIDTH - 20, 150, 19).fill(0xffc6a7).stroke({ color: 0xffdbc2, width: 1 })
      .roundRect(x, y + 3, width, height, 14).fill(0x78271f)
      .roundRect(x, y, width, height, 14).fill(0xa13935).stroke({ color: 0x8c302d, width: 1 });
    this.backgrounds.set(y, context);
    return context;
  }

  private row(index: number) {
    return this.personalRows[index - 1] ??= this.makeRow(index);
  }

  private makeRow(index: number) {
    const group = this.hidden.addChild(new Container());
    const backing = group.addChild(new Graphics(this.normalRow));
    const rank = label(group, `${index}.`, 29, 12, 16, { fill: SOFT_INK });
    const current = label(this.hidden, 'This run', 59, 12, 14);
    const score = label(group, '', WIDTH - 29, 12, 18, { align: 1 });
    return { group, index, backing, rank, current, score, isCurrent: false };
  }

  private drawFriends(parent: Container, { list, submission }: NonNullable<ResultsView['friends']>): void {
    if (list.status === 'ready' && list.scores.length) {
      const ordered = [...list.scores].sort((first, second) => first.rank - second.rank);
      const scores = ordered.slice(0, 5);
      const own = ordered.find((score, index) => index >= scores.length && score.current);
      if (own) scores[4] = own;
      scores.forEach(({ rank, name, score, current }, index) => {
        const group = parent.addChild(new Container({ y: 284 + index * 21,
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
      label(parent, message, CENTER, 331, 17, { align: 0.5, maxWidth: INNER_WIDTH - 12 }).label = 'friends-list-status';
    }
    label(parent, 'Share your final score on the Facebook friends leaderboard.', CENTER, 398, 15,
      { align: 0.5, fill: SOFT_INK, maxWidth: INNER_WIDTH }).label = 'friends-submit-disclosure';

    const enabled = submission === 'idle' || submission === 'error';
    const submit = this.button(parent, SUBMIT, SUBMISSION_LABELS[submission], 'friends-submit');
    this.drawButton(submit, SUBMIT, enabled);
  }

  private button(parent: Container, { x, y, width, height }: Rect, caption: string, id: string) {
    const backing = parent.addChild(new Graphics());
    const text = label(parent, caption, x + width / 2, y + height / 2, 17, { align: 0.5, fill: SOFT_INK });
    text.label = id;
    return { backing, text };
  }

  private drawButton({ backing, text }: ReturnType<ResultsPanel['button']>, { x, y, width, height }: Rect, filled: boolean): void {
    backing.clear().roundRect(x, y, width, height, 10)
      .fill(filled ? 0x874335 : 0xf7d8c3).stroke({ color: filled ? 0x874335 : 0xe0ac93, width: 1 });
    text.style.fill = filled ? CREAM : SOFT_INK;
  }

  private stat(caption: string, x: number, id: string): Text {
    const center = x + TAB_WIDTH / 2;
    this.root.addChild(new Graphics().roundRect(x, 171, TAB_WIDTH, 61, 13).fill(0xffdec7));
    label(this.root, caption, center, 188, 15, { align: 0.5, fill: SOFT_INK });
    const value = label(this.root, '', center, 213, 25, { align: 0.5 });
    value.label = id;
    return value;
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
