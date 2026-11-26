import { readFileSync } from 'node:fs';
import { createBrowserPersistence, createWebPlatform } from '@playbridge/web';
import { afterEach, expect, test, vi } from 'vitest';
import { createRebornFacebookPlatform, type FacebookHostSDK, loadFacebookSDK } from './facebook';
import type { AdRequestOptions } from './monetization';
import { AD_HISTORY_KEY } from './monetizationHistory';
import { startGame } from './startup';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const storage = { getItem: () => null, setItem: () => {} };
const persistence = createBrowserPersistence(storage);

function mockSDK() {
  return {
    initializeAsync: vi.fn(async () => {}),
    setLoadingProgress: vi.fn(),
    startGameAsync: vi.fn(async () => {}),
    onPause: vi.fn(),
    logEvent: vi.fn(),
    player: { getDataAsync: vi.fn(), setDataAsync: vi.fn(), flushDataAsync: vi.fn() },
  } satisfies FacebookHostSDK;
}

const adRequest: AdRequestOptions = {
  isCurrent: () => true, canShow: () => true, onAttempt() {}, onRecovery() {},
};

test('forwards consented analytics only when the Facebook host provides logEvent', async () => {
  const logEvent = vi.fn(function (this: FacebookHostSDK, _name: string) { expect(this).toBe(host); });
  const host = { ...mockSDK(), logEvent };
  const { services } = createRebornFacebookPlatform(async () => host, '', persistence);
  await startGame(services, async () => {});
  const details = { value: 7, properties: { mode: 'classic', combo: 2 } };
  expect(services.capabilities().analytics).toBe('available');
  expect(services.analytics.track('test_event', details).status).toBe('unavailable');
  expect(logEvent).not.toHaveBeenCalled();
  services.analytics.setConsent(true);
  expect(services.analytics.track('test_event').status).toBe('completed');
  expect(services.analytics.track('test_event', details).status).toBe('completed');
  expect(logEvent.mock.calls).toEqual([
    ['test_event'],
    ['test_event', 7, { mode: 'classic', combo: '2' }],
  ]);

  const unsupported = createRebornFacebookPlatform(async () => ({ ...mockSDK(), logEvent: undefined }), '', persistence).services;
  await startGame(unsupported, async () => {});
  unsupported.analytics.setConsent(true);
  expect(unsupported.capabilities().analytics).toBe('unsupported');
  expect(unsupported.analytics.track('test_event').status).toBe('unsupported');
});

test('only prepares a configured rewarded ad after opt-in and preserves SDK bindings', async () => {
  const loadAsync = vi.fn(async () => {});
  const showAsync = vi.fn(async () => {});
  const host = {
    ...mockSDK(),
    getRewardedVideoAsync: vi.fn(async function (this: FacebookHostSDK, placement: string) {
      expect(this).toBe(host);
      expect(placement).toBe('test-placement');
      return { loadAsync, showAsync };
    }),
  };
  const { services, monetization } = createRebornFacebookPlatform(async () => host, '', persistence,
    { placements: { joker: ' test-placement ' } });
  expect(monetization.available('joker')).toBe(false);
  await startGame(services, async () => {});
  expect(services.capabilities().rewardedAds).toBe('available');
  expect(monetization.available('joker')).toBe(true);
  expect(loadAsync).not.toHaveBeenCalled();
  await expect(monetization.request('joker', { ...adRequest, isCurrent: () => false }))
    .resolves.toEqual({ status: 'failed', attempted: false });
  expect(showAsync).not.toHaveBeenCalled();
  await expect(services.ads.request({ kind: 'rewarded', placement: 'joker' }))
    .resolves.toEqual({ status: 'completed', attempted: true });
  expect(host.getRewardedVideoAsync).toHaveBeenCalledOnce();
  expect(loadAsync).toHaveBeenCalledOnce();
  expect(showAsync).toHaveBeenCalledOnce();

  const unconfigured = createRebornFacebookPlatform(async () => host, '', persistence).services;
  await startGame(unconfigured, async () => {});
  expect(unconfigured.capabilities().rewardedAds).toBe('unavailable');
  await expect(unconfigured.ads.request({ kind: 'rewarded', placement: 'joker' }))
    .resolves.toEqual({ status: 'unavailable', attempted: false });
});

