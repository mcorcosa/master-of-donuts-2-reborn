import { Text } from 'pixi.js';
import { describe, expect, it } from 'vitest';
import { GAIN_DOCK_MS, GAIN_ORIGIN_HOLD_MS, MOVE_COST_INK, MOVE_GAIN_INK, MOVE_GAIN_MS, MOVE_SPEND_MS, MoveCost } from './moveCost';

const dock = (remaining: number) => ({ x: 33, y: 550 - (remaining + 1) * 10 });
const visible = (cost: MoveCost) => cost.root.children.filter(label => label.visible) as Text[];

describe('move cost presentation', () => {
  it('holds at the landing stack, flies to the vial, and spends exactly at the dock', () => {
    const cost = new MoveCost();
    cost.enqueue({ x: 200, y: 245 }, 170, false, 7);
    cost.show(169, 600, dock);
    expect(visible(cost)).toHaveLength(0);
    expect(cost.deadline).toBe(170);
    expect(cost.animating).toBe(false);

    expect(cost.show(170, 600, dock)).toBeUndefined();
    const [label] = visible(cost);
    expect(label).toMatchObject({ text: '−1 MOVE', eventMode: 'none', x: 200, y: 245, alpha: 1 });
    expect(label.style.fill).toBe(MOVE_COST_INK);
    expect(cost.animating).toBe(true);
    cost.show(290, 600, dock);
    expect(label.position).toMatchObject({ x: 200, y: 245 });

    expect(cost.show(430, 600, dock)).toBeUndefined();
    expect(label.x).toBeLessThan(200);
    expect(label.x).toBeGreaterThan(dock(7).x);
    expect(label.scale.x).toBeLessThan(1);
    expect(cost.show(539, 600, dock)).toBeUndefined();
    expect(cost.show(540, 600, dock)).toEqual({ remaining: 7, reduced: false });
    expect(label.position).toMatchObject(dock(7));
    cost.show(588, 600, dock);
    expect(visible(cost)).toHaveLength(0);
    expect(cost.animating).toBe(false);
    expect(cost.deadline).toBe(0);
    cost.root.destroy({ children: true });
  });

  it('applies reduced motion immediately and holds the copy without motion', () => {
    const cost = new MoveCost();
    cost.enqueue({ x: 350, y: 525 }, 10, true, 3);
    expect(cost.show(10, 600, dock)).toEqual({ remaining: 3, reduced: true });
    const [label] = visible(cost);
    const { x, y } = label;
    expect(cost.animating).toBe(false);
    expect(cost.deadline).toBe(460);
    cost.show(440, 600, dock);
    expect(label).toMatchObject({ x, y, alpha: 1, visible: true });
    expect(label.scale.x).toBe(1);
    expect(cost.show(460, 600, dock)).toBeUndefined();
    expect(label.visible).toBe(false);
    expect(cost.deadline).toBe(0);
    cost.root.destroy({ children: true });
  });

  it.each([false, true])('presents every charge in a 28-miss burst, reduced motion %s', reduced => {
    const cost = new MoveCost();
    for (let i = 0; i < 28; i++) cost.enqueue({ x: 84 + i, y: 212 }, 10, reduced, 27 - i);
    let spawned = 0;
    const receipts: number[] = [];
    for (let dt = 0; dt <= 4000; dt += 16) {
      const update = cost.show(10 + dt, 570, dock);
      if (update && 'remaining' in update) {
        receipts.push(update.remaining);
        if (!reduced) expect(visible(cost).some(label => label.x === dock(update.remaining).x && label.y === dock(update.remaining).y)).toBe(true);
      }
      const labels = visible(cost);
      if (dt % MOVE_SPEND_MS === 0 && dt < 28 * MOVE_SPEND_MS) {
        expect(labels.find(label => label.x === 84 + spawned)?.alpha).toBe(1);
        spawned++;
      }
      if (reduced) {
        const rows = labels.map(label => label.y).sort((a, b) => a - b);
        for (let i = 1; i < rows.length; i++) expect(rows[i] - rows[i - 1]).toBeGreaterThanOrEqual(36.98);
      }
    }
    expect(spawned).toBe(28);
    expect(receipts).toEqual(Array.from({ length: 28 }, (_, i) => 27 - i));
    expect(visible(cost)).toHaveLength(0);
    expect(cost.deadline).toBe(0);
    cost.enqueue({ x: 40, y: 235 }, 4000, reduced, 1);
    cost.show(4000, 570, dock);
    cost.enqueue({ x: 50, y: 235 }, 4001, reduced, 0);
    cost.clear();
    cost.show(4500, 570, dock);
    expect(visible(cost)).toHaveLength(0);
    expect(cost.deadline).toBe(0);
    cost.root.destroy({ children: true });
  });

  it('docks each overdue miss on its own frame before applying a later recovery', () => {
    const cost = new MoveCost();
    for (const [started, remaining] of [[0, 3], [128, 2], [256, 1]]) {
      cost.enqueue({ x: 220, y: 280 }, started, false, remaining);
      expect(cost.show(started, 600, dock)).toBeUndefined();
    }
    const level = { source: 'level', restored: 7, remaining: 8 } as const;
    const combo = { source: 'combo', restored: 1, remaining: 9 } as const;
    cost.recover(level, 300, false);
    cost.recover(combo, 300, false);
    cost.enqueue({ x: 200, y: 245 }, 302, false, 8);
    for (const [at, remaining] of [[700, 3], [828, 2], [956, 1]]) {
      expect(cost.show(at, 600, dock)).toEqual({ remaining, reduced: false });
      expect(cost.show(at + 16, 600, dock)).toBeUndefined();
    }
    const firstRecovery = 1084;
    expect(cost.show(firstRecovery, 600, dock)).toMatchObject({ recovery: level });
    expect(cost.show(firstRecovery + MOVE_GAIN_MS - 1, 600, dock)).toBeUndefined();
    expect(cost.show(firstRecovery + MOVE_GAIN_MS, 600, dock)).toMatchObject({ recovery: combo });
    expect(cost.show(firstRecovery + 2 * MOVE_GAIN_MS, 600, dock)).toBeUndefined();
    expect(cost.show(firstRecovery + 2 * MOVE_GAIN_MS + 370, 600, dock)).toEqual({ remaining: 8, reduced: false });
    cost.root.destroy({ children: true });
  });

  it('flies capped level and combo gains from the receiving stack before the next spend', () => {
    const cost = new MoveCost();
    const anchor = { x: 188, y: 258 };
    const level = { source: 'level', restored: 7, remaining: 27 } as const;
    const combo = { source: 'combo', restored: 1, remaining: 28 } as const;
    const surface = (remaining: number, recovery?: { restored: number }) =>
      dock(recovery ? remaining - recovery.restored - 1 : remaining);
    cost.recover(level, 100, false, anchor);
    cost.recover(combo, 100, false, anchor);
    cost.enqueue(anchor, 102, false, 27);
    const show = (at: number) => cost.show(at, 600, surface);

    show(100);
    const [label] = visible(cost);
    expect(label).toMatchObject({ text: '+7 MOVES', ...anchor });
    expect(label.style.fill).toBe(MOVE_GAIN_INK);
    expect(show(100 + GAIN_ORIGIN_HOLD_MS - 1)).toBeUndefined();
    expect(label.position).toMatchObject(anchor);
    expect(show(100 + MOVE_GAIN_MS)).toBeUndefined();
    expect(label.x).toBeLessThan(anchor.x);
    const impact = 100 + GAIN_DOCK_MS;
    expect(show(impact - 1)).toBeUndefined();
    expect(show(impact)).toEqual({ remaining: 27, recovery: level, reduced: false });
    expect(visible(cost).find(text => text.text === '+7 MOVES')?.position).toMatchObject(surface(27, level));
    expect(show(100 + 2 * MOVE_GAIN_MS)).toBeUndefined();
    expect(show(impact + MOVE_GAIN_MS - 1)).toBeUndefined();
    expect(show(impact + MOVE_GAIN_MS)).toEqual({ remaining: 28, recovery: combo, reduced: false });
    expect(visible(cost).find(text => text.text === '+1 MOVE')?.position).toMatchObject(surface(28, combo));
    expect(show(100 + 2 * MOVE_GAIN_MS + 370)).toBeUndefined();
    const miss = visible(cost).find(text => text.text === '−1 MOVE')!;
    expect(miss.scale.x).toBeGreaterThan(0.4);
    expect(show(impact + 2 * MOVE_GAIN_MS)).toEqual({ remaining: 27, reduced: false });
    cost.root.destroy({ children: true });
  });
});
