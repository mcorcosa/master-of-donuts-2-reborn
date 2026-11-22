import { describe, expect, it } from 'vitest';
import { RunBoosters } from './boosters';

describe('run boosters', () => {
  it('starts on the first move and counts foreground time toward the next offer', () => {
    const run = new RunBoosters();
    run.setActive(true, 0);
    expect(run.progress(90_000)).toBe(0);
    expect(run.nextRefresh(90_000)).toBe(0);

    run.start();
    run.setActive(true, 90_000);
    expect(run.nextRefresh(90_000)).toBe(90_250);
    run.setActive(false, 105_000);
    expect(run.progress(200_000)).toBe(1 / 3);
    expect(run.nextRefresh(200_000)).toBe(0);
    run.setActive(true, 200_000);
    expect(run.canClaim('sweep', 229_999)).toBe(false);
    expect(run.nextRefresh(229_999)).toBe(230_000);
    expect(run.canClaim('sweep', 230_000)).toBe(true);
    expect(run.canClaim('joker', 500_000)).toBe(true);
    expect(run.nextRefresh(500_000)).toBe(0);
  });

  it('shares the exact claim intervals and caps completed reward ads at three', () => {
    const run = new RunBoosters();
    run.start();
    run.setActive(true, 0);
    expect(run.beginClaim('joker', 45_000)).toBe(true);
    expect(run.beginClaim('sweep', 45_000)).toBe(false);
    expect(run.source('joker')).toBeUndefined();
    run.finishClaim(false);
    run.setActive(true, 65_000);
    expect(run.beginClaim('joker', 65_000)).toBe(true);
    run.finishClaim(true);
    run.setActive(true, 100_000);
    expect(run.source('joker')).toBe('ad');
    expect(run.beginClaim('sweep', 174_999)).toBe(false);
    expect(run.beginClaim('joker', 175_000)).toBe(false);
    expect(run.beginClaim('sweep', 175_000)).toBe(true);
    run.finishClaim(true);
    expect(run.spend('joker')).toBe(true);
    run.setActive(true, 180_000);
    expect(run.beginClaim('joker', 284_999)).toBe(false);
    expect(run.beginClaim('joker', 285_000)).toBe(true);
    run.finishClaim(true);
    run.setActive(true, 300_000);
    expect(run.spend('sweep')).toBe(true);
    expect(run.hasOffersLeft).toBe(false);
    expect(run.beginClaim('sweep', 1_000_000)).toBe(false);
    expect(run.nextRefresh(1_000_000)).toBe(0);
  });

  it('uses a separate one-drop budget at combo five with a fallback for occupied slots', () => {
    const run = new RunBoosters();
    run.start();
    run.setActive(true, 0);
    expect(run.grantComboDrop(4, 'joker')).toBeUndefined();
    expect(run.source('joker')).toBeUndefined();
    expect(run.beginClaim('joker', 45_000)).toBe(true);
    run.finishClaim(true);
    expect(run.grantComboDrop(5, 'joker')).toBe('sweep');
    expect(run.source('joker')).toBe('ad');
    expect(run.source('sweep')).toBe('free');
    expect(run.spend('sweep')).toBe(true);
    expect(run.spend('sweep')).toBe(false);
    expect(run.grantComboDrop(5, 'sweep')).toBeUndefined();
    expect(run.source('sweep')).toBeUndefined();

    const replay = new RunBoosters();
    expect(replay.source('joker')).toBeUndefined();
    expect(replay.progress(999_000)).toBe(0);
    expect(replay.grantComboDrop(5, 'joker')).toBe('joker');
    expect(replay.source('joker')).toBe('free');
    expect(replay.hasOffersLeft).toBe(true);
  });

  it('reports no award with both slots full and does not grant at combo six', () => {
    const run = new RunBoosters();
    run.start();
    run.setActive(true, 0);
    expect(run.beginClaim('joker', 45_000)).toBe(true);
    run.finishClaim(true);
    run.setActive(true, 45_000);
    expect(run.beginClaim('sweep', 120_000)).toBe(true);
    run.finishClaim(true);

    expect(run.grantComboDrop(5, 'joker')).toBeUndefined();
    expect(run.spend('joker')).toBe(true);
    expect(run.grantComboDrop(6, 'joker')).toBeUndefined();
    expect(run.source('joker')).toBeUndefined();
    expect(run.grantComboDrop(5, 'joker')).toBe('joker');
  });
});
