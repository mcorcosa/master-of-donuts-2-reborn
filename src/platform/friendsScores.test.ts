import { afterEach, expect, test, vi } from 'vitest';
import { createFriendsScores } from './friendsScores';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

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
    getLeaderboardAsync: vi.fn(async (): Promise<Partial<typeof board>> => board),
    getSupportedAPIs: vi.fn((): unknown => ['getLeaderboardAsync']),
    player: { getID: vi.fn(() => 'fake-player') },
  };
  vi.stubEnv('MODE', 'facebook');
  vi.stubEnv('VITE_DONUTS_FRIENDS_BOARD', ' Example Board ');
  vi.stubGlobal('window', { FBInstant: sdk });
  return { sdk, board };
}

test('creating the adapter only probes synchronous SDK capability', () => {
  const { sdk, board } = mockSDK();
  expect(createFriendsScores()).not.toBeNull();
  expect(sdk.getLeaderboardAsync).not.toHaveBeenCalled();
  expect(sdk.getSupportedAPIs).toHaveBeenCalledOnce();
  expect(sdk.player.getID).not.toHaveBeenCalled();
  expect(board.getConnectedPlayerEntriesAsync).not.toHaveBeenCalled();
  expect(board.getEntriesAsync).not.toHaveBeenCalled();
  expect(board.setScoreAsync).not.toHaveBeenCalled();
});

test('does not expose the adapter outside the Facebook build even with configuration and SDK', () => {
  const { sdk } = mockSDK();
  vi.stubEnv('MODE', 'production');
  expect(createFriendsScores()).toBeNull();
  expect(sdk.getLeaderboardAsync).not.toHaveBeenCalled();
  expect(sdk.getSupportedAPIs).not.toHaveBeenCalled();
});

test.each([undefined, '  '])('does not expose the adapter for board configuration %j', value => {
  const { sdk } = mockSDK();
  vi.stubEnv('VITE_DONUTS_FRIENDS_BOARD', value);
  expect(createFriendsScores()).toBeNull();
  expect(sdk.getLeaderboardAsync).not.toHaveBeenCalled();
  expect(sdk.getSupportedAPIs).not.toHaveBeenCalled();
});

test.each([undefined, {}, { getLeaderboardAsync: false }])('requires the SDK leaderboard method (%j)', sdk => {
  mockSDK();
  vi.stubGlobal('window', { FBInstant: sdk });
  expect(createFriendsScores()).toBeNull();
});

test.each([
  { response: [] },
  { response: ['startGameAsync'] },
  { response: undefined },
  { response: 'getLeaderboardAsync' },
  { response: ['getLeaderboardAsync', 1] },
])(
  'does not expose the adapter for an unsupported or malformed capability response ($response)',
  ({ response }) => {
    const { sdk } = mockSDK();
    sdk.getSupportedAPIs.mockReturnValue(response);
    expect(createFriendsScores()).toBeNull();
    expect(sdk.getLeaderboardAsync).not.toHaveBeenCalled();
  },
);

test('does not expose the adapter when the capability probe throws', () => {
  const { sdk } = mockSDK();
  sdk.getSupportedAPIs.mockImplementation(() => { throw new Error('Example SDK failure'); });
  expect(createFriendsScores()).toBeNull();
  expect(sdk.getLeaderboardAsync).not.toHaveBeenCalled();
});

test('uses method presence when the SDK has no optional capability probe', async () => {
  const { sdk, board } = mockSDK();
  vi.stubGlobal('window', { FBInstant: { getLeaderboardAsync: sdk.getLeaderboardAsync } });
  const scores = createFriendsScores()!;
  expect(sdk.getLeaderboardAsync).not.toHaveBeenCalled();

  await expect(scores.submit(250)).resolves.toBeUndefined();
  expect(board.setScoreAsync.mock.calls).toEqual([[250]]);
  await expect(scores.list()).resolves.toEqual([
    { rank: 2, name: 'Example Friend', score: 400 },
    { rank: 7, name: 'Example Player', score: 250 },
  ]);
});

test('list maps connected entries in SDK order and preserves their SDK ranks', async () => {
  const { sdk, board } = mockSDK();
  sdk.getSupportedAPIs.mockReturnValue(['FBInstant.getLeaderboardAsync']);
  const scores = createFriendsScores()!;

  await expect(scores.list()).resolves.toEqual([
    { rank: 2, name: 'Example Friend', score: 400 },
    { rank: 7, name: 'Example Player', score: 250, current: true },
  ]);
  expect(sdk.getLeaderboardAsync.mock.calls).toEqual([['Example Board']]);
  expect(board.getConnectedPlayerEntriesAsync.mock.calls).toEqual([[10, 0]]);
  expect(board.getEntriesAsync).not.toHaveBeenCalled();
  expect(board.setScoreAsync).not.toHaveBeenCalled();
});

test('submit sends one numeric argument with no automatic score reads', async () => {
  const { sdk, board } = mockSDK();
  const scores = createFriendsScores()!;

  await expect(scores.submit(250)).resolves.toBeUndefined();
  expect(sdk.getLeaderboardAsync.mock.calls).toEqual([['Example Board']]);
  expect(board.setScoreAsync.mock.calls).toEqual([[250]]);
  expect(board.getConnectedPlayerEntriesAsync).not.toHaveBeenCalled();
  expect(board.getEntriesAsync).not.toHaveBeenCalled();
  expect(sdk.player.getID).not.toHaveBeenCalled();
});

test.each([-1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])('rejects invalid score %s before requesting a board', async score => {
  const { sdk } = mockSDK();
  await expect(createFriendsScores()!.submit(score)).rejects.toThrow('Invalid leaderboard score.');
  expect(sdk.getLeaderboardAsync).not.toHaveBeenCalled();
});

test('rejects missing board methods without falling back to a public list', async () => {
  const { sdk, board } = mockSDK();
  const scores = createFriendsScores()!;

  sdk.getLeaderboardAsync.mockResolvedValueOnce({ getEntriesAsync: board.getEntriesAsync });
  await expect(scores.list()).rejects.toThrow('Facebook friends scores are unavailable.');
  expect(board.getEntriesAsync).not.toHaveBeenCalled();

  sdk.getLeaderboardAsync.mockResolvedValueOnce({});
  await expect(scores.submit(250)).rejects.toThrow('Facebook score submission is unavailable.');
});

test('propagates SDK failures and allows a later explicit retry', async () => {
  const { sdk, board } = mockSDK();
  const scores = createFriendsScores()!;
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