test('restores the configured SKU and leaves rewards available when checkout has no automatic placement', async () => {
  const sku = 'reborn_test_remove_ads';
  const receipt = { productID: sku, purchaseToken: 'fixture-token' };
  const payments = {
    onReady: vi.fn(function (ready: () => void) { ready(); }),
    getPurchasesAsync: vi.fn<() => Promise<unknown>>(async () => []),
    getCatalogAsync: vi.fn(async () => [{ productID: sku, price: '2,99 €' }]),
    purchaseAsync: vi.fn(async () => receipt),
    consumePurchaseAsync: vi.fn(),
  };
  payments.getPurchasesAsync.mockImplementationOnce(async function (this: typeof payments) {
    expect(this).toBe(payments);
    return [receipt];
  });
  const getInterstitialAdAsync = vi.fn();
  const showAsync = vi.fn(async () => {});
  const host = {
    ...mockSDK(), payments, getInterstitialAdAsync,
    getRewardedVideoAsync: async () => ({ loadAsync: async () => {}, showAsync }),
  };
  const { services, removeAds, monetization } = createRebornFacebookPlatform(async () => host, '', persistence,
    { placements: { joker: 'booster' }, removeAdsSku: sku });
  await startGame(services, async () => {});
  expect(services.capabilities().purchases).toBe('available');
  expect(services.capabilities().interstitialAds).toBe('unavailable');
  expect(services).not.toHaveProperty('purchases');

  await removeAds.refresh();
  expect(removeAds.ownership).toBe('active');
  await expect(monetization.request('joker', adRequest))
    .resolves.toEqual({ status: 'completed', attempted: true });
  expect(showAsync).toHaveBeenCalledOnce();

  await removeAds.refresh();
  expect(removeAds.ownership).toBe('inactive');
  expect(removeAds.view.state).toBe('unavailable');
  await removeAds.buy(() => true);
  expect(payments.getPurchasesAsync).toHaveBeenCalledTimes(2);
  expect(payments.getCatalogAsync).not.toHaveBeenCalled();
  expect(payments.purchaseAsync).not.toHaveBeenCalled();
  expect(payments.consumePurchaseAsync).not.toHaveBeenCalled();
  expect(getInterstitialAdAsync).not.toHaveBeenCalled();
});

test.each([undefined, [], ['foo'], ['getRewardedVideoAsync', 1], 'getRewardedVideoAsync', new Error('probe failed')])(
  'starts with no ad capabilities after an explicit unsupported or malformed probe (%j)', async probeResult => {
    const host = {
      ...mockSDK(),
      getSupportedAPIs: vi.fn(() => {
        if (probeResult instanceof Error) throw probeResult;
        return probeResult;
      }),
      getInterstitialAdAsync: vi.fn(), getRewardedVideoAsync: vi.fn(),
    };
    const { services, monetization } = createRebornFacebookPlatform(async () => host, '', persistence,
      { placements: { 'play-again': 'auto', 'extra-chance': 'reward' } });
    await startGame(services, async () => expect(host.getSupportedAPIs).not.toHaveBeenCalled());
    expect(services.capabilities().interstitialAds).toBe('unsupported');
    expect(monetization.available('extra-chance')).toBe(false);
    expect(host.getRewardedVideoAsync).not.toHaveBeenCalled();
    expect(host.getInterstitialAdAsync).not.toHaveBeenCalled();
  },
);

test('a support list cannot enable an absent or throwing advertising method', async () => {
  const host = {
    ...mockSDK(),
    getSupportedAPIs: () => ['getRewardedVideoAsync', 'getInterstitialAdAsync'],
    get getRewardedVideoAsync(): never { throw new Error('Host getter unavailable'); },
    payments: {
      get onReady(): never { throw new Error('Payments getter unavailable'); },
      async getPurchasesAsync() { return []; },
    },
  };
  const { services, monetization } = createRebornFacebookPlatform(async () => host, '', persistence,
    { placements: { 'play-again': 'auto', joker: 'reward' } });
  await startGame(services, async () => {});
  expect(monetization.available('joker')).toBe(false);
  expect(services.capabilities().interstitialAds).toBe('unsupported');
  expect(services.capabilities().rewardedAds).toBe('unsupported');
  expect(services.capabilities().purchases).toBe('unsupported');
});

const facebookConfig = readFileSync(new URL('../../.env.facebook', import.meta.url), 'utf8');

function useConfiguration(key: string, exactValue: string): string {
  const line = facebookConfig.split(/\r?\n/).find(line => line.startsWith(`${key}=`));
  expect(line).toBe(`${key}=${exactValue}`);
  return line!.slice(key.length + 1);
}

