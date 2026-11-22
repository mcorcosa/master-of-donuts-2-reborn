import { PlatformError, type Outcome, type Persistence, type PlatformServices } from '@playbridge/core';
import { createFacebookPlatform, type FacebookLeaderboard, type FacebookLeaderboardEntry, type FacebookSDK, type FacebookServices } from '@playbridge/facebook';
import { Monetization, type AdPlacement } from './monetization';
import { MonetizationAdInventory } from './monetizationAdInventory';
import { MonetizationHistory } from './monetizationHistory';
import { RemoveAds } from './removeAds';

const REWARDED_PLACEMENTS = ['joker', 'sweep', 'extra-chance'] as const;

interface FacebookMonetizationOptions {
  placements?: Partial<Record<AdPlacement, string>>;
  removeAdsSku?: string;
  getHistoryStorage?: () => Pick<Storage, 'getItem' | 'setItem'>;
  isForeground?: () => boolean;
}

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

function supportedAPIs(sdk: FacebookHostSDK): ReadonlySet<string> | null {
  try {
    const probe = sdk.getSupportedAPIs;
    if (probe === undefined) return null;
    const apis = probe.call(sdk);
    if (Array.isArray(apis) && [...apis].every(api => typeof api === 'string')) {
      return new Set(apis.map(api => api.replace(/^FBInstant\./, '')));
    }
  } catch {
    // Optional capabilities never block startup.
  }
  return new Set();
}

