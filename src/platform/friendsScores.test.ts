import { createBrowserPersistence, createWebPlatform } from '@playbridge/web';
import { expect, test, vi } from 'vitest';
import { createRebornFacebookPlatform, type FacebookHostSDK } from './facebook';
import { createFriendsScores } from './friendsScores';
import { startGame } from './startup';

const BOARD_NAME = 'Example Board';
const browser = { getItem: () => null, setItem: () => {} };

function entry(rank: number, id: string, name: string, score: number) {
  return {
    getRank: () => rank,
    getPlayer: () => ({ getID: () => id, getName: () => name }),
    getScore: () => score,
  };
}

function mockSDK() {
  const board = {
    getConnectedPlayerEntriesAsync: vi.fn(async () => [
      entry(2, 'fake-friend', 'Example Friend', 400),
      entry(7, 'fake-player', 'Example Player', 250),
    ]),
    getEntriesAsync: vi.fn(),
    setScoreAsync: vi.fn(async () => {}),
  };
  const sdk = {
    initializeAsync: vi.fn(async () => {}),
    setLoadingProgress: vi.fn(),
    startGameAsync: vi.fn(async () => {}),
    onPause: vi.fn(),
    logEvent: vi.fn(),
    getLeaderboardAsync: vi.fn(async (): Promise<Partial<typeof board>> => board),
    getSupportedAPIs: vi.fn((): unknown => ['getLeaderboardAsync']),
    player: { getID: vi.fn((): string | null => 'fake-player'),
      getDataAsync: vi.fn(), setDataAsync: vi.fn(), flushDataAsync: vi.fn() },
  } satisfies FacebookHostSDK;
  return { sdk, board };
}

function setupSDK(sdk: FacebookHostSDK, name = BOARD_NAME) {
  const { services, submitScore } = createRebornFacebookPlatform(async () => sdk, name, createBrowserPersistence(browser));
  return {
    start: () => startGame(services, async () => {}),
    friends: () => createFriendsScores(services, name, submitScore),
  };
}

test('only probes when Friends is requested after host start, before any board request', async () => {
  const { sdk, board } = mockSDK();
  let started = false;
  sdk.startGameAsync.mockImplementation(async () => { started = true; });
  sdk.getSupportedAPIs.mockImplementation(function (this: FacebookHostSDK) {
    expect(this).toBe(sdk);
    return started ? ['FBInstant.getLeaderboardAsync'] : [];
  });
  const platform = setupSDK(sdk);
  expect(platform.friends()).toBeNull();
  await platform.start();
  expect(sdk.getSupportedAPIs).not.toHaveBeenCalled();
  expect(platform.friends()).not.toBeNull();
  expect(sdk.getSupportedAPIs).toHaveBeenCalledOnce();
  expect(sdk.getLeaderboardAsync).not.toHaveBeenCalled();
  expect(sdk.player.getID).not.toHaveBeenCalled();
  expect(board.setScoreAsync).not.toHaveBeenCalled();
});

test('does not expose Friends on web even when a board is configured', () => {
  const submit = vi.fn();
  expect(createFriendsScores(createWebPlatform(browser), BOARD_NAME, submit)).toBeNull();
  expect(submit).not.toHaveBeenCalled();
});

test('does not probe when no board is configured or the SDK method is absent', async () => {
  const { sdk } = mockSDK();
  const unconfigured = setupSDK(sdk, '');
  const missingMethod = setupSDK({ ...sdk, getLeaderboardAsync: undefined });
  for (const platform of [unconfigured, missingMethod]) {
    await platform.start();
    expect(platform.friends()).toBeNull();
  }
  expect(sdk.getLeaderboardAsync).not.toHaveBeenCalled();
  expect(sdk.getSupportedAPIs).not.toHaveBeenCalled();
});

test.each([
  { response: [] },
  { response: ['startGameAsync'] },
  { response: undefined },
  { response: 'getLeaderboardAsync' },
  { response: ['getLeaderboardAsync', 1] },
])('disables Friends for an unsupported or malformed capability response ($response)', async ({ response }) => {
  const { sdk } = mockSDK();
  sdk.getSupportedAPIs.mockReturnValue(response);
  const platform = setupSDK(sdk);
  await platform.start();
  expect(platform.friends()).toBeNull();
  expect(sdk.getLeaderboardAsync).not.toHaveBeenCalled();
});