test('maps all four Meta placements, restores ownership and keeps at most three native instances', async () => {
  vi.useFakeTimers();
  const ids = {
    'play-again': useConfiguration('VITE_DONUTS_PLAY_AGAIN_INTERSTITIAL_PLACEMENT', '1069785026073546_1070008109384571'),
    joker: useConfiguration('VITE_DONUTS_JOKER_REWARDED_PLACEMENT', '1069785026073546_1070008876051161'),
    sweep: useConfiguration('VITE_DONUTS_SWEEP_REWARDED_PLACEMENT', '1069785026073546_1070009126051136'),
    'extra-chance': useConfiguration('VITE_DONUTS_EXTRA_CHANCE_REWARDED_PLACEMENT', '1069785026073546_1070009409384441'),
  };
  const sku = useConfiguration('VITE_DONUTS_REMOVE_ADS_SKU', 'remove_interstitials_forever');
  const receipt = { productID: sku, purchaseToken: 'fixture-receipt', isConsumed: false };
  const history = new Map<string, string>();
  const readInventory = vi.fn<() => Promise<unknown>>(async () => []);
  const checkout = vi.fn(async () => { readInventory.mockResolvedValue([receipt]); return receipt; });
  const shows: string[] = [];
  const order: string[] = [];
  const held = new Set<string>();
  let safe = true;
  let loseFocusOnLoad = false;
  function getAd(id: string) {
    expect(held.has(id)).toBe(false);
    held.add(id);
    expect(held.size).toBeLessThanOrEqual(3);
    order.push(`get:${id}`);
    return {
      async loadAsync() {
        order.push(`load:${id}`);
        if (loseFocusOnLoad) safe = false;
      },
      async showAsync() {
        order.push(`show:${id}`);
        shows.push(id);
        held.delete(id);
      },
    };
  }
  const host = {
    ...mockSDK(),
    getSupportedAPIs: vi.fn(() => ['FBInstant.getInterstitialAdAsync', 'getRewardedVideoAsync']),
    getInterstitialAdAsync: vi.fn(async function (this: FacebookHostSDK, id: string) {
      expect(this).toBe(host);
      expect(host.startGameAsync).toHaveBeenCalled();
      return getAd(id);
    }),
    getRewardedVideoAsync: vi.fn(async function (this: FacebookHostSDK, id: string) {
      expect(this).toBe(host);
      return getAd(id);
    }),
    payments: {
      onReady(ready: () => void) { ready(); },
      getPurchasesAsync: readInventory,
      getCatalogAsync: async () => [{ productID: sku, price: '2,99 €' }],
      purchaseAsync: checkout,
      consumePurchaseAsync: vi.fn(),
    },
    player: { ...mockSDK().player, getID: () => 'account' },
  };
  const options = {
    placements: ids,
    removeAdsSku: sku,
    getHistoryStorage: () => ({ getItem: (key: string) => history.get(key) ?? null,
      setItem: (key: string, value: string) => { history.set(key, value); } }),
    isForeground: () => safe,
  };
  const launch = async () => {
    const game = createRebornFacebookPlatform(async () => host, '', persistence, options);
    await startGame(game.services, async () => {});
    await game.removeAds.refresh();
    await vi.advanceTimersByTimeAsync(0);
    return game;
  };
  const first = await launch();
  expect(history.has(`${AD_HISTORY_KEY}.account`)).toBe(true);
  expect(held.size).toBe(0);
  first.monetization.destroy();
  await vi.advanceTimersByTimeAsync(30 * 60_000);

  const { monetization, removeAds } = await launch();
  expect(held).toEqual(new Set([ids['play-again']]));
  expect(removeAds.view).toMatchObject({ state: 'available', price: '2,99 €' });
  loseFocusOnLoad = true;
  for (const placement of ['joker', 'sweep'] as const) {
    safe = true;
    await expect(monetization.request(placement, adRequest)).resolves.toEqual({ status: 'failed', attempted: false });
  }
  loseFocusOnLoad = false;
  safe = true;
  expect(held.size).toBe(3);
  await expect(monetization.request('extra-chance', adRequest)).resolves.toEqual({ status: 'unavailable', attempted: false });
  expect(host.getRewardedVideoAsync.mock.calls).toEqual([[ids.joker], [ids.sweep]]);
  await expect(monetization.request('joker', adRequest)).resolves.toEqual({ status: 'completed', attempted: true });
  await expect(monetization.request('extra-chance', adRequest)).resolves.toEqual({ status: 'completed', attempted: true });
  await expect(monetization.request('sweep', adRequest)).resolves.toEqual({ status: 'completed', attempted: true });
  expect(host.getRewardedVideoAsync.mock.calls).toEqual([[ids.joker], [ids.sweep], [ids['extra-chance']]]);

  monetization.setPlaying(true);
  await vi.advanceTimersByTimeAsync(180_000);
  monetization.setPlaying(false);
  monetization.runCompleted();
  expect((await monetization.request('play-again', adRequest)).attempted).toBe(false);
  monetization.runCompleted();
  await expect(monetization.request('play-again', { ...adRequest, onAttempt: () => order.push('attempt') }))
    .resolves.toEqual({ status: 'completed', attempted: true });
  const interstitial = ids['play-again'];
  expect(order.slice(0, 2)).toEqual([`get:${interstitial}`, `load:${interstitial}`]);
  expect(order.indexOf('attempt')).toBe(order.indexOf(`show:${interstitial}`) - 1);
  expect(shows).toEqual([ids.joker, ids['extra-chance'], ids.sweep, interstitial]);

  safe = false;
  await removeAds.buy(() => true);
  expect(checkout).not.toHaveBeenCalled();
  safe = true;
  await removeAds.buy(() => true);
  expect(checkout).toHaveBeenCalledExactlyOnceWith({ productID: sku });
  expect(removeAds.ownership).toBe('active');
  expect(monetization.available('play-again')).toBe(false);
  expect(monetization.available('extra-chance')).toBe(true);
  expect(host.payments.consumePurchaseAsync).not.toHaveBeenCalled();
  monetization.destroy();
  const reopened = await launch();
  expect(reopened.removeAds.ownership).toBe('active');
  expect(reopened.monetization.available('play-again')).toBe(false);
});

