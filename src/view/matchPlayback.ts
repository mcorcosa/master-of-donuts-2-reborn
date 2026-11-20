import type { GameState } from '../game';

export interface MatchPlayback {
  from: number;
  to: number;
  color: string;
  points: number;
  started: number;
  reduced: boolean;
  arrivalMs: number;
  clearMs: number;
}

export function beginMatch(before: GameState, after: GameState, from: number, to: number,
  started: number, reduced: boolean): MatchPlayback | null {
  const points = after.score - before.score;
  const color = before.stacks[from].at(-1);
  if (points <= 0 || !color) return null;

  return { from, to, color, points, started, reduced, arrivalMs: reduced ? 0 : 220, clearMs: reduced ? 230 : 320 };
}

export function matchFrame(match: MatchPlayback, now: number) {
  const age = Math.max(0, now - match.started);
  if (age < match.arrivalMs) return { phase: 'arrival', progress: age / match.arrivalMs } as const;
  const clear = age - match.arrivalMs;
  if (clear < match.clearMs) return { phase: 'clear', progress: clear / match.clearMs } as const;
  return { phase: 'resolved', progress: 1 } as const;
}

export type MatchFrame = ReturnType<typeof matchFrame>;

function scoreRatio(points: number): number {
  return Math.log(Math.max(300, points) / 300) / Math.log(2500 / 300);
}

export function scoreEmphasis(points: number): number {
  return Math.min(1, scoreRatio(points));
}

export function scoreSize(points: number): number {
  return Math.min(48, 24 + 20 * scoreRatio(points));
}

export function scoreAccents(match: MatchPlayback): number {
  if (match.reduced || match.points < 1000) return 0;
  return match.points >= 2500 ? 6 : 4;
}

export function awardFrame(match: MatchPlayback, now: number) {
  const emphasis = scoreEmphasis(match.points);
  const lifetime = 450 + 150 * emphasis;
  const age = now - match.started - match.arrivalMs;
  if (age < 0 || age >= lifetime) return null;

  const peakX = 1.08 + 0.22 * emphasis;
  const peakY = 1.08 + 0.32 * emphasis;
  let scaleX = 1;
  let scaleY = 1;
  if (!match.reduced && age < 70) {
    const pop = 1 - (1 - age / 70) ** 2;
    scaleX = 0.85 + 0.1 * emphasis + (peakX - 0.85 - 0.1 * emphasis) * pop;
    scaleY = 0.85 - 0.2 * emphasis + (peakY - 0.85 + 0.2 * emphasis) * pop;
  } else if (!match.reduced && age < 120) {
    const settle = (age - 70) / 50;
    scaleX = peakX + (1 - 0.08 * emphasis - peakX) * settle;
    scaleY = peakY + (1 + 0.04 * emphasis - peakY) * settle;
  } else if (!match.reduced && age < 180) {
    const settle = (age - 120) / 60;
    scaleX = 1 - 0.08 * emphasis * (1 - settle);
    scaleY = 1 + 0.04 * emphasis * (1 - settle);
  }

  const drift = Math.max(0, (age - 120) / (lifetime - 120));
  const travel = match.reduced ? 0 : 12 + 6 * emphasis;
  const fade = 160 + 20 * emphasis;
  return {
    alpha: (match.reduced ? Math.min(1, age / 50) : 1)
      * (1 - Math.max(0, (age - (lifetime - fade)) / fade) ** 2),
    scaleX, scaleY,
    rotation: match.reduced || age >= 180 ? 0
      : 5 * emphasis * Math.PI / 180 * Math.cos(Math.PI * age / 100) * (1 - age / 180),
    lift: travel * (1 - (1 - drift) ** 2),
    accentProgress: Math.min(1, age / 220),
  };
}
