import type { Outcome, PlatformServices } from '@playbridge/core';

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

/** Called after startup when a completed game can offer Friends. */
export function createFriendsScores(
  platform: Pick<PlatformServices, 'capabilities' | 'identity' | 'leaderboards'>,
  boardName: string,
  submitScore: (score: number) => Promise<Outcome>,
): FriendsScores | null {
  if (platform.capabilities().leaderboards !== 'available') return null;
  return {
    async list() {
      const entries = await platform.leaderboards.entries(boardName, 'connected', PAGE_SIZE, 0);
      if (entries.status !== 'completed') throw entries.error ?? new Error('Friends scores are unavailable.');
      const identity = platform.identity();
      const current = identity.status === 'completed' ? identity.value : null;
      return entries.value.map(({ playerId, playerName, rank, score }) => ({
        rank, name: playerName, score, ...(current && playerId === current ? { current: true } : {}),
      }));
    },
    async submit(score) {
      if (!Number.isSafeInteger(score) || score < 0) throw new Error('Invalid leaderboard score.');

      const submitted = await submitScore(score);
      if (submitted.status !== 'completed') throw submitted.error ?? new Error('Score submission is unavailable.');
    },
  };
}
