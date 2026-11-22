import type { AdOutcome, AdRequest } from '@playbridge/core';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';
import { type AdRequestOptions, Monetization } from './monetization';
import { AD_GAP_MS, AD_HISTORY_KEY, MonetizationHistory } from './monetizationHistory';

const VISIT_IDLE_MS = 30 * 60_000;
const HISTORY_KEY = `${AD_HISTORY_KEY}.player`;

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function fixture() {
  let writer = 0;
  let foreground = true;
  let owned = false;
  let checkout = false;
  let ready = true;
  const records = new Map<string, string>();
  const storage = {
    getItem: vi.fn((key: string) => records.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { records.set(key, value); }),
  };
  const prepared = vi.fn(() => ready);
  const sdk = vi.fn(async (request: AdRequest): Promise<AdOutcome> => {
    if (request.isCurrent?.() === false) return { status: 'failed', attempted: false };
    request.onAttempt?.();
    return { status: 'completed', attempted: true };
  });
  function launch(identity = 'player') {
    const controller = new Monetization({
      history: new MonetizationHistory(() => storage, () => Date.now(), () => `${++writer}`),
      supported: () => true,
      interstitialAllowed: () => !owned,
      checkoutActive: () => checkout,
      isForeground: () => foreground,
      interstitialReady: prepared,
      requestAd: sdk,
    });
    controller.start(identity);
    return controller;
  }
  return {
    launch,
    async returning() {
      launch().destroy();
      await vi.advanceTimersByTimeAsync(VISIT_IDLE_MS);
      return launch();
    },
    foreground(value: boolean) { foreground = value; },
    owned(value: boolean) { owned = value; },
    checkout(value: boolean) { checkout = value; },
    ready(value: boolean) { ready = value; },
    storage, records, prepared, sdk,
  };
}

function requestOptions(): AdRequestOptions {
  return { isCurrent: vi.fn(() => true), canShow: vi.fn(() => true), onAttempt: vi.fn(), onRecovery: vi.fn() };
}

async function play(game: Monetization, elapsed = AD_GAP_MS): Promise<void> {
  game.setPlaying(true);
  await vi.advanceTimersByTimeAsync(elapsed);
  game.setPlaying(false);
}

test('protects the first visit through restarts, reloads and an idle resume in the same document', async () => {
  const f = fixture();
  const first = f.launch();
  await play(first);
  first.runCompleted();
  first.runCompleted();
  expect((await first.request('play-again', requestOptions())).attempted).toBe(false);
  first.destroy();
  await vi.advanceTimersByTimeAsync(VISIT_IDLE_MS - 1);

  const sameVisit = f.launch();
  await play(sameVisit);
  await vi.advanceTimersByTimeAsync(VISIT_IDLE_MS);
  expect(sameVisit.canPreloadInterstitial).toBe(false);
  sameVisit.destroy();
  const returning = f.launch();
  expect(returning.canPreloadInterstitial).toBe(true);
  returning.runCompleted();
  expect((await returning.request('play-again', requestOptions())).attempted).toBe(false);
  expect(f.sdk).not.toHaveBeenCalled();
});

test('requires two finalized runs and 180 seconds of foreground play, then persists the two-attempt cap', async () => {
  const f = fixture();
  let game = await f.returning();
  game.runCompleted();
  await play(game, AD_GAP_MS - 1);
  expect((await game.request('play-again', requestOptions())).attempted).toBe(false);
  f.foreground(false);
  await play(game, AD_GAP_MS);
  f.foreground(true);
  game.setModalOpen(true);
  await play(game, AD_GAP_MS);
  game.setModalOpen(false);
  await vi.advanceTimersByTimeAsync(AD_GAP_MS);
  game.runCompleted();
  expect((await game.request('play-again', requestOptions())).attempted).toBe(false);

  await play(game, 1);
  game.runCompleted();
  await expect(game.request('play-again', requestOptions())).resolves.toEqual({ status: 'completed', attempted: true });
  expect((await game.request('play-again', requestOptions())).attempted).toBe(false);
  game.destroy();
  game = f.launch();
  await play(game, AD_GAP_MS - 1);
  game.runCompleted();
  expect((await game.request('play-again', requestOptions())).attempted).toBe(false);
  await play(game, 1);
  game.runCompleted();
  f.sdk.mockImplementationOnce(async request => {
    request.onAttempt?.();
    return { status: 'failed', attempted: true };
  });
  await expect(game.request('play-again', requestOptions())).resolves.toEqual({ status: 'failed', attempted: true });
  game.destroy();
  game = f.launch();
  await play(game);
  game.runCompleted();
  expect((await game.request('play-again', requestOptions())).attempted).toBe(false);
  expect(f.sdk).toHaveBeenCalledTimes(2);
});

test('skips an unready Play Again immediately and consumes that single opportunity', async () => {
  const f = fixture();
  const game = await f.returning();
  await play(game);
  f.ready(false);
  game.runCompleted();
  game.runCompleted();
  await expect(game.request('play-again', requestOptions())).resolves.toEqual({ status: 'unavailable', attempted: false });
  expect(f.prepared).toHaveBeenCalled();
  expect(f.sdk).not.toHaveBeenCalled();
  f.ready(true);
  expect((await game.request('play-again', requestOptions())).attempted).toBe(false);
  game.runCompleted();
  expect((await game.request('play-again', requestOptions())).attempted).toBe(true);
});

