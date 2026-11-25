import { Bounds, type Container, Text, Texture } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { viewport } from './layout';
import { ResultsPanel } from './resultsPanel';
import type { ResultsView } from './resultsSession';

const large = Number.MAX_SAFE_INTEGER;
const personal: ResultsView['personal'] = { run: { score: large, level: large, bestCombo: large }, isPersonalBest: true,
  rows: Array.from({ length: 10 }, (_, i) => ({ rank: i + 1, score: large - i, current: i === 9 })) };

beforeEach(() => {
  vi.spyOn(Text.prototype, 'getLocalBounds').mockImplementation(function (this: Text) {
    const width = this.text.length * this.style.fontSize * 0.62;
    return new Bounds(-width * this.anchor.x, -this.style.fontSize / 2,
      width * (1 - this.anchor.x), this.style.fontSize / 2);
  });
});
afterEach(() => vi.restoreAllMocks());

function getText(panel: ResultsPanel, id: string): Text {
  return panel.root.getChildByLabel(id, true) as Text;
}

function center(panel: ResultsPanel, id: string) {
  let x = 0;
  let y = 0;
  for (let part: Container | null = getText(panel, id); part; part = part.parent) {
    x += part.x;
    y += part.y;
  }
  return { x, y };
}

function list(panel: ResultsPanel, tab: 'personal' | 'friends') {
  return panel.root.getChildByLabel(`${tab}-list`, true)!;
}

