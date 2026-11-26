import { Bounds, Sprite, Text, Texture } from 'pixi.js';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FreeBoosterCelebration, FREE_BOOSTER_FLIGHT_MS, FREE_BOOSTER_HOLD_MS, FREE_BOOSTER_LANDING_MS,
} from './freeBoosterCelebration';

beforeEach(() => {
  vi.spyOn(Text.prototype, 'getLocalBounds').mockImplementation(function (this: Text) {
    const width = this.text.length * this.style.fontSize * 0.62;
    return new Bounds(-width / 2, -this.style.fontSize / 2, width / 2, this.style.fontSize / 2);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('free booster celebration', () => {
  it.each([
    ['joker', 'FREE JOKER', 40],
    ['sweep', 'FREE GOLDEN GUST', 98],
  ] as const)('holds the %s title, flies to its center, and pulses only the award', (kind, title, x) => {
    const celebration = new FreeBoosterCelebration();
    const target = { x, y: 517, size: 50, texture: Texture.WHITE };
    celebration.start(kind, target, 0, false);
    expect(celebration.animating).toBe(true);
    const { root } = celebration;
    const coin = root.getChildByLabel('awarded medallion') as Sprite;
    const banner = root.getChildByLabel('free booster banner')!;
    expect((banner.getChildByLabel('free booster combo') as Text).text).toBe('5× COMBO');
    expect((banner.getChildByLabel('free booster title') as Text).text).toBe(title);
    expect(coin.texture).toBe(target.texture);

    celebration.show(180);
    expect(root.getChildByLabel('gold sugar stars')?.visible).toBe(true);
    expect(celebration.show(FREE_BOOSTER_HOLD_MS - 1)).toBeNull();
    const { x: startX, y: startY } = coin.position;
    expect(banner.alpha).toBe(1);
    const flightEnd = FREE_BOOSTER_HOLD_MS + FREE_BOOSTER_FLIGHT_MS;
    celebration.show(FREE_BOOSTER_HOLD_MS + FREE_BOOSTER_FLIGHT_MS / 2);
    expect(banner.visible).toBe(false);
    expect(coin.x).toBeLessThan(startX / 4);
    expect(coin.y).toBeGreaterThan(startY);
    celebration.show(flightEnd - 0.01);
    expect(coin.x).toBeCloseTo(target.x, 1);
    expect(coin.y).toBeCloseTo(target.y, 1);
    expect(coin.width).toBeCloseTo(target.size, 1);

    expect(celebration.show(flightEnd)).toEqual({ kind, glow: 1, scale: 1 });
    expect(coin.visible).toBe(false);
    const peak = celebration.show(flightEnd + FREE_BOOSTER_LANDING_MS / 2);
    expect(peak).toMatchObject({ kind, glow: 0.5 });
    expect(peak?.scale).toBeCloseTo(1.14);
    expect(celebration.show(celebration.deadline)).toBeNull();
    expect(celebration.root.visible).toBe(false);
  });

  it('keeps the artwork and award highlight stationary for the entire reduced-motion hold', () => {
    const celebration = new FreeBoosterCelebration();
    celebration.start('sweep', { x: 98, y: 517, size: 50, texture: Texture.WHITE }, 0, true);
    const coin = celebration.root.getChildByLabel('awarded medallion') as Sprite;
    const highlight = celebration.show(0);
    const artwork = [coin.x, coin.y, coin.width, coin.rotation];
    expect(celebration.animating).toBe(false);
    expect(celebration.root.getChildByLabel('gold sugar stars')?.visible).toBe(false);
    expect(highlight).toEqual({ kind: 'sweep', glow: 0.95, scale: 1 });
    expect(celebration.show(649)).toEqual(highlight);
    expect([coin.x, coin.y, coin.width, coin.rotation]).toEqual(artwork);
    expect(celebration.cancel('joker')).toBe(false);
    expect(celebration.show(650)).toBeNull();
    expect(celebration.root.visible).toBe(false);
  });
});