test('a throwing optional probe does not break startup', async () => {
  const { sdk } = mockSDK();
  sdk.getSupportedAPIs.mockImplementation(() => { throw new Error('Example SDK failure'); });
  const platform = setupSDK(sdk);
  await platform.start();
  expect(platform.friends()).toBeNull();
  expect(sdk.getLeaderboardAsync).not.toHaveBeenCalled();
});

test('uses method presence when the probe and player identity are absent', async () => {
  const { sdk, board } = mockSDK();
  const platform = setupSDK({ ...sdk, getSupportedAPIs: undefined, player: { ...sdk.player, getID: undefined } });
  await platform.start();
  const scores = platform.friends()!;
  expect(sdk.getLeaderboardAsync).not.toHaveBeenCalled();

  await expect(scores.submit(250)).resolves.toBeUndefined();
  expect(board.setScoreAsync.mock.calls).toEqual([[250]]);
  await expect(scores.list()).resolves.toEqual([
    { rank: 2, name: 'Example Friend', score: 400 },
    { rank: 7, name: 'Example Player', score: 250 },
  ]);
});

test('maps connected entries in SDK order and preserves their SDK ranks', async () => {
  const { sdk, board } = mockSDK();
  sdk.getLeaderboardAsync.mockImplementation(async function (this: FacebookHostSDK) {
    expect(this).toBe(sdk);
    return board;
  });
  const platform = setupSDK(sdk);
  await platform.start();
  const scores = platform.friends()!;

  await expect(scores.list()).resolves.toEqual([
    { rank: 2, name: 'Example Friend', score: 400 },
    { rank: 7, name: 'Example Player', score: 250, current: true },
  ]);
  expect(sdk.getLeaderboardAsync.mock.calls).toEqual([[BOARD_NAME]]);
  expect(board.getConnectedPlayerEntriesAsync.mock.calls).toEqual([[10, 0]]);
  expect(board.getEntriesAsync).not.toHaveBeenCalled();
  expect(board.setScoreAsync).not.toHaveBeenCalled();
});

test('submit sends one numeric argument with no automatic score reads', async () => {
  const { sdk, board } = mockSDK();
  const platform = setupSDK(sdk);
  await platform.start();
  const scores = platform.friends()!;

  await expect(scores.submit(250)).resolves.toBeUndefined();
  expect(sdk.getLeaderboardAsync.mock.calls).toEqual([[BOARD_NAME]]);
  expect(board.setScoreAsync.mock.calls).toEqual([[250]]);
  expect(board.getConnectedPlayerEntriesAsync).not.toHaveBeenCalled();
  expect(board.getEntriesAsync).not.toHaveBeenCalled();
  expect(sdk.player.getID).not.toHaveBeenCalled();
});

test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid score %s before requesting a board', async score => {
  const { sdk } = mockSDK();
  const platform = setupSDK(sdk);
  await platform.start();
  await expect(platform.friends()!.submit(score)).rejects.toThrow('Invalid leaderboard score.');
  expect(sdk.getLeaderboardAsync).not.toHaveBeenCalled();
});

test('rejects missing board methods without falling back to a public list', async () => {
  const { sdk, board } = mockSDK();
  const platform = setupSDK(sdk);
  await platform.start();
  const scores = platform.friends()!;
  sdk.getLeaderboardAsync.mockResolvedValueOnce({ getEntriesAsync: board.getEntriesAsync });
  await expect(scores.list()).rejects.toThrow('Facebook friends scores are unavailable.');
  expect(board.getEntriesAsync).not.toHaveBeenCalled();

  sdk.getLeaderboardAsync.mockResolvedValueOnce({});
  await expect(scores.submit(250)).rejects.toThrow('Facebook score submission is unavailable.');
});

test('propagates SDK failures and allows a later explicit retry', async () => {
  const { sdk, board } = mockSDK();
  const platform = setupSDK(sdk);
  await platform.start();
  const scores = platform.friends()!;
  const failure = new Error('Example SDK failure');
  sdk.getLeaderboardAsync.mockRejectedValueOnce(failure);
  board.getConnectedPlayerEntriesAsync.mockRejectedValueOnce(failure).mockResolvedValueOnce([]);
  board.setScoreAsync.mockRejectedValueOnce(failure);

  await expect(scores.list()).rejects.toBe(failure);
  await expect(scores.list()).rejects.toBe(failure);
  await expect(scores.list()).resolves.toEqual([]);
  await expect(scores.submit(250)).rejects.toBe(failure);
  await expect(scores.submit(250)).resolves.toBeUndefined();
});
