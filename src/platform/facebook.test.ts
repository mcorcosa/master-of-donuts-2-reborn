import { afterEach, expect, test, vi } from 'vitest';
import { startFacebookGame } from './facebook';

afterEach(() => vi.unstubAllGlobals());

function mockSDK() {
  const sdk = {
    initializeAsync: vi.fn(async () => {}),
    setLoadingProgress: vi.fn(),
    startGameAsync: vi.fn(async () => {}),
  };
  vi.stubGlobal('window', { FBInstant: sdk });
  return sdk;
}

test('starts Facebook only after the first playable frame is ready', async () => {
  const sdk = mockSDK();
  let initialized = false;
  sdk.initializeAsync.mockImplementation(async () => {
    await Promise.resolve();
    initialized = true;
  });
  let playable = false;
  const prepareGame = vi.fn(async () => {
    expect(initialized).toBe(true);
    expect(sdk.setLoadingProgress.mock.calls).toEqual([[0]]);
    await Promise.resolve();
    playable = true;
  });
  sdk.startGameAsync.mockImplementation(async () => {
    expect(playable).toBe(true);
  });

  await startFacebookGame(prepareGame);

  expect(prepareGame).toHaveBeenCalledOnce();
  expect(sdk.setLoadingProgress.mock.calls).toEqual([[0], [100]]);
  expect(sdk.setLoadingProgress.mock.invocationCallOrder[1])
    .toBeLessThan(sdk.startGameAsync.mock.invocationCallOrder[0]);
  expect(sdk.startGameAsync).toHaveBeenCalledOnce();
});

test('waits for the SDK script to finish loading', async () => {
  const sdk = mockSDK();
  const browser = { FBInstant: undefined as typeof sdk | undefined, setTimeout, clearTimeout };
  vi.stubGlobal('window', browser);
  const script = new EventTarget();
  const getElementById = vi.fn(() => script);
  vi.stubGlobal('document', { getElementById });

  const startup = startFacebookGame(async () => {});
  expect(getElementById).toHaveBeenCalledWith('facebook-sdk');
  expect(sdk.initializeAsync).not.toHaveBeenCalled();

  browser.FBInstant = sdk;
  script.dispatchEvent(new Event('load'));
  await startup;

  expect(sdk.startGameAsync).toHaveBeenCalledOnce();
});

test('leaves startup incomplete when preparing the game fails', async () => {
  const sdk = mockSDK();
  const error = new Error('Legacy textures failed to load');

  await expect(startFacebookGame(async () => { throw error; })).rejects.toBe(error);

  expect(sdk.setLoadingProgress.mock.calls).toEqual([[0]]);
  expect(sdk.startGameAsync).not.toHaveBeenCalled();
});