describe('Pixi results panel', () => {
  it('shows a full dough meter as the terminal reason', () => {
    const panel = new ResultsPanel(Texture.WHITE);
    panel.show({ personal, tab: 'personal', friends: null }, 650, 'dough-meter');
    expect(getText(panel, 'result-heading').text).toBe('Dough meter full');
    panel.root.destroy({ children: true });
  });

  it('prepares common labels without a hittable panel and reuses them with changing results and height', () => {
    const panel = new ResultsPanel(Texture.WHITE);
    const prepared = [...panel.warmup()];
    const restart = getText(panel, 'result-restart');
    expect(prepared).toContain(restart);
    expect(panel.hit(center(panel, 'result-restart'))).toBeNull();
    const view: ResultsView = { personal, tab: 'personal', friends: null };
    panel.show(view, 650);
    const firstY = panel.root.y;
    const currentRow = list(panel, 'personal').getChildByLabel('leaderboard-current-score');
    panel.show({ ...view, personal: { ...personal, run: { score: 100, level: 1, bestCombo: 1 } } }, 730);
    expect(panel.root.y).toBe(firstY + 40);
    expect(getText(panel, 'result-restart')).toBe(restart);
    expect(getText(panel, 'result-score-value').text).toBe('100');
    expect(list(panel, 'personal').getChildByLabel('leaderboard-current-score')).toBe(currentRow);
    expect(panel.hit(center(panel, 'result-restart'))).toBe('restart');
    panel.root.destroy({ children: true });
  });

  it('fits ten rows and safe-integer scores, level and combo at 320 × 568 and keeps Play Again hittable after resize', () => {
    const panel = new ResultsPanel(Texture.WHITE);
    const fit = viewport(320, 568);
    panel.show({ personal, tab: 'personal', friends: null }, fit.height);
    expect(list(panel, 'personal').children).toHaveLength(10);
    const current = list(panel, 'personal').getChildByLabel('leaderboard-current-score')!;
    expect(current.children).toHaveLength(4);
    expect((current.children[1] as Text).text).toBe('10.');
    expect(panel.scrollBy(500)).toBe(false);
    expect(getText(panel, 'result-personal-best').text).toBe('New personal best!');
    const number = new Intl.NumberFormat();
    const values = ['score', 'level', 'combo'].map(stat => getText(panel, `result-${stat}-value`));
    expect(values.map(value => value.text)).toEqual([number.format(large), number.format(large), `${number.format(large)}×`]);
    values.forEach((value, index) => expect(value.getLocalBounds().width * value.scale.x).toBeCloseTo(index === 0 ? 214 : 130));
    const bounds = panel.root.children[0].getLocalBounds();
    expect((panel.root.x + bounds.minX) * fit.scale + fit.x).toBeGreaterThan(0);
    expect((panel.root.x + bounds.maxX) * fit.scale + fit.x).toBeLessThan(320);
    expect((panel.root.y + bounds.minY) * fit.scale + fit.y).toBeGreaterThan(0);
    expect((panel.root.y + bounds.maxY) * fit.scale + fit.y).toBeLessThan(568);
    expect(panel.hit(center(panel, 'result-restart'))).toBe('restart');
    expect(panel.root.getChildByLabel('results-tab-friends')).toBeNull();
    panel.resize(540);
    expect(panel.hit(center(panel, 'result-restart'))).toBe('restart');
    expect(panel.scrollBy(500)).toBe(true);
    panel.root.destroy({ children: true });
  });

  it('shows Friends consent and makes Submit hittable only on the Friends tab while available', () => {
    const panel = new ResultsPanel(Texture.WHITE);
    const friends: ResultsView['friends'] = { list: { status: 'ready', scores: [] }, submission: 'idle' };
    const view: ResultsView = { personal: { ...personal, isPersonalBest: false }, tab: 'friends', friends };
    panel.show({ ...view, tab: 'personal' }, viewport(320, 568).height);
    panel.show(view, viewport(320, 568).height);
    expect(getText(panel, 'friends-list-status').text).toBe('No friends scores yet.');
    expect(getText(panel, 'friends-submit-disclosure').text).toContain('Facebook friends leaderboard');
    const submit = center(panel, 'friends-submit');
    const restart = center(panel, 'result-restart');
    expect(panel.hit(submit)).toBe('submit');
    expect(panel.hit(restart)).toBe('restart');
    expect(panel.hit(center(panel, 'results-tab-personal'))).toBe('personal');
    expect(panel.root.getChildByLabel('result-personal-best')).toBeNull();
    panel.show({ ...view, friends: { ...friends, submission: 'submitting' } }, 710);
    expect(panel.hit(center(panel, 'friends-submit'))).toBeNull();
    const disabledSubmit = center(panel, 'friends-submit');
    panel.show({ ...view, tab: 'personal' }, 710);
    expect(panel.hit(disabledSubmit)).toBeNull();
    expect(panel.hit(center(panel, 'result-restart'))).toBe('restart');
    expect(panel.hit(center(panel, 'results-tab-friends'))).toBe('friends');
    panel.root.destroy({ children: true });
  });

  it('shows ten Friends ranks in order with the current player in place and fits wide names and scores', () => {
    const panel = new ResultsPanel(Texture.WHITE);
    const score = Number.MAX_SAFE_INTEGER;
    const ranks = [93, 8, 2, 25, 10, 70, 19, 3, 30, 14];
    const friends: ResultsView['friends'] = { list: { status: 'ready',
      scores: ranks.map(rank => ({ rank, name: 'WWWWWWWWWWWWWWWWWWWWW', score, current: rank === 93 })) },
      submission: 'idle' };
    panel.show({ personal, tab: 'friends', friends }, viewport(320, 568).height);
    const rows = list(panel, 'friends').children;
    expect(rows.map(row => (row.children[1] as Text).text)).toEqual(
      ['2.', '3.', '8.', '10.', '14.', '19.', '25.', '30.', '70.', '93.'],
    );
    expect(rows.at(-1)?.label).toBe('friends-current-score');
    expect(panel.scrollBy(500)).toBe(false);
    for (const row of rows) {
      const name = row.children[2] as Text;
      const value = row.children[3] as Text;
      expect(name.text.endsWith('…')).toBe(true);
      expect(name.scale.x).toBe(1);
      expect(name.x + name.getLocalBounds().maxX).toBeLessThan(value.x + value.getLocalBounds().minX * value.scale.x);
      expect(value.text).toBe(new Intl.NumberFormat().format(score));
    }
    panel.root.destroy({ children: true });
  });

  it('clips overflowing rows and lets each tab scroll to its last row while keeping the controls fixed', () => {
    const panel = new ResultsPanel(Texture.WHITE);
    const friends: ResultsView['friends'] = { list: { status: 'ready',
      scores: personal.rows.map(row => ({ ...row, name: 'Dough Enthusiast' })) }, submission: 'idle' };
    const view: ResultsView = { personal, friends, tab: 'friends' };
    panel.show(view, 540);
    const resultsList = panel.root.getChildByLabel('results-list')!;
    const content = resultsList.getChildByLabel('results-list-content')!;
    const mask = resultsList.getChildByLabel('results-list-mask')!;
    const point = { x: panel.root.x + 30, y: panel.root.y + resultsList.y + 15 };
    const submit = center(panel, 'friends-submit');
    const restart = center(panel, 'result-restart');
    expect(content.mask).toBe(mask);
    expect(panel.canScroll(point)).toBe(true);
    expect(panel.canScroll(submit)).toBe(false);
    expect(panel.scrollBy(500)).toBe(true);
    const end = content.y;
    expect(end).toBeLessThan(0);
    expect(list(panel, 'friends').children.at(-1)!.y + 24 + end).toBeLessThanOrEqual(mask.getLocalBounds().maxY);
    expect(panel.scrollBy(500)).toBe(false);
    expect(panel.hit(submit)).toBe('submit');
    expect(panel.hit(restart)).toBe('restart');
    panel.show({ ...view, tab: 'personal' }, 540);
    expect(content.y).toBeCloseTo(0);
    expect(panel.scrollBy(40)).toBe(true);
    panel.show(view, 540);
    expect(content.y).toBe(end);
    panel.show({ ...view, tab: 'personal' }, 540);
    expect(content.y).toBe(-40);
    panel.show({ ...view, personal: { ...personal } }, 540);
    expect(content.y).toBeCloseTo(0);
    panel.resize(710);
    expect(panel.scrollBy(500)).toBe(false);
    panel.root.destroy({ children: true });
  });

  it('returns from overflow to the top for a refreshed short list or when a Friends request fails', () => {
    const panel = new ResultsPanel(Texture.WHITE);
    const rows = personal.rows.map(row => ({ ...row, name: 'Donut' }));
    const view: ResultsView = { personal, tab: 'friends',
      friends: { list: { status: 'ready', scores: rows }, submission: 'idle' } };
    panel.show(view, 540);
    expect(panel.scrollBy(500)).toBe(true);
    panel.show({ ...view, friends: { list: { status: 'error' }, submission: 'error' } }, 540);
    expect(getText(panel, 'friends-list-status').text).toContain('Tap Friends to retry');
    expect(panel.scrollBy(500)).toBe(false);
    panel.show({ ...view, friends: { list: { status: 'ready', scores: rows.slice(0, 2) }, submission: 'sent' } }, 540);
    expect(list(panel, 'friends').children).toHaveLength(2);
    expect(panel.scrollBy(500)).toBe(false);
    expect(getText(panel, 'friends-submit').text).toBe('Score submitted');
    panel.root.destroy({ children: true });
  });
});
