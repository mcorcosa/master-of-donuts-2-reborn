import { PlatformError, type Outcome, type Persistence, type PlatformServices } from '@playbridge/core';
import { createFacebookPlatform, type FacebookLeaderboard, type FacebookLeaderboardEntry, type FacebookSDK } from '@playbridge/facebook';

export const BOOSTER_REWARDED_PLACEMENT = 'booster';

interface HostLeaderboardEntry extends Pick<FacebookLeaderboardEntry, 'getRank' | 'getScore'> {
  getPlayer(): { getID?(): string | null; getName(): string };
  getTimestamp?(): number;
  getExtraData?(): string | null;
}

interface HostLeaderboard {
  getConnectedPlayerEntriesAsync?(count: number, offset: number): Promise<readonly HostLeaderboardEntry[]>;
  setScoreAsync?(score: number): Promise<unknown>;
}

export interface FacebookHostSDK extends Omit<FacebookSDK, 'getSupportedAPIs' | 'getLeaderboardAsync'> {
  getSupportedAPIs?(): unknown;
  getLeaderboardAsync?(name: string): Promise<HostLeaderboard>;
}

export async function loadFacebookSDK(getSDK: () => FacebookHostSDK | undefined): Promise<FacebookHostSDK> {
  const sdk = getSDK();
  if (sdk) return sdk;

  const script = document.getElementById('facebook-sdk');
  if (!script) throw new Error('Facebook SDK script is missing.');

  return new Promise((resolve, reject) => {
    const listeners = new AbortController();
    const timeout = window.setTimeout(() => {
      listeners.abort();
      reject(new Error('Facebook SDK download timed out.'));
    }, 10_000);
    const cleanup = () => {
      window.clearTimeout(timeout);
      listeners.abort();
    };
    script.addEventListener('load', () => {
      cleanup();
      const sdk = getSDK();
      if (sdk) resolve(sdk);
      else reject(new Error('Facebook SDK did not become available.'));
    }, { signal: listeners.signal });
    script.addEventListener('error', () => {
      cleanup();
      reject(new Error('Facebook SDK download failed.'));
    }, { signal: listeners.signal });
  });
}

function supportedLeaderboard(sdk: FacebookHostSDK): FacebookHostSDK['getLeaderboardAsync'] {
  try {
    const getLeaderboard = sdk.getLeaderboardAsync;
    if (typeof getLeaderboard !== 'function') return undefined;
    const probe = sdk.getSupportedAPIs;
    if (probe === undefined) return getLeaderboard.bind(sdk);
    const apis = probe.call(sdk);
    if (Array.isArray(apis) && apis.every(api => typeof api === 'string') &&
        apis.some(api => api === 'getLeaderboardAsync' || api === 'FBInstant.getLeaderboardAsync')) {
      return getLeaderboard.bind(sdk);
    }
  } catch {
    // This optional probe must not prevent the board or personal scores from loading.
  }
}

async function unsupportedLeaderboardOperation(): Promise<never> {
  throw new PlatformError('unsupported', 'This leaderboard operation is unavailable.');
}

function connectedBoard(board: HostLeaderboard): FacebookLeaderboard {
  return {
    async getConnectedPlayerEntriesAsync(count, offset) {
      if (typeof board.getConnectedPlayerEntriesAsync !== 'function') {
        throw new PlatformError('unsupported', 'Facebook friends scores are unavailable.');
      }
      const entries = await board.getConnectedPlayerEntriesAsync(count, offset);
      return entries.map(entry => ({
        getPlayer() {
          const player = entry.getPlayer();
          return { getID: () => player.getID?.() ?? null, getName: () => player.getName() };
        },
        getRank: () => entry.getRank(),
        getScore: () => entry.getScore(),
        // Some hosts omit these fields. Reborn only displays rank, score and player.
        getTimestamp: () => entry.getTimestamp?.() ?? Number.NaN,
        getExtraData: () => entry.getExtraData?.() ?? null,
      }));
    },
    getEntriesAsync: unsupportedLeaderboardOperation,
    getPlayerEntryAsync: unsupportedLeaderboardOperation,
    setScoreAsync: unsupportedLeaderboardOperation,
  };
}

export function createRebornFacebookPlatform(
  awaitSDK: () => Promise<FacebookHostSDK>,
  boardName: string,
  persistence: Persistence,
  boosterPlacementId = '',
): { services: PlatformServices; submitScore: (score: number) => Promise<Outcome> } {
  let sdk: FacebookSDK | undefined;
  let getLeaderboard: FacebookHostSDK['getLeaderboardAsync'];
  let probeLeaderboard: (() => FacebookHostSDK['getLeaderboardAsync']) | undefined;
  let initializing = false;
  function selectedLeaderboard(): FacebookHostSDK['getLeaderboardAsync'] {
    if (probeLeaderboard) {
      getLeaderboard = probeLeaderboard();
      probeLeaderboard = undefined;
    }
    return getLeaderboard;
  }
  const platform = createFacebookPlatform({
    getSDK: () => sdk,
    rewardedPlacements: { [BOOSTER_REWARDED_PLACEMENT]: boosterPlacementId.trim() },
    initialRewarded: BOOSTER_REWARDED_PLACEMENT,
    async awaitSDK() {
      const host = await awaitSDK();
      sdk = {
        initializeAsync: () => host.initializeAsync(),
        async startGameAsync() {
          await host.startGameAsync();
          if (boardName) probeLeaderboard = () => supportedLeaderboard(host);
        },
        setLoadingProgress(progress) {
          // The pinned adapter signals completion during initialize. Reborn finishes after its first render.
          if (progress !== 100 || !initializing) host.setLoadingProgress(progress);
        },
        onPause: callback => host.onPause?.(callback),
        logEvent: name => host.logEvent(name),
        get player() { return host.player; },
        get getRewardedVideoAsync() {
          const getAd = host.getRewardedVideoAsync;
          return typeof getAd === 'function' ? getAd.bind(host) : undefined;
        },
        get getLeaderboardAsync() {
          const getBoard = selectedLeaderboard();
          return getBoard && (async (name: string) => connectedBoard(await getBoard(name)));
        },
      };
    },
  });
  const services: PlatformServices = {
    ...platform,
    persistence,
    lifecycle: {
      ...platform.lifecycle,
      async initialize() {
        initializing = true;
        try { await platform.lifecycle.initialize(); }
        finally { initializing = false; }
      },
    },
  };

  // PlayBridge's submit expects metadata and a returned entry. The game uses the SDK's score-only form.
  async function submitScore(score: number): Promise<Outcome> {
    const getBoard = selectedLeaderboard();
    if (!getBoard) return { status: 'unsupported' };
    try {
      const board = await getBoard(boardName);
      if (typeof board.setScoreAsync !== 'function') {
        return { status: 'unsupported', error: new Error('Facebook score submission is unavailable.') };
      }
      await board.setScoreAsync(score);
      return { status: 'completed', value: undefined };
    } catch (error) {
      return { status: error instanceof PlatformError ? error.status : 'failed', error };
    }
  }
  return { services, submitScore };
}