function boundMethod<K extends 'getLeaderboardAsync' | 'getRewardedVideoAsync' | 'getInterstitialAdAsync'>(
  host: FacebookHostSDK, key: K, probe: () => ReadonlySet<string> | null,
): FacebookHostSDK[K] | undefined {
  try {
    const method = host[key];
    if (typeof method !== 'function' || probe()?.has(key) === false) return;
    return method.bind(host) as FacebookHostSDK[K];
  } catch { /* An unavailable host method is optional. */ }
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
  options: FacebookMonetizationOptions = {},
): { services: Omit<PlatformServices, 'purchases'>; removeAds: RemoveAds; monetization: Monetization;
  submitScore: (score: number) => Promise<Outcome> } {
  const interstitialPlacement = options.placements?.['play-again']?.trim() ?? '';
  const rewardedPlacements = Object.fromEntries(REWARDED_PLACEMENTS.map(placement =>
    [placement, options.placements?.[placement]?.trim() ?? '']));
  const anyRewarded = Object.values(rewardedPlacements).some(Boolean);
  const isForeground = options.isForeground ?? (() => true);
  const inventory = new MonetizationAdInventory();
  let sdk: FacebookSDK | undefined;
  let getInterstitial: FacebookSDK['getInterstitialAdAsync'];
  let getRewarded: FacebookSDK['getRewardedVideoAsync'];
  let admittedRewarded: string | undefined;
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
  const platform: FacebookServices = createFacebookPlatform({
    getSDK: () => sdk,
    rewardedPlacements,
    interstitialPlacement,
    interstitialAllowed: () => monetization.canPreloadInterstitial,
    checkoutActive: () => removeAds.checkoutActive,
    async awaitSDK() {
      const host = await awaitSDK();
      sdk = {
        initializeAsync: () => host.initializeAsync(),
        async startGameAsync() {
          await host.startGameAsync();
          let capabilities: ReadonlySet<string> | null | undefined;
          const probe = () => capabilities === undefined ? (capabilities = supportedAPIs(host)) : capabilities;
          if (boardName) probeLeaderboard = () => boundMethod(host, 'getLeaderboardAsync', probe);
          if (interstitialPlacement) getInterstitial = boundMethod(host, 'getInterstitialAdAsync', probe);
          if (anyRewarded) getRewarded = boundMethod(host, 'getRewardedVideoAsync', probe);
        },
        setLoadingProgress(progress) {
          // The pinned adapter signals completion during initialize. Reborn finishes after its first render.
          if (progress !== 100 || !initializing) host.setLoadingProgress(progress);
        },
        onPause: callback => host.onPause?.(callback),
        logEvent: name => host.logEvent(name),
        get player() { return host.player; },
        get payments() {
          try {
            const payments = host.payments;
            return typeof payments?.onReady === 'function' && typeof payments.getPurchasesAsync === 'function'
              ? payments : undefined;
          }
          catch { return undefined; }
        },
        get getInterstitialAdAsync() {
          const create = getInterstitial;
          return create && ((id: string) => inventory.acquire(`interstitial:${id}`, () => create(id),
            () => monetization.canPreloadInterstitial));
        },
        get getRewardedVideoAsync() {
          const create = getRewarded;
          if (!create || admittedRewarded === undefined) return;
          return (id: string) => {
            if (id !== admittedRewarded) return Promise.reject(new Error('Rewarded ad was not requested.'));
            // PlayBridge can refill after show. Rewarded native loads require a new opt-in.
            admittedRewarded = undefined;
            return inventory.acquire(`rewarded:${id}`, () => create(id), () => true);
          };
        },
        get getLeaderboardAsync() {
          const getBoard = selectedLeaderboard();
          return getBoard && (async (name: string) => connectedBoard(await getBoard(name)));
        },
      };
    },
  });
  const { purchases, ...platformServices } = platform;
  const monetization: Monetization = new Monetization({
    history: new MonetizationHistory(options.getHistoryStorage, () => Date.now(), () => crypto.randomUUID()),
    supported: placement => placement === 'play-again'
      ? !!getInterstitial && !!interstitialPlacement
      : !!getRewarded && !!rewardedPlacements[placement],
    interstitialAllowed: (): boolean => removeAds.ownership === 'inactive',
    checkoutActive: (): boolean => removeAds.checkoutActive,
    isForeground,
    interstitialReady: () => platform.ads.interstitialReady(),
    async requestAd(request) {
      if (request.kind === 'rewarded') {
        const id = rewardedPlacements[request.placement];
        if (!inventory.canAcquire(`rewarded:${id}`)) return { status: 'unavailable', attempted: false };
        admittedRewarded = id;
      }
      try {
        return await platform.ads.request({ ...request, onAttempt() {
          admittedRewarded = undefined;
          request.onAttempt?.();
        } });
      } finally { admittedRewarded = undefined; }
    },
  });
  const removeAds = new RemoveAds({
    purchases,
    sku: options.removeAdsSku,
    automaticAdsEnabled: () => !!getInterstitial && !!interstitialPlacement,
    canOpenCheckout: () => isForeground() && !monetization.adBusy,
    ownershipChanged: () => monetization.prepareInterstitial(),
    checkoutChanged: () => monetization.checkoutChanged(),
  });
  let started = false;
  const services: Omit<PlatformServices, 'purchases'> = {
    ...platformServices,
    persistence,
    capabilities() {
      return {
        ...platform.capabilities(),
        interstitialAds: !interstitialPlacement || !started ? 'unavailable' : getInterstitial ? 'available' : 'unsupported',
        rewardedAds: !anyRewarded || !started ? 'unavailable' : getRewarded ? 'available' : 'unsupported',
      };
    },
    ads: {
      async request({ kind, placement, isCurrent = () => true, onAttempt = () => {} }) {
        if ((kind === 'interstitial' && placement === 'play-again') ||
            (kind === 'rewarded' && REWARDED_PLACEMENTS.some(rewarded => rewarded === placement))) {
          return monetization.request(placement as AdPlacement, { isCurrent, canShow: isCurrent, onAttempt, onRecovery() {} });
        }
        return { status: 'unsupported', attempted: false };
      },
    },
    lifecycle: {
      ...platform.lifecycle,
      async initialize() {
        initializing = true;
        try { await platform.lifecycle.initialize(); }
        finally { initializing = false; }
      },
      async start() {
        await platform.lifecycle.start();
        if (started) return;
        started = true;
        let playerId: string | null = null;
        if (getInterstitial) {
          try {
            const identity = platform.identity();
            if (identity.status === 'completed') playerId = identity.value;
          } catch { /* An unavailable identity disables automatic ad history. */ }
        }
        monetization.start(playerId);
        void removeAds.refresh();
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
  return { services, removeAds, monetization, submitScore };
}