test('counts an SDK instance that outlives preload timeout and reuses it without late playback', async () => {
  vi.useFakeTimers();
  let completeLoad!: () => void;
  const loadAsync = vi.fn(() => new Promise<void>(resolve => { completeLoad = resolve; }));
  const showAsync = vi.fn(async () => {});
  const host = { ...mockSDK(), getRewardedVideoAsync: vi.fn(async () => ({ loadAsync, showAsync })) };
  const { services, monetization } = createRebornFacebookPlatform(async () => host, '', persistence,
    { placements: { joker: 'reward' } });
  await startGame(services, async () => {});
  const timedOut = monetization.request('joker', adRequest);
  await vi.advanceTimersByTimeAsync(0);
  await expect(monetization.request('joker', adRequest)).resolves.toEqual({ status: 'pending', attempted: false });
  await vi.advanceTimersByTimeAsync(5_000);
  await expect(timedOut).resolves.toEqual({ status: 'unavailable', attempted: false });
  completeLoad();
  await vi.advanceTimersByTimeAsync(30_000);
  expect(showAsync).not.toHaveBeenCalled();
  await expect(monetization.request('joker', adRequest)).resolves.toEqual({ status: 'completed', attempted: true });
  expect(host.getRewardedVideoAsync).toHaveBeenCalledExactlyOnceWith('reward');
  expect(loadAsync).toHaveBeenCalledOnce();
  expect(showAsync).toHaveBeenCalledOnce();
});

test('returning launch waits for authoritative inactive inventory before interstitial preparation', async () => {
  vi.useFakeTimers();
  const getPurchasesAsync = vi.fn<() => Promise<unknown>>(async () => null);
  const host = {
    ...mockSDK(),
    getInterstitialAdAsync: vi.fn(async () => ({ loadAsync: async () => {}, showAsync: async () => {} })),
    getRewardedVideoAsync: vi.fn(async () => ({ loadAsync: async () => {}, showAsync: async () => {} })),
    payments: { onReady(ready: () => void) { ready(); }, getPurchasesAsync },
    player: { ...mockSDK().player, getID: () => 'player' },
  };
  const map = new Map<string, string>();
  const getHistoryStorage = () => ({ getItem: (key: string) => map.get(key) ?? null,
    setItem: (key: string, value: string) => { map.set(key, value); } });
  const launch = async () => {
    const game = createRebornFacebookPlatform(async () => host, '', persistence,
      { getHistoryStorage, placements: { 'play-again': 'auto', sweep: 'sweep' }, removeAdsSku: 'sku' });
    await startGame(game.services, async () => {});
    await game.removeAds.refresh();
    return game;
  };
  (await launch()).monetization.destroy();
  await vi.advanceTimersByTimeAsync(30 * 60_000);
  const { removeAds, monetization } = await launch();
  expect(removeAds.ownership).toBe('unknown');
  expect(host.getInterstitialAdAsync).not.toHaveBeenCalled();
  await expect(monetization.request('sweep', adRequest)).resolves.toEqual({ status: 'completed', attempted: true });

  getPurchasesAsync.mockResolvedValueOnce([{ productID: 'sku', purchaseToken: 'receipt' }]);
  await removeAds.refresh();
  expect(removeAds.ownership).toBe('active');
  expect(host.getInterstitialAdAsync).not.toHaveBeenCalled();

  getPurchasesAsync.mockResolvedValueOnce([]);
  await removeAds.refresh();
  expect(removeAds.ownership).toBe('inactive');
  expect(host.getInterstitialAdAsync).toHaveBeenCalledExactlyOnceWith('auto');
  expect(removeAds.view.state).toBe('unavailable');
});

