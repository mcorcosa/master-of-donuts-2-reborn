import { Container, Graphics, GraphicsContext, Sprite, Text, type Texture } from 'pixi.js';
import type { GameState } from '../game';
import { GAME_FONT_FAMILY, gameText } from './gameFont';
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
const SCORE_LIMIT = 10;
const FIRST_ROW_Y = 278;
const PERSONAL_TAB_ROW_Y = 303;
const FRIENDS_ROW_Y = 284;
const ROW_HEIGHT = 24;
const ROW_PITCH = 27;
const RESTART_HEIGHT = 46;
const PERSONAL_FOOTER_SPACE = 10;
const FRIENDS_FOOTER_SPACE = 72;
const VIEW_MARGIN = 11;
const LIST_LEFT = INSET - 1;
const LIST_WIDTH = INNER_WIDTH + 2;
const SCROLLBAR_X = WIDTH - INSET + 5;
const SCROLLBAR_WIDTH = 4;
const TAB_WIDTH = INNER_WIDTH / 2 - 6;
const PERSONAL_TAB: Rect = { x: INSET, y: 243, width: TAB_WIDTH, height: 34 };
const FRIENDS_TAB: Rect = { ...PERSONAL_TAB, x: WIDTH - INSET - TAB_WIDTH };
const SUBMIT: Rect = { x: INSET, y: 28, width: INNER_WIDTH, height: 34 };
const SUBMISSION_LABELS: Record<ScoreSubmission, string> = {
  idle: 'Submit score', submitting: 'Submitting score…', sent: 'Score submitted', error: 'Couldn’t submit · Retry',
};
const number = new Intl.NumberFormat();

function rowsHeight(count: number): number {
  return count === 0 ? 0 : 2 + ROW_HEIGHT + (count - 1) * ROW_PITCH;
}

function fitName(display: Text, name: string, maxWidth: number): void {
  const caption = gameText(name);
  const characters = Array.from(caption);
  let length = Math.min(characters.length, 18);
  display.text = characters.length > length ? `${characters.slice(0, length).join('')}…` : caption;
  while (length > 0 && display.getLocalBounds().width > maxWidth) {
    length--;
    display.text = `${characters.slice(0, length).join('')}…`;
  }
}

function label(parent: Container, text: string, x: number, y: number, size: number, options: {
  align?: number;
  fill?: string;
  maxWidth?: number;
} = {}): Text {
  const display = new Text({ text: gameText(text), x, y, anchor: { x: options.align ?? 0, y: 0.5 }, style: {
    fontFamily: GAME_FONT_FAMILY, fontSize: size, fontWeight: '600',
    fill: options.fill ?? INK,
  } });
  if (options.maxWidth !== undefined) {
    display.scale.set(Math.min(1, options.maxWidth / display.getLocalBounds().width));
  }
  return parent.addChild(display);
}

function fitText(display: Text, value: string, maxWidth: number): void {
  const text = gameText(value);
  if (display.text === text) return;
  display.text = text;
  display.scale.set(Math.min(1, maxWidth / Math.max(1, display.getLocalBounds().width)));
}

type WarmItem = Text | GraphicsContext;

export class ResultsPanel {
  readonly root = new Container({ label: 'end-game-results' });
  private readonly hidden = new Container();
  private readonly restart: Rect = { x: INSET, y: 0, width: INNER_WIDTH, height: RESTART_HEIGHT };
  private readonly backgrounds = new Map<number, GraphicsContext>();
  private readonly normalRow = new GraphicsContext().roundRect(INSET, 0, INNER_WIDTH, ROW_HEIGHT, 8).fill(0xfae2d1);
  private readonly currentRow = new GraphicsContext().roundRect(INSET, 0, INNER_WIDTH, ROW_HEIGHT, 8)
    .fill(0xffc5a5).stroke({ color: 0xb26444, width: 1 });
  private readonly personalRows: ReturnType<ResultsPanel['makeRow']>[] = [];
  private shell?: ReturnType<ResultsPanel['buildShell']>;
  private view: ResultsView | null = null;
  private renderedFriends: ResultsView['friends'] = null;
  private adaptiveBackground?: GraphicsContext;
  private readonly scroll = { personal: 0, friends: 0 };
  private listTop = 0;
  private listHeight = 0;
  private scrollLimit = 0;
  private thumbTravel = 0;

