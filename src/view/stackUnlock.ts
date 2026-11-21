import type { StackLayout } from './layout';
import { unit } from './movePlayback';

export const STACK_UNLOCK_MS = 460;

function ease(time: number): number {
  const t = unit(time);
  return t * t * (3 - 2 * t);
}

function mix(from: number, to: number, t: number): number {
  return from + (to - from) * t;
}

export function stackUnlockFrame(before: StackLayout, after: StackLayout, age: number) {
  const time = unit(age / STACK_UNLOCK_MS);
  const splitsRows = before.slots.length === 4 && after.slots.length === 5;
  const movesLeftStackDown = before.slots.length === 5 && after.slots.length === 6;
  const progress = splitsRows ? ease(time / 0.5) : ease(time);
  const slots = before.slots.map((slot, index) => {
    let across = progress;
    let vertical = progress;
    if (splitsRows) {
      // Separate the rows first so the lateral moves have room.
      across = ease((time - 0.5) / 0.34);
    } else if (movesLeftStackDown) {
      // Open the lower-left slot, move stack zero down, then slide the upper row left.
      if (index === 0) vertical = ease((time - 0.17) / 0.49);
      else if (index <= 2) across = ease(time / 0.36);
      else across = ease((time - 0.6) / 0.26);
    }
    return { ...slot, x: mix(slot.x, after.slots[index].x, across),
      base: mix(slot.base, after.slots[index].base, vertical) };
  });
  const entrance = splitsRows || movesLeftStackDown ? ease((time - 0.8) / 0.19) : ease((time - 0.63) / 0.34);
  return {
    layout: {
      donutWidth: mix(before.donutWidth, after.donutWidth, progress),
      donutHeight: mix(before.donutHeight, after.donutHeight, progress),
      step: mix(before.step, after.step, progress),
      slots,
    },
    progress,
    entrance,
    trayOffset: 8 * (1 - entrance) ** 2 - 2.2 * Math.sin(Math.PI * entrance),
    trayScale: 0.91 + 0.09 * entrance,
  };
}
