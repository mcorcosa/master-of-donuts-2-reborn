import { expect, it } from 'vitest';
import { FrameLoop } from './frameLoop';

function frames() {
  let serial = 0;
  const callbacks = new Map<number, (time: number) => void>();
  return {
    callbacks,
    request(callback: (time: number) => void) {
      callbacks.set(++serial, callback);
      return serial;
    },
    cancel(id: number) { callbacks.delete(id); },
    step(time: number) {
      const batch = [...callbacks.values()];
      callbacks.clear();
      for (const callback of batch) callback(time);
    },
  };
}

it('coalesces requests, submits the final frame and preserves invalidation during a frame', () => {
  const driver = frames();
  const rendered: number[] = [];
  const loop = new FrameLoop(driver, time => {
    rendered.push(time);
    if (time === 48) loop.invalidate();
    return time === 16;
  });
  loop.invalidate();
  loop.invalidate();
  expect(driver.callbacks.size).toBe(1);
  driver.step(16);
  driver.step(32);
  expect(driver.callbacks.size).toBe(0);
  loop.invalidate();
  driver.step(48);
  driver.step(64);
  expect(rendered).toEqual([16, 32, 48, 64]);
  expect(driver.callbacks.size).toBe(0);
});

it('cancels suspended and disposed frames, then wakes once on resume', () => {
  const driver = frames();
  const rendered: number[] = [];
  const loop = new FrameLoop(driver, time => { rendered.push(time); return true; });
  loop.invalidate();
  const stale = driver.callbacks.get(1)!;
  loop.setSuspended(true);
  loop.invalidate();
  expect(driver.callbacks.size).toBe(0);
  loop.setSuspended(false);
  stale(5);
  driver.step(16);
  expect(rendered).toEqual([16]);
  loop.dispose();
  loop.invalidate();
  driver.step(32);
  expect(rendered).toEqual([16]);
  expect(driver.callbacks.size).toBe(0);
});