  constructor(private readonly companionTexture: Texture) {
    this.root.once('destroyed', () => {
      this.hidden.destroy({ children: true });
      for (const context of this.backgrounds.values()) context.destroy();
      this.adaptiveBackground?.destroy();
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
        child === shell.personalTab || child === shell.friendsTab || child === shell.friendsFooter) {
        for (const part of child.children) {
          if (part instanceof Text) yield part;
          else if (part instanceof Graphics) yield part.context;
        }
      }
    }
    const restartPositions = [this.friendsRestartY, ...Array.from({ length: SCORE_LIMIT + 1 }, (_, count) =>
      FIRST_ROW_Y + rowsHeight(count) + PERSONAL_FOOTER_SPACE)];
    for (const y of restartPositions) {
      const context = this.backgrounds.get(y) ?? this.background(y);
      this.backgrounds.set(y, context);
      yield context;
    }
    yield this.normalRow;
    yield this.currentRow;
    for (let rank = 1; rank <= SCORE_LIMIT; rank++) {
      const row = this.row(rank);
      yield row.rank;
      if (rank === 1) yield row.current;
    }
  }

  show(view: ResultsView, viewHeight: number, reason?: GameState['endReason']): void {
    const { personal: { run, rows, isPersonalBest }, tab, friends } = view;
    const shell = this.shell ??= this.buildShell();
    const personalRows = rows.slice(0, SCORE_LIMIT);
    if (this.view?.personal !== view.personal) {
      this.scroll.personal = 0;
      this.scroll.friends = 0;
    }
    this.attach(shell.best, isPersonalBest);
    fitText(shell.heading, reason === 'dough-meter' ? 'Out of moves' : 'Game Over', 218);
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
    this.attach(shell.personalBody, !showFriends, shell.listContent);
    this.attach(shell.friendsBody, showFriends, shell.listContent);
    this.attach(shell.friendsFooter, showFriends);
    if (!showFriends) {
      for (const row of this.personalRows) {
        if (row.index > personalRows.length) this.attach(row.group, false);
      }
      for (const entry of personalRows) {
        const row = this.row(entry.rank);
        row.group.label = entry.current ? 'leaderboard-current-score' : 'leaderboard-score';
        if (row.isCurrent !== entry.current) {
          row.isCurrent = entry.current;
          row.backing.context = entry.current ? this.currentRow : this.normalRow;
          if (entry.current) {
            row.group.addChild(row.current);
          } else this.hidden.addChild(row.current);
        }
        fitText(row.score, number.format(entry.score), 204);
        this.attach(row.group, true, shell.personalBody);
      }
    } else {
      if (this.renderedFriends?.list !== friends.list) {
        for (const child of shell.friendsBody.removeChildren()) child.destroy({ children: true });
        this.drawFriends(shell.friendsBody, friends.list);
      }
      if (this.renderedFriends?.submission !== friends.submission) {
        fitText(shell.submit.text, SUBMISSION_LABELS[friends.submission], SUBMIT.width - 24);
        this.drawButton(shell.submit, SUBMIT, friends.submission === 'idle' || friends.submission === 'error');
      }
      this.renderedFriends = friends;
    }
    this.view = view;
    this.resize(viewHeight);
  }

  private attach(part: Container, visible: boolean, destination = this.root): void {
    const parent = visible ? destination : this.hidden;
    if (part.parent !== parent) parent.addChild(part);
  }

