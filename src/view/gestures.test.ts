import { describe, expect, it } from 'vitest';
import { StackGestures, type Target } from './gestures';
import { BOARD_CENTER, contains, layoutStacks, stackHit, STACK_LIFT, viewport } from './layout';
import { STACK_UNLOCK_MS, stackUnlockFrame } from './stackUnlock';

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
  it('requires an armed Joker tap to press and release the same occupied stack', () => {
    const gestures = fixture();
    gestures.start(1, left, 0, 'touch', true);
    expect(gestures.boosterPress).toBe(true);
    expect(gestures.finish(2, left, 0)).toBeNull();
    expect(gestures.finish(1, { x: left.x + 3, y: left.y }, 0)).toEqual({ kind: 'joker-target', stack: 0 });
    expect(gestures.boosterPress).toBe(false);
    expect(gestures.source).toBeNull();

    gestures.start(1, middle, 1, 'mouse', true);
    expect(gestures.finish(1, middle, 1)).toBeNull();
    gestures.start(1, left, 0, 'touch', true);
    gestures.update(1, right, 2);
    expect(gestures.dragSource).toBeNull();
    expect(gestures.finish(1, left, 0)).toBeNull();
    gestures.start(1, left, 0, 'mouse', true);
    expect(gestures.finish(1, { x: left.x + 1, y: left.y }, 1)).toBeNull();
    expect(gestures.source).toBeNull();
  });

  it.each(['joker', 'sweep'] as const)('requires a full %s button click and leaves stack selection alone on a crossed release', button => {
    const gestures = fixture();
    tap(gestures, 0);
    gestures.start(1, left, 1);
    expect(gestures.finish(1, left, button)).toBeNull();
    expect(gestures.source).toBe(0);
    gestures.start(1, left, button);
    expect(gestures.boosterPress).toBe(true);
    expect(gestures.finish(1, left, 1)).toBeNull();
    expect(tap(gestures, button)).toEqual({ kind: button });
  });

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

  it('selects and deselects on release anywhere inside the pressed mouse stack', () => {
    const gestures = fixture();
    const far = { x: left.x + 37, y: left.y + 54 };
    for (const expected of [0, null]) {
      gestures.start(1, left, 0, 'mouse');
      gestures.update(1, far, 0);
      expect(gestures.dragSource).toBeNull();
      expect(gestures.pressedStack).toBe(0);
      expect(gestures.finish(1, far, 0)).toBeNull();
      expect(gestures.source).toBe(expected);
    }
  });

  it('keeps minor mouse boundary jitter a click after a long excursion inside the stack', () => {
    const gestures = fixture();
    gestures.start(1, left, 0, 'mouse');
    gestures.update(1, { x: left.x - 36, y: left.y }, 0);
    expect(gestures.finish(1, { x: left.x + 2, y: left.y }, 1)).toBeNull();
    expect(gestures.source).toBe(0);
  });

  it.each(['mouse', 'touch'])('selects on the first %s release after crossing a gap and returning', device => {
    const gestures = fixture();
    gestures.start(1, left, 0, device);
    gestures.update(1, { x: left.x, y: left.y - 19 }, null);
    gestures.finish(1, left, 0);
    expect(gestures.source).toBe(0);
    expect(tap(gestures, 1, right)).toEqual({ kind: 'move', from: 0, to: 1 });
  });

  it('selects after 14 pixels of touch drift within the first stack', () => {
    const gestures = fixture();
    gestures.start(1, left, 0, 'touch');
    const end = { x: left.x + 14, y: left.y };
    gestures.update(1, end, 0);
    expect(gestures.dragSource).toBeNull();
    gestures.finish(1, end, 0);
    expect(gestures.source).toBe(0);
    expect(tap(gestures, 1, right)).toEqual({ kind: 'move', from: 0, to: 1 });
  });

  it('cancels a first press released in a distant gap', () => {
    const gestures = fixture();
    gestures.start(1, left, 0, 'touch');
    gestures.finish(1, right, null);
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

  it('commits the reported touch tap with 13 pixels of drift inside the destination', () => {
    const gestures = fixture();
    tap(gestures, 0);
    gestures.start(1, { x: 160, y: 347 }, 1, 'touch');
    gestures.update(1, { x: 165, y: 352 }, 1);
    expect(gestures.finish(1, { x: 173, y: 347 }, 1)).toEqual({ kind: 'move', from: 0, to: 1 });
  });

  it('treats a longer in-stack excursion as a swipe even if the finger returns to its press point', () => {
    const gestures = fixture();
    tap(gestures, 0);
    gestures.start(1, middle, 1, 'touch');
    gestures.update(1, { x: middle.x + 18, y: middle.y }, 1);
    expect(gestures.pressedStack).toBeNull();
    expect(gestures.finish(1, middle, 1)).toBeNull();
    expect(gestures.source).toBe(0);
  });

  it.each([2, 3])('keeps the destination tap after 13px of boundary drift into stack %i', neighbor => {
    const gestures = fixture();
    tap(gestures, 0);
    const press = { x: 150, y: 228 };
    const release = { x: 163, y: 228 };
    gestures.start(1, press, 1, 'touch');
    gestures.update(1, release, neighbor);
    expect(gestures.dragSource).toBeNull();
    expect(gestures.finish(1, release, neighbor)).toEqual({ kind: 'move', from: 0, to: 1 });
  });

  it('previews a longer cross-stack swipe and cancels an out-and-back swipe', () => {
    const gestures = fixture();
    tap(gestures, 0);
    gestures.start(1, right, 3, 'touch');
    gestures.update(1, { x: right.x + 13, y: right.y }, 3);
    expect(gestures.pressedStack).toBe(3);
    const neighboring = { x: right.x + 19, y: right.y };
    gestures.update(1, neighboring, 1);
    expect(gestures.source).toBe(3);
    expect(gestures.destination).toBe(1);
    expect(gestures.finish(1, neighboring, 1)).toEqual({ kind: 'move', from: 3, to: 1 });

    tap(gestures, 0);
    gestures.start(1, right, 3, 'touch');
    gestures.update(1, { x: right.x + 13, y: right.y }, 1);
    expect(gestures.finish(1, { x: right.x + 13, y: right.y }, 3)).toBeNull();
    expect(gestures.source).toBe(0);
  });

  it('preserves full-stack feedback and the original threshold for same-stack cancel and results actions', () => {
    const gestures = fixture();
    tap(gestures, 0);
    gestures.start(1, right, 2, 'touch');
    expect(gestures.finish(1, { x: right.x + 13, y: right.y }, 2)).toEqual({ kind: 'blocked', from: 0, to: 2 });
    gestures.start(1, left, 0, 'touch');
    expect(gestures.finish(1, { x: left.x + 13, y: left.y }, 0)).toBeNull();
    expect(gestures.source).toBe(0);
    tap(gestures, 0);
    expect(gestures.source).toBeNull();
    gestures.start(1, left, 'restart', 'touch');
    expect(gestures.finish(1, { x: left.x + 13, y: left.y }, 'restart')).toBeNull();
  });

  it('cancels an off-board release even within tap jitter and keeps the prior selection', () => {
    const gestures = fixture();
    tap(gestures, 0);
    gestures.start(1, middle, 1, 'touch');
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

  it('activates Hint only from its own complete press without stealing a stack gesture', () => {
    const gestures = fixture();
    tap(gestures, 0);
    gestures.start(1, middle, 1, 'touch');
    expect(gestures.finish(1, { x: middle.x + 2, y: middle.y }, 'hint')).toBeNull();
    expect(gestures.source).toBe(0);
    gestures.start(1, middle, 'hint', 'touch');
    expect(gestures.finish(1, { x: middle.x + 13, y: middle.y }, 'hint')).toBeNull();
    expect(tap(gestures, 'hint', middle)).toEqual({ kind: 'hint' });
  });

  it.each([
    { count: 3, lower: 3, capacity: 6 },
    { count: 4, lower: 4, capacity: 7 },
    { count: 5, lower: 2, capacity: 8 },
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

    const lowerBase = Math.max(...slots.map(slot => slot.base));
    const lowerRow = slots.filter(slot => slot.base === lowerBase);
    const upperRow = slots.filter(slot => slot.base < lowerBase);
    expect(lowerRow).toHaveLength(lower);
    for (const row of [lowerRow, upperRow].filter(row => row.length > 0)) {
      expect((row[0].x + row.at(-1)!.x) / 2).toBeCloseTo(BOARD_CENTER);
      expect(new Set(row.map(slot => slot.base)).size).toBe(1);
      expect(row.map(slot => slot.x)).toEqual(row.map(slot => slot.x).sort((a, b) => a - b));
    }
  });

  it('centers the five-stack pair and keeps identities when the left stack moves down at six', () => {
    const { height } = viewport(390, 662);
    const five = layoutStacks(height, 5, 7);
    const expanded = layoutStacks(height, 5, 8);
    const six = layoutStacks(height, 6, 8);
    expect(five.slots.map(slot => slot.x)).toEqual(expanded.slots.map(slot => slot.x));
    expect(five.donutWidth).toBeGreaterThan(expanded.donutWidth);
    expect(five.slots[0].base).toBeLessThan(five.slots[1].base);
    expect(five.slots[1].base).toBe(five.slots[2].base);
    expect(five.slots[0].base).toBe(five.slots[3].base);
    expect(five.slots[3].base).toBe(five.slots[4].base);
    expect(five.slots[0].x).toBe(six.slots[0].x);
    expect(six.slots[0].base).toBe(six.slots[1].base);
  });

  it.each([[320, 568], [390, 662], [390, 844]])(
    'keeps full columns from crossing during both split unlocks at %i × %i', (width, height) => {
      const fit = viewport(width, height);
      for (const [count, capacity] of [[4, 7], [5, 8]]) {
        const before = layoutStacks(fit.height, count, capacity);
        const after = layoutStacks(fit.height, count + 1, capacity);
        for (let age = 0; age <= STACK_UNLOCK_MS; age += 2) {
          const { layout, entrance, trayScale, trayOffset } = stackUnlockFrame(before, after, age);
          const footprint = (x: number, base: number, width: number, donutHeight: number, step: number, depth: number) => ({
            left: x - width * 0.52, right: x + width * 0.52,
            top: base - donutHeight - (depth - 1) * step, bottom: base + 20,
          });
          const columns = layout.slots.map(({ x, base }) =>
            footprint(x, base, layout.donutWidth, layout.donutHeight, layout.step, capacity));
          if (entrance) {
            const { x, base } = after.slots[count];
            columns.push(footprint(x, base + trayOffset, after.donutWidth * trayScale,
              after.donutHeight * trayScale, after.step * trayScale, Math.floor(capacity / 2)));
          }
          for (const [index, a] of columns.entries()) {
            for (const b of columns.slice(index + 1)) {
              const overlaps = a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
              expect(overlaps, `${count}→${count + 1} at ${age} ms`).toBe(false);
            }
          }
        }
      }
    },
  );

  it('uses the extra horizontal room available to formations with fewer columns', () => {
    const { height } = viewport(390, 662);
    const widths = [3, 4, 5, 6, 7, 8].map(count => layoutStacks(height, count).donutWidth);
    expect(widths[0]).toBeGreaterThan(widths[1]);
    expect(widths[1]).toBeGreaterThan(widths[2]);
    expect(widths[3]).toBeLessThan(widths[2]);
    expect(widths[3]).toBeGreaterThan(widths[4]);
    expect(widths[4]).toEqual(widths[5]);
  });

  it.each([[390, 540], [390, 662], [320, 568], [320, 720]])(
    'keeps the same donut proportions and fits the full stack at %i × %i', (width, height) => {
      const fit = viewport(width, height);
      for (const count of [3, 4, 5, 6, 7, 8]) {
        const { slots, donutHeight, step } = layoutStacks(fit.height, count);
        const capacity = Math.min(10, count + 3);
        expect(step / donutHeight).toBeCloseTo(0.4784, 8);
        for (const slot of slots) {
          const crown = slot.base - (capacity - 1) * step - donutHeight - STACK_LIFT;
          expect(crown - slot.hit.y).toBeGreaterThanOrEqual(4.9999);
          expect(slot.hit.y + slot.hit.height - (slot.base + 20)).toBeGreaterThanOrEqual(4.9999);
        }
      }
    },
  );
});
