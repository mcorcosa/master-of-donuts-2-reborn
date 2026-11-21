import { describe, expect, it } from 'vitest';
import { FrameQuality } from './frameQuality';
import { QualityPreference } from './qualityPreference';

function feed(quality: FrameQuality) {
  let time = 0;
  quality.sample(time);
  return {
    frames(count: number, interval: number) {
      for (let i = 0; i < count; i++) quality.sample(time += interval);
    },
    pause(gap: number) {
      quality.pause();
      quality.sample(time += gap);
    },
  };
}

describe('adaptive frame quality', () => {
  it('requires strictly more than 10% slow frames in each of two consecutive windows', () => {
    const quality = new FrameQuality(3);
    const clock = feed(quality);
    for (let window = 0; window < 2; window++) {
      clock.frames(20, 29);
      clock.frames(180, 19);
    }
    expect(quality.applyPending()).toBeUndefined();

    clock.frames(160, 25);
    expect(quality.applyPending()).toBeUndefined();
    clock.frames(250, 16);
    clock.frames(160, 25);
    expect(quality.applyPending()).toBeUndefined();
    clock.frames(160, 25);
    expect(quality.resolution).toBe(2);
    expect(quality.applyPending()).toBe(1.5);
    expect(quality.resolution).toBe(1.5);
    clock.frames(160, 25);
    expect(quality.applyPending()).toBeUndefined();
    clock.frames(161, 25);
    expect(quality.applyPending()).toBe(1);
  });

  it('accumulates active time across short idle pauses and skips ineffective tiers', () => {
    const quality = new FrameQuality(1.5);
    const clock = feed(quality);
    for (let burst = 0; burst < 16; burst++) {
      clock.frames(20, 25);
      clock.pause(400);
    }
    expect(quality.resolution).toBe(1.5);
    expect(quality.applyPending()).toBe(1);
    expect(new FrameQuality(0.8).resolution).toBe(0.8);
  });

  it('discards stale bursts, lone hitches and timing across suspensions', () => {
    const quality = new FrameQuality(2);
    const clock = feed(quality);
    clock.frames(160, 25);
    clock.pause(1500);
    clock.frames(160, 25);
    expect(quality.applyPending()).toBeUndefined();
    clock.frames(1, 800);
    clock.frames(160, 25);
    expect(quality.applyPending()).toBeUndefined();
    quality.interrupt();
    clock.frames(161, 25);
    expect(quality.applyPending()).toBeUndefined();
    clock.frames(160, 25);
    quality.interrupt();
    expect(quality.applyPending()).toBe(1.5);
  });

  it('re-evaluates the native cap and drops an unapplied decision from the previous display', () => {
    const quality = new FrameQuality(2);
    feed(quality).frames(320, 25);
    quality.setNativeDpr(1.25);
    expect(quality.applyPending()).toBeUndefined();
    expect(quality.resolution).toBe(1.25);
    feed(quality).frames(320, 25);
    expect(quality.applyPending()).toBe(1);
    quality.setNativeDpr(3);
    expect(quality.resolution).toBe(1);
  });
});

describe('local quality preference', () => {
  it('validates age and display and uses only its injected key', () => {
    let now = 1000;
    const values = new Map([['account-save', 'untouched']]);
    const preference = new QualityPreference('quality.v1', () => ({
      getItem: key => values.get(key) ?? null,
      setItem: (key, value) => { values.set(key, value); },
    }), () => now);
    expect(preference.read(3)).toBe(2);
    preference.write(3, 1.5);
    expect(preference.read(3)).toBe(1.5);
    expect(preference.read(2)).toBe(2);
    expect(values.get('account-save')).toBe('untouched');
    now += 14 * 24 * 60 * 60 * 1000;
    expect(preference.read(3)).toBe(2);
    values.set('quality.v1', '{');
    expect(preference.read(3)).toBe(2);
  });

  it('handles unavailable storage on read and write', () => {
    const blocked = new QualityPreference('quality.v1', () => { throw new Error('denied'); }, () => 0);
    expect(blocked.read(3)).toBe(2);
    expect(() => blocked.write(3, 1)).not.toThrow();
  });
});