  private buildShell() {
    const backing = this.root.addChild(new Graphics());
    const companion = new Sprite({ texture: this.companionTexture, x: 290, y: 150, anchor: { x: 0.5, y: 1 } });
    companion.scale.set(Math.min(78 / companion.texture.width, 98 / companion.texture.height));
    this.root.addChild(companion);
    const heading = label(this.root, 'Game Over', 29, 41, 29, { maxWidth: 218 });
    heading.label = 'result-heading';
    label(this.root, 'Final score', 30, 73, 17, { fill: SOFT_INK });
    const score = label(this.root, '', 29, 105, 38);
    score.label = 'result-score-value';
    const best = this.hidden.addChild(new Container());
    best.addChild(new Graphics().roundRect(27, 129, 154, 22, 11).fill(0xffebcb));
    label(best, 'New personal best!', 104, 140, 15, { align: 0.5, maxWidth: 142 }).label = 'result-personal-best';

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
    label(deviceWithoutTabs, 'Personal scores', 22, 255, 21, { maxWidth: 182 });
    label(deviceWithoutTabs, 'On this device', WIDTH - 22, 256, 14, { align: 1, fill: SOFT_INK, maxWidth: 115 });

    const list = this.root.addChild(new Container({ label: 'results-list' }));
    const listContent = list.addChild(new Container({ label: 'results-list-content' }));
    const mask = list.addChild(new Graphics({ label: 'results-list-mask' }));
    listContent.mask = mask;
    const scrollbar = list.addChild(new Graphics());
    const thumb = list.addChild(new Graphics());
    const personalBody = this.hidden.addChild(new Container({ label: 'personal-list' }));
    const friendsBody = this.hidden.addChild(new Container({ label: 'friends-list' }));
    const friendsFooter = this.hidden.addChild(new Container());
    const disclosure = label(friendsFooter, 'Share your final score on the\nFacebook friends leaderboard.', CENTER, 13, 14,
      { align: 0.5, fill: SOFT_INK, maxWidth: INNER_WIDTH - 16 });
    disclosure.style.align = 'center';
    disclosure.style.lineHeight = 13;
    disclosure.label = 'friends-submit-disclosure';
    const submit = this.button(friendsFooter, SUBMIT, SUBMISSION_LABELS.idle, 'friends-submit');
    this.drawButton(submit, SUBMIT, true);

    return { backing, heading, score, best, level, combo, restart, personalTab, friendsTab, personalButton, friendsButton,
      deviceWithTabs, deviceWithoutTabs, list, listContent, mask, scrollbar, thumb, personalBody, friendsBody,
      friendsFooter, submit };
  }

  private background(y: number): GraphicsContext {
    const { x, width, height } = this.restart;
    const panelHeight = y + height + INSET;
    return new GraphicsContext()
      .roundRect(0, 7, WIDTH, panelHeight, 25).fill({ color: 0x572920, alpha: 0.52 })
      .roundRect(0, 0, WIDTH, panelHeight, 25).fill(0xffefdf).stroke({ color: 0xfff9ef, width: 1.5 })
      .roundRect(10, 10, WIDTH - 20, 150, 19).fill(0xffc6a7).stroke({ color: 0xffdbc2, width: 1 })
      .roundRect(x, y + 3, width, height, 14).fill(0x78271f)
      .roundRect(x, y, width, height, 14).fill(0xa13935).stroke({ color: 0x8c302d, width: 1 });
  }

  private row(index: number) {
    return this.personalRows[index - 1] ??= this.makeRow(index);
  }

  private makeRow(index: number) {
    const group = this.hidden.addChild(new Container({ y: 1 + (index - 1) * ROW_PITCH }));
    const backing = group.addChild(new Graphics(this.normalRow));
    const rank = label(group, `${index}.`, 29, 12, 16, { fill: SOFT_INK });
    const current = label(this.hidden, 'This run', 59, 12, 14);
    const score = label(group, '', WIDTH - 29, 12, 18, { align: 1 });
    return { group, index, backing, rank, current, score, isCurrent: false };
  }

