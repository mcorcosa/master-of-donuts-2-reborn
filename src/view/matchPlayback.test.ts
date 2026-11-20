import { Bounds, Container, Sprite, Text, Texture } from 'pixi.js';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MatchEffect } from './matchEffect';
import { awardFrame, type MatchPlayback, matchFrame, scoreAccents, scoreSize } from './matchPlayback';

const playback: MatchPlayback = {
  from: 0, to: 1, color: 'red', points: 110, started: 0, reduced: false, arrivalMs: 220, clearMs: 320,
};

afterEach(() => vi.restoreAllMocks());

describe('match presentation', () => {
  it('lands one sprite, fans out all three with the +110 award, then hides the cleared sprites', () => {
    vi.spyOn(Text.prototype, 'getLocalBounds').mockReturnValue(new Bounds(-34, -18, 34, 18));
    const effect = new MatchEffect(Texture.EMPTY);
    const [donuts, award] = effect.root.children as Container[];
    const sprites = donuts.children.filter((child): child is Sprite => child instanceof Sprite);
    const visible = () => sprites.filter(sprite => sprite.visible);
    const geometry = { start: { x: 70, y: 310 }, landing: { x: 200, y: 280 }, width: 100, height: 75, step: 24, viewHeight: 700 };
    effect.start(playback, geometry, Texture.WHITE);

    effect.showPieces(matchFrame(playback, 110));
    effect.showAward(110);
    expect(visible()).toHaveLength(1);
    expect(visible()[0].x).toBeGreaterThan(geometry.start.x);
    expect(award.visible).toBe(false);

    effect.showPieces(matchFrame(playback, 220));
    expect(visible()).toHaveLength(3);
    expect(visible().at(-1)?.position).toMatchObject(geometry.landing);
    effect.showPieces(matchFrame(playback, 340));
    effect.showAward(340);
    expect(visible().every(piece => piece.texture === Texture.WHITE)).toBe(true);
    expect(new Set(visible().map(piece => piece.x)).size).toBe(3);
    expect(award.visible).toBe(true);
    expect(award.children.filter(child => child instanceof Text).map(text => text.text)).toEqual(['+110', '+110']);

    effect.showPieces(matchFrame(playback, 540));
    effect.showAward(540);
    expect(donuts.visible).toBe(false);
    expect(award.visible).toBe(true);
    effect.showAward(670);
    expect(award.visible).toBe(false);
    effect.root.destroy({ children: true });
  });

  it('uses the reference emphasis, asymmetric settlement, float, fade and accent thresholds', () => {
    const high = { ...playback, points: 2500 };
    const at = (age: number) => awardFrame(high, 220 + age)!;
    expect(scoreSize(110)).toBe(24);
    expect(scoreSize(2500)).toBe(44);
    expect(scoreAccents({ ...high, points: 999 })).toBe(0);
    expect(scoreAccents({ ...high, points: 1000 })).toBe(4);
    expect(scoreAccents(high)).toBe(6);
    expect(at(70)).toMatchObject({ scaleX: 1.3, scaleY: expect.closeTo(1.4), lift: 0, alpha: 1 });
    expect(at(120)).toMatchObject({ scaleX: 0.92, scaleY: 1.04 });
    expect(at(180)).toMatchObject({ scaleX: 1, scaleY: 1, rotation: 0 });
    expect(at(500).lift).toBeGreaterThan(at(180).lift);
    expect(at(550).alpha).toBeLessThan(at(500).alpha);
    expect(awardFrame(high, 820)).toBeNull();
  });

  it('suppresses score motion and accents and starts the reduced clear without flight', () => {
    const reduced = { ...playback, points: 2500, reduced: true, arrivalMs: 0, clearMs: 230 };
    expect(matchFrame(reduced, 0)).toEqual({ phase: 'clear', progress: 0 });
    expect(scoreAccents(reduced)).toBe(0);
    expect(awardFrame(reduced, 25)).toMatchObject({ alpha: 0.5, scaleX: 1, scaleY: 1, rotation: 0, lift: 0 });
    expect(awardFrame(reduced, 180)).toMatchObject({ alpha: 1, scaleX: 1, scaleY: 1, rotation: 0, lift: 0 });
    expect(matchFrame(reduced, 230).phase).toBe('resolved');
  });
});
