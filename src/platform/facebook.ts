interface FacebookLeaderboardPlayer {
  getID?(): string | null;
  getName(): string;
}

interface FacebookLeaderboardEntry {
  getPlayer(): FacebookLeaderboardPlayer;
  getRank(): number;
  getScore(): number;
}

interface FacebookLeaderboard {
  getConnectedPlayerEntriesAsync?(count: number, offset: number): Promise<readonly FacebookLeaderboardEntry[]>;
  setScoreAsync?(score: number): Promise<unknown>;
}

interface FacebookSDK {
  initializeAsync(): Promise<void>;
  setLoadingProgress(progress: number): void;
  startGameAsync(): Promise<void>;
  getLeaderboardAsync?(name: string): Promise<FacebookLeaderboard>;
  getSupportedAPIs?(): readonly string[];
  player?: Pick<FacebookLeaderboardPlayer, 'getID'>;
}

declare global {
  interface Window {
    FBInstant?: FacebookSDK;
  }
}

async function loadFacebookSDK(): Promise<FacebookSDK> {
  if (window.FBInstant) return window.FBInstant;

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
      if (window.FBInstant) resolve(window.FBInstant);
      else reject(new Error('Facebook SDK did not become available.'));
    }, { signal: listeners.signal });
    script.addEventListener('error', () => {
      cleanup();
      reject(new Error('Facebook SDK download failed.'));
    }, { signal: listeners.signal });
  });
}

export async function startFacebookGame(prepareGame: () => Promise<void>): Promise<void> {
  const sdk = await loadFacebookSDK();
  await sdk.initializeAsync();
  sdk.setLoadingProgress(0);
  await prepareGame();
  sdk.setLoadingProgress(100);
  await sdk.startGameAsync();
}