  private drawFriends(parent: Container, list: NonNullable<ResultsView['friends']>['list']): void {
    if (list.status === 'ready' && list.scores.length) {
      const scores = [...list.scores].sort((first, second) => first.rank - second.rank).slice(0, SCORE_LIMIT);
      scores.forEach(({ rank, name, score, current }, index) => {
        const group = parent.addChild(new Container({ y: 1 + index * ROW_PITCH,
          label: current ? 'friends-current-score' : 'friends-score' }));
        group.addChild(new Graphics(current ? this.currentRow : this.normalRow));
        label(group, `${number.format(rank)}.`, 26, 12, 15, { maxWidth: 40, fill: SOFT_INK });
        fitName(label(group, '', 70, 12, 17), name, 115);
        label(group, number.format(score), WIDTH - 26, 12, 17, { align: 1, maxWidth: 139 });
      });
    } else {
      const message = list.status === 'error' ? 'Couldn’t load scores.\nTap Friends to retry.'
        : list.status === 'ready' ? 'No friends scores yet.' : 'Loading friends scores…';
      const status = label(parent, message, CENTER, 47, 17, { align: 0.5, maxWidth: INNER_WIDTH - 12 });
      status.style.align = 'center';
      status.label = 'friends-list-status';
    }
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

  private get friendsRestartY(): number {
    return FRIENDS_ROW_Y + rowsHeight(SCORE_LIMIT) + FRIENDS_FOOTER_SPACE;
  }

  resize(viewHeight: number): void {
    const shell = this.shell;
    const view = this.view;
    if (!shell || !view) return;
    const { tab, personal, friends } = view;
    const showFriends = tab === 'friends' && friends !== null;
    const personalCount = Math.min(SCORE_LIMIT, personal.rows.length);
    const footerSpace = showFriends ? FRIENDS_FOOTER_SPACE : PERSONAL_FOOTER_SPACE;
    const preferredRestart = friends ? this.friendsRestartY : FIRST_ROW_Y + rowsHeight(personalCount) + footerSpace;
    const maxRestart = Math.floor(viewHeight - RESTART_HEIGHT - INSET - VIEW_MARGIN * 2);
    const restartY = Math.min(preferredRestart, maxRestart);
    if (this.restart.y !== restartY) {
      this.restart.y = restartY;
      const warmed = this.backgrounds.get(restartY);
      const context = warmed ?? this.background(restartY);
      shell.backing.context = context;
      this.adaptiveBackground?.destroy();
      this.adaptiveBackground = warmed ? undefined : context;
      shell.restart.y = restartY + RESTART_HEIGHT / 2;
    }
    this.root.position.set((VIEW_WIDTH - WIDTH) / 2, (viewHeight - restartY - RESTART_HEIGHT - INSET) / 2);

    const top = showFriends ? FRIENDS_ROW_Y : friends ? PERSONAL_TAB_ROW_Y : FIRST_ROW_Y;
    const height = restartY - footerSpace - top;
    const count = showFriends
      ? Math.min(SCORE_LIMIT, friends.list.status === 'ready' ? friends.list.scores.length : 0)
      : personalCount;
    const contentHeight = rowsHeight(count);
    const maxScroll = Math.max(0, contentHeight - height);
    shell.friendsFooter.y = restartY - FRIENDS_FOOTER_SPACE;
    if (this.listTop !== top || this.listHeight !== height || this.scrollLimit !== maxScroll) {
      this.listTop = shell.list.y = top;
      this.listHeight = height;
      this.scrollLimit = maxScroll;
      shell.mask.clear().rect(LIST_LEFT, 0, LIST_WIDTH, height).fill(0xffffff);
      shell.scrollbar.clear();
      shell.thumb.clear();
      if (maxScroll > 0) {
        const thumbHeight = Math.max(20, height * height / contentHeight);
        this.thumbTravel = height - thumbHeight;
        shell.scrollbar.roundRect(SCROLLBAR_X, 0, SCROLLBAR_WIDTH, height, 2).fill(0xe9bdab);
        shell.thumb.roundRect(SCROLLBAR_X, 0, SCROLLBAR_WIDTH, thumbHeight, 2).fill(0xa8533c);
      }
    }
    this.setScroll(shell, tab, this.scroll[tab]);
  }

  canScroll(point: Point): boolean {
    return this.scrollLimit > 0 && contains({
      x: LIST_LEFT, y: this.listTop, width: SCROLLBAR_X + SCROLLBAR_WIDTH - LIST_LEFT, height: this.listHeight,
    }, this.toLocal(point));
  }

  scrollBy(delta: number): boolean {
    if (!this.view || !this.shell) return false;
    const { tab } = this.view;
    return this.setScroll(this.shell, tab, this.scroll[tab] + delta);
  }

  private setScroll({ listContent, thumb }: ReturnType<ResultsPanel['buildShell']>, tab: ResultsView['tab'],
    offset: number): boolean {
    const clamped = Math.max(0, Math.min(offset, this.scrollLimit));
    const moved = listContent.y !== -clamped;
    this.scroll[tab] = clamped;
    listContent.y = -clamped;
    thumb.y = this.scrollLimit ? this.thumbTravel * clamped / this.scrollLimit : 0;
    return moved;
  }

  private toLocal(point: Point): Point {
    return { x: point.x - this.root.x, y: point.y - this.root.y };
  }

  hit(point: Point): ResultsAction | null {
    if (!this.view) return null;
    const local = this.toLocal(point);
    const { x, y, width, height } = this.restart;
    if (contains({ x, y: y - 5, width, height: height + 10 }, local)) return 'restart';

    const { tab, friends } = this.view;
    if (!friends) return null;
    if (contains(PERSONAL_TAB, local)) return 'personal';
    if (contains(FRIENDS_TAB, local)) return 'friends';
    const submit = { ...SUBMIT, y: this.restart.y - FRIENDS_FOOTER_SPACE + SUBMIT.y };
    if (tab === 'friends' && (friends.submission === 'idle' || friends.submission === 'error') && contains(submit, local)) {
      return 'submit';
    }
    return null;
  }
}