test('a storage error or conflicting writer prevents automatic exposure while rewards remain usable', async () => {
  const f = fixture();
  const game = await f.returning();
  await play(game);
  game.runCompleted();
  game.runCompleted();
  const durable = f.records.get(HISTORY_KEY);
  f.storage.setItem.mockImplementationOnce(() => { throw new Error('Quota exceeded'); });
  await expect(game.request('play-again', requestOptions())).resolves.toEqual({ status: 'failed', attempted: false });
  expect(f.records.get(HISTORY_KEY)).toBe(durable);
  await expect(game.request('sweep', requestOptions())).resolves.toMatchObject({ status: 'completed', attempted: true });

  const stale = f.launch();
  f.launch();
  stale.runCompleted();
  expect(stale.canPreloadInterstitial).toBe(false);
  f.records.set(HISTORY_KEY, '{"version":99}');
  const invalid = f.launch();
  expect(invalid.canPreloadInterstitial).toBe(false);
  expect(f.records.get(HISTORY_KEY)).toBe('{"version":99}');
  expect(f.launch('other-account').canPreloadInterstitial).toBe(false);
});

test('retains normal rewarded success through SDK blur and rechecks checkout/foreground immediately before show', async () => {
  const f = fixture();
  const game = f.launch();
  const request = requestOptions();
  f.sdk.mockImplementationOnce(async native => {
    await Promise.resolve();
    f.foreground(false);
    expect(native.isCurrent?.()).toBe(false);
    return { status: 'failed', attempted: false };
  });
  await expect(game.request('joker', request)).resolves.toMatchObject({ attempted: false });
  expect(request.onAttempt).not.toHaveBeenCalled();

  f.foreground(true);
  f.sdk.mockImplementationOnce(async native => {
    expect(native.isCurrent?.()).toBe(true);
    native.onAttempt?.();
    f.foreground(false);
    return { status: 'completed', attempted: true };
  });
  await expect(game.request('joker', request)).resolves.toEqual({ status: 'completed', attempted: true });
  expect(request.onAttempt).toHaveBeenCalledOnce();
  f.foreground(true);
  f.checkout(true);
  await expect(game.request('extra-chance', request)).resolves.toEqual({ status: 'pending', attempted: false });
  expect(f.sdk).toHaveBeenCalledTimes(2);
});

test('stalled playback exposes explicit foreground recovery and keeps ads locked until late SDK settlement', async () => {
  const f = fixture();
  const game = await f.returning();
  await play(game);
  game.runCompleted();
  game.runCompleted();
  let settle!: (outcome: AdOutcome) => void;
  f.sdk.mockImplementationOnce(async request => {
    request.onAttempt?.();
    return new Promise(resolve => { settle = resolve; });
  });

  let returnToGame: (() => void) | undefined;
  const request = { ...requestOptions(), onRecovery: vi.fn(resume => { returnToGame = resume; }) } satisfies AdRequestOptions;
  const playback = game.request('joker', request);
  await vi.advanceTimersByTimeAsync(44_999);
  expect(request.onRecovery).not.toHaveBeenCalled();
  f.foreground(false);
  await vi.advanceTimersByTimeAsync(1);
  expect(returnToGame).toBeTypeOf('function');
  returnToGame?.();
  expect(game.adBusy).toBe(true);
  expect(request.onRecovery).toHaveBeenCalledOnce();
  f.foreground(true);
  returnToGame?.();
  await expect(playback).resolves.toEqual({ status: 'failed', attempted: true });
  expect(request.onRecovery).toHaveBeenLastCalledWith();
  await play(game);
  expect(game.adBusy).toBe(true);
  await expect(game.request('extra-chance', requestOptions())).resolves.toEqual({ status: 'pending', attempted: false });
  settle({ status: 'completed', attempted: true });
  await vi.advanceTimersByTimeAsync(0);
  expect(game.adBusy).toBe(false);
  game.runCompleted();
  expect((await game.request('play-again', requestOptions())).attempted).toBe(false);
  await play(game);
  game.runCompleted();
  expect((await game.request('play-again', requestOptions())).attempted).toBe(true);
});

test('a late or stale rewarded completion cannot grant a reward', async () => {
  const f = fixture();
  const game = f.launch();
  let finish!: (outcome: AdOutcome) => void;
  f.sdk.mockImplementation(async native => {
    native.onAttempt?.();
    return new Promise(resolve => { finish = resolve; });
  });
  const late = game.request('sweep', requestOptions());
  await vi.advanceTimersByTimeAsync(45_000);
  finish({ status: 'completed', attempted: true });
  await expect(late).resolves.toEqual({ status: 'failed', attempted: true });

  let current = true;
  const stale = game.request('extra-chance', { ...requestOptions(), isCurrent: () => current });
  current = false;
  finish({ status: 'completed', attempted: true });
  await expect(stale).resolves.toEqual({ status: 'failed', attempted: true });
});
