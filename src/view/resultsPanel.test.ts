import { Bounds, Text, Texture } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { viewport } from './layout';
import { ResultsPanel } from './resultsPanel';
import type { ResultsView } from './resultsSession';

const large = Number.MAX_SAFE_INTEGER;
const personal: ResultsView['personal'] = { run: { score: large, level: large, bestCombo: large }, isPersonalBest: true,
  rows: Array.from({ length: 5 }, (_, i) => ({ rank: i + 1, score: large - i, current: i === 0 })) };

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
  const { x, y } = getText(panel, id);
  return { x: panel.root.x + x, y: panel.root.y + y };
}

describe('Pixi results panel', () => {
  it('prepares common labels without a hittable panel and reuses them with changing results and height', () => {
    const panel = new ResultsPanel(Texture.WHITE);
    const prepared = [...panel.warmup()];
    const restart = getText(panel, 'result-restart');
    expect(prepared).toContain(restart);
    expect(panel.hit(center(panel, 'result-restart'))).toBeNull();
    const view: ResultsView = { personal, tab: 'personal', friends: null };
    panel.show(view, 600);
    const firstY = panel.root.y;
    const currentRow = panel.root.getChildByLabel('leaderboard-current-score');
    panel.show({ ...view, personal: { ...personal, run: { score: 100, level: 1, bestCombo: 1 } } }, 700);
    expect(panel.root.y).toBe(firstY + 50);
    expect(getText(panel, 'result-restart')).toBe(restart);
    expect(getText(panel, 'result-score-value').text).toBe('100');
    expect(panel.root.getChildByLabel('leaderboard-current-score')).toBe(currentRow);
    expect(panel.hit(center(panel, 'result-restart'))).toBe('restart');
    panel.root.destroy({ children: true });
  });

  it('fits five rows and safe-integer scores, level and combo at 320 × 568 and keeps Play Again hittable after resize', () => {
    const panel = new ResultsPanel(Texture.WHITE);
    const fit = viewport(320, 568);
    panel.show({ personal, tab: 'personal', friends: null }, fit.height);
    expect(panel.root.children.filter(child => child.label?.startsWith('leaderboard-'))).toHaveLength(5);
    expect(panel.root.getChildByLabel('leaderboard-current-score')?.children).toHaveLength(4);
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
    expect(panel.hit(submit)).toBeNull();
    panel.show({ ...view, tab: 'personal' }, 710);
    expect(panel.hit(submit)).toBeNull();
    expect(panel.hit(restart)).toBe('restart');
    expect(panel.hit(center(panel, 'results-tab-friends'))).toBe('friends');
    panel.root.destroy({ children: true });
  });
});
