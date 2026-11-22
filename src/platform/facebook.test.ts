import { createBrowserPersistence, createWebPlatform } from '@playbridge/web';
import { afterEach, expect, test, vi } from 'vitest';
import { BOOSTER_REWARDED_PLACEMENT, createRebornFacebookPlatform, type FacebookHostSDK, loadFacebookSDK } from './facebook';
import { startGame } from './startup';

afterEach(() => vi.unstubAllGlobals());

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

test('prepares and requests a configured rewarded booster ad through the bound host SDK', async () => {
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
  const { services } = createRebornFacebookPlatform(async () => host, '', persistence, ' test-placement ');
  await startGame(services, async () => {});
  expect(services.capabilities().rewardedAds).toBe('available');
  await expect(services.ads.request({ kind: 'rewarded', placement: BOOSTER_REWARDED_PLACEMENT, isCurrent: () => false }))
    .resolves.toEqual({ status: 'failed', attempted: false });
  expect(showAsync).not.toHaveBeenCalled();
  await expect(services.ads.request({ kind: 'rewarded', placement: BOOSTER_REWARDED_PLACEMENT }))
    .resolves.toEqual({ status: 'completed', attempted: true });
  expect(loadAsync).toHaveBeenCalled();
  expect(showAsync).toHaveBeenCalledOnce();

  const unconfigured = createRebornFacebookPlatform(async () => host, '', persistence).services;
  await startGame(unconfigured, async () => {});
  expect(unconfigured.capabilities().rewardedAds).toBe('unavailable');
  await expect(unconfigured.ads.request({ kind: 'rewarded', placement: BOOSTER_REWARDED_PLACEMENT }))
    .resolves.toEqual({ status: 'unavailable', attempted: false });
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
