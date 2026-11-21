export interface FriendScore {
  rank: number;
  name: string;
  score: number;
  current?: boolean;
}

export interface FriendsScores {
  list(): Promise<readonly FriendScore[]>;
  submit(score: number): Promise<void>;
}

const PAGE_SIZE = 10;

/** Call after Facebook startup so the SDK can report the active client's capabilities. */
export function createFriendsScores(): FriendsScores | null {
  if (import.meta.env.MODE !== 'facebook' || typeof window === 'undefined') return null;

  const name = import.meta.env.VITE_DONUTS_FRIENDS_BOARD?.trim();
  if (!name) return null;

  const sdk = window.FBInstant;
  if (typeof sdk?.getLeaderboardAsync !== 'function') return null;

  try {
    if (sdk.getSupportedAPIs !== undefined) {
      const supported = sdk.getSupportedAPIs();
      if (!Array.isArray(supported) || !supported.every(api => typeof api === 'string') ||
        !supported.some(api => api === 'getLeaderboardAsync' || api === 'FBInstant.getLeaderboardAsync')) return null;
    }
  } catch {
    return null;
  }

  const getLeaderboard = sdk.getLeaderboardAsync.bind(sdk);
  return {
    async list() {
      const board = await getLeaderboard(name);
      if (typeof board.getConnectedPlayerEntriesAsync !== 'function') {
        throw new Error('Facebook friends scores are unavailable.');
      }

      const entries = await board.getConnectedPlayerEntriesAsync(PAGE_SIZE, 0);
      const currentPlayerID = sdk.player?.getID?.();
      return entries.map(entry => {
        const player = entry.getPlayer();
        const score: FriendScore = { rank: entry.getRank(), name: player.getName(), score: entry.getScore() };
        if (currentPlayerID && player.getID?.() === currentPlayerID) score.current = true;
        return score;
      });
    },
    async submit(score) {
      if (!Number.isSafeInteger(score) || score < 0) throw new Error('Invalid leaderboard score.');

      const board = await getLeaderboard(name);
      if (typeof board.setScoreAsync !== 'function') throw new Error('Facebook score submission is unavailable.');
      await board.setScoreAsync(score);
    },
  };
}
