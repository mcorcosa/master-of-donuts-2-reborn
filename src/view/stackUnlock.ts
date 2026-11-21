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
  const progress = ease(time);
  const splitsRows = before.slots.length === 5 && after.slots.length === 6;
  // Open the gap between the two rows before sliding stacks across one another.
  const across = splitsRows ? ease((time - 0.12) / 0.88) : progress;
  const down = splitsRows ? ease(time / 0.79) : progress;
  const slots = before.slots.map((slot, index) => ({
    ...slot, x: mix(slot.x, after.slots[index].x, across), base: mix(slot.base, after.slots[index].base, down),
  }));
  // Give the neighboring stack time to clear the space occupied by the new tray.
  const entrance = ease((time - 0.63) / 0.34);
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