test('starts Facebook only after the first playable frame is ready, with host binding intact', async () => {
  const sdk = mockSDK();
  const hostCalls: (string | number)[] = [];
  sdk.initializeAsync.mockImplementation(async function (this: FacebookHostSDK) {
    expect(this).toBe(sdk);
    await Promise.resolve();
    hostCalls.push('initialized');
  });
  sdk.setLoadingProgress.mockImplementation(function (this: FacebookHostSDK, progress: number) {
    expect(this).toBe(sdk);
    hostCalls.push(progress);
  });
  sdk.startGameAsync.mockImplementation(async function (this: FacebookHostSDK) {
    expect(this).toBe(sdk);
    hostCalls.push('started');
  });
  const { services } = createRebornFacebookPlatform(async () => sdk, '', persistence);

  await startGame(services, async () => {
    expect(hostCalls).toEqual(['initialized', 0]);
    await Promise.resolve();
    hostCalls.push('rendered');
  });

  expect(hostCalls).toEqual(['initialized', 0, 'rendered', 100, 'started']);
  expect(sdk.onPause).toHaveBeenCalledOnce();
});

test('waits for the SDK script to finish loading', async () => {
  let sdk: FacebookHostSDK | undefined;
  const host = mockSDK();
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const script = new EventTarget();
  const getElementById = vi.fn(() => script);
  vi.stubGlobal('document', { getElementById });
  const { services } = createRebornFacebookPlatform(() => loadFacebookSDK(() => sdk), '', persistence);

  const startup = startGame(services, async () => {});
  expect(getElementById).toHaveBeenCalledWith('facebook-sdk');
  expect(host.initializeAsync).not.toHaveBeenCalled();

  sdk = host;
  script.dispatchEvent(new Event('load'));
  await startup;

  expect(host.startGameAsync).toHaveBeenCalledOnce();
});

test('surfaces SDK download errors before game preparation', async () => {
  vi.stubGlobal('window', { setTimeout, clearTimeout });
  const script = new EventTarget();
  vi.stubGlobal('document', { getElementById: () => script });
  const prepare = vi.fn();
  const { services } = createRebornFacebookPlatform(() => loadFacebookSDK(() => undefined), '', persistence);

  const startup = startGame(services, prepare);
  script.dispatchEvent(new Event('error'));

  await expect(startup).rejects.toThrow('Facebook SDK download failed.');
  expect(prepare).not.toHaveBeenCalled();
});

test('leaves startup incomplete when preparing the game fails', async () => {
  const sdk = mockSDK();
  const error = new Error('Legacy textures failed to load');
  const { services } = createRebornFacebookPlatform(async () => sdk, '', persistence);

  await expect(startGame(services, async () => { throw error; })).rejects.toBe(error);
  expect(sdk.setLoadingProgress.mock.calls).toEqual([[0]]);
  expect(sdk.startGameAsync).not.toHaveBeenCalled();
});

test('surfaces SDK initialize and start failures at their corresponding stages', async () => {
  const sdk = mockSDK();
  const error = new Error('Host failure');
  const prepare = vi.fn(async () => {});
  const { services } = createRebornFacebookPlatform(async () => sdk, '', persistence);
  sdk.initializeAsync.mockRejectedValueOnce(error);
  await expect(startGame(services, prepare)).rejects.toBe(error);
  expect(sdk.setLoadingProgress).not.toHaveBeenCalled();
  expect(prepare).not.toHaveBeenCalled();

  sdk.startGameAsync.mockRejectedValueOnce(error);
  await expect(startGame(services, prepare)).rejects.toBe(error);
  expect(sdk.setLoadingProgress.mock.calls).toEqual([[0], [100]]);
  expect(prepare).toHaveBeenCalledOnce();
});

test('prepares the web game with no SDK', async () => {
  vi.stubGlobal('window', undefined);
  const prepareGame = vi.fn(async () => {});
  await startGame(createWebPlatform(storage), prepareGame);
  expect(prepareGame).toHaveBeenCalledOnce();
});
