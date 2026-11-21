import { describe, expect, it } from 'vitest';
import { StackGestures, type Target } from './gestures';
import { contains, layoutStacks, stackHit, STACK_LIFT, viewport } from './layout';

const left = { x: 48, y: 100 };
const middle = { x: 150, y: 100 };
const right = { x: 260, y: 100 };
const outside = { x: 440, y: 100 };

function fixture() {
  const stacks = [1, 0, 5, 2];
  return new StackGestures(index => stacks[index] > 0, (from, to) => stacks[from] > 0 && stacks[to] < 5);
}

function tap(gestures: StackGestures, target: Target, point = left) {
  gestures.start(1, point, target);
  return gestures.finish(1, { x: point.x + 3, y: point.y - 2 }, target);
}

describe('stack gestures', () => {
  it('selects on tap release, tolerates jitter, and moves into an empty stack', () => {
    const gestures = fixture();
    expect(tap(gestures, 1, middle)).toBeNull();
    expect(gestures.source).toBeNull();
    gestures.start(1, left, 0);
    expect(gestures.source).toBeNull();
    expect(gestures.finish(1, { x: 51, y: 98 }, 0)).toBeNull();
    expect(gestures.source).toBe(0);
    expect(tap(gestures, 1, middle)).toEqual({ kind: 'move', from: 0, to: 1 });
    expect(gestures.source).toBeNull();
  });

  it('keeps selection on a gap or outside tap and clears it on an explicit same-stack tap', () => {
    const gestures = fixture();
    tap(gestures, 0);
    gestures.start(1, { x: 182, y: 100 }, null);
    expect(gestures.finish(1, { x: 183, y: 100 }, null)).toBeNull();
    expect(gestures.source).toBe(0);
    tap(gestures, null, outside);
    expect(gestures.source).toBe(0);
    tap(gestures, 0);
    expect(gestures.source).toBeNull();
  });

  it('keeps the pressed target through small movement over its edge', () => {
    const gestures = fixture();
    tap(gestures, 0);
    gestures.start(1, middle, 1);
    const drift = { x: middle.x + 2, y: middle.y - 3 };
    gestures.update(1, drift, null);
    expect(gestures.pressedStack).toBe(1);
    expect(gestures.finish(1, drift, null)).toEqual({ kind: 'move', from: 0, to: 1 });
  });

  it('cancels an off-board release even within tap jitter and keeps the prior selection', () => {
    const gestures = fixture();
    tap(gestures, 0);
    gestures.start(1, middle, 1, 12);
    const edge = { x: middle.x + 2, y: middle.y + 2 };
    gestures.update(1, edge, 'outside');
    expect(gestures.pressedStack).toBeNull();
    expect(gestures.finish(1, edge, 'outside')).toBeNull();
    expect(gestures.source).toBe(0);
    gestures.start(1, left, 0);
    gestures.update(1, middle, 1);
    expect(gestures.destination).toBe(1);
    expect(gestures.finish(1, outside, 'outside')).toBeNull();
    expect(gestures.source).toBe(0);
  });

  it('uses the swipe origin and release target, skipping intermediate stacks', () => {
    const gestures = fixture();
    tap(gestures, 3);
    gestures.start(1, right, 2);
    expect(gestures.update(1, middle, 1)).toBe(true);
    expect(gestures.source).toBe(2);
    expect(gestures.destination).toBe(1);
    expect(gestures.finish(1, left, 0)).toEqual({ kind: 'move', from: 2, to: 0 });
    expect(gestures.source).toBeNull();
    expect(gestures.destination).toBeNull();
  });

  it('recognizes a swipe from its release alone and keeps the source when the target is full', () => {
    const gestures = fixture();
    gestures.start(1, left, 0);
    expect(gestures.finish(1, right, 2)).toEqual({ kind: 'blocked', from: 0, to: 2 });
    expect(gestures.source).toBe(0);
    expect(tap(gestures, 2, right)).toEqual({ kind: 'blocked', from: 0, to: 2 });
    expect(tap(gestures, 1, middle)).toEqual({ kind: 'move', from: 0, to: 1 });
  });

  it('cancels at the edge, on return to the origin, or when a swipe starts outside or empty', () => {
    const gestures = fixture();
    gestures.start(1, left, 0);
    gestures.update(1, middle, 1);
    expect(gestures.finish(1, outside, null)).toBeNull();
    gestures.start(1, left, 0);
    gestures.update(1, middle, 1);
    expect(gestures.finish(1, left, 0)).toBeNull();
    gestures.start(1, outside, null);
    expect(gestures.finish(1, left, 0)).toBeNull();
    gestures.start(1, middle, 1);
    expect(gestures.finish(1, right, 2)).toBeNull();
    expect(gestures.source).toBeNull();
  });

  it('ignores other pointers and discards a canceled or resized gesture', () => {
    const gestures = fixture();
    tap(gestures, 3);
    expect(gestures.start(7, left, 0)).toBe(true);
    expect(gestures.start(8, middle, 1)).toBe(false);
    expect(gestures.update(8, right, 2)).toBe(false);
    expect(gestures.finish(8, middle, 1)).toBeNull();
    expect(gestures.cancel(8)).toBe(false);
    expect(gestures.update(7, middle, 1)).toBe(true);
    expect(gestures.cancel(7)).toBe(true);
    expect(gestures.source).toBe(3);
    expect(gestures.finish(7, middle, 1)).toBeNull();
    gestures.start(8, left, 0);
    gestures.reset();
    expect(gestures.finish(8, middle, 1)).toBeNull();
    expect(gestures.source).toBeNull();
  });

  it('restarts only after a complete button tap', () => {
    const gestures = fixture();
    gestures.start(1, left, null);
    expect(gestures.finish(1, right, 'restart')).toBeNull();
    gestures.start(1, left, 'restart');
    expect(gestures.finish(1, middle, 'restart')).toBeNull();
    expect(tap(gestures, 'restart')).toEqual({ kind: 'restart' });
  });

  it.each([
    { count: 3, lower: 3, capacity: 6 },
    { count: 4, lower: 4, capacity: 7 },
    { count: 5, lower: 5, capacity: 8 },
    { count: 6, lower: 3, capacity: 9 },
    { count: 7, lower: 3, capacity: 10 },
    { count: 8, lower: 4, capacity: 10 },
  ])('centers the $count-stack formation and fits its full capacity on a small phone', ({ count, lower, capacity }) => {
    const fit = viewport(320, 568);
    const { slots, donutWidth, donutHeight, step } = layoutStacks(fit.height, count);
    const hits = slots.map(slot => stackHit(slot, capacity, donutHeight, step));
    expect(slots).toHaveLength(count);
    expect(donutHeight / donutWidth).toBeCloseTo(320 / 430);
    slots.forEach((slot, index) => {
      expect(hits[index].width * fit.scale).toBeGreaterThan(44);
      const top = { x: slot.x, y: slot.base - (capacity - 1) * step - donutHeight - STACK_LIFT };
      expect(hits.findIndex(hit => contains(hit, top))).toBe(index);
      expect(hits.findIndex(hit => contains(hit, { x: slot.x, y: slot.base }))).toBe(index);
      expect(hits[index].height * fit.scale).toBeGreaterThan(44);
      expect(contains(hits[index], { x: slot.x, y: slot.base + 11 })).toBe(true);
    });

    for (const row of [slots.slice(0, lower), slots.slice(lower)].filter(row => row.length > 0)) {
      expect((row[0].x + row.at(-1)!.x) / 2).toBeCloseTo(200);
      expect(new Set(row.map(slot => slot.base)).size).toBe(1);
      expect(row.map(slot => slot.x)).toEqual(row.map(slot => slot.x).sort((a, b) => a - b));
    }
    if (lower < count) expect(slots[lower].base).toBeLessThan(slots[0].base);
  });

  it('uses the extra horizontal room available to formations with fewer columns', () => {
    const { height } = viewport(390, 662);
    const widths = [3, 4, 5, 6, 7, 8].map(count => layoutStacks(height, count).donutWidth);
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[1]).toBeGreaterThan(widths[2]);
    expect(widths[3]).toBeGreaterThan(widths[2]);
    expect(widths[3]).toBeGreaterThan(widths[4]);
    expect(widths[4]).toEqual(widths[5]);
  });

  it('reveals more pastry in tall or sparse formations while keeping dense stacks seated', () => {
    const opening = layoutStacks(viewport(390, 662).height, 3);
    const compact = layoutStacks(viewport(390, 540).height, 3);
    const late = layoutStacks(viewport(320, 568).height, 8);
    const tallLate = layoutStacks(viewport(320, 720).height, 8);
    expect(opening.donutWidth).toBe(compact.donutWidth);
    expect(opening.step / opening.donutHeight).toBeCloseTo(0.442);
    expect(compact.step).toBeLessThan(opening.step);
    expect(late.step / late.donutHeight).toBeCloseTo(0.238);
    expect(tallLate.step).toBeGreaterThan(late.step);
  });
});
