import type { MascotPose } from './mascot';

type Transform = {
  readonly x: number;
  readonly y: number;
  readonly scaleX: number;
  readonly scaleY: number;
  readonly rotation: number;
  readonly hands: number;
};

export const MASCOT_REST: Transform = { x: 0, y: 0, scaleX: 1, scaleY: 1, rotation: 0, hands: 0 };

// Age, side step, lift, stretch X/Y, tilt. Amplitudes fit the compact HUD.
type Beat = readonly [number, number, number, number, number, number];

const pop: readonly Beat[] = [
  [0, 0, 0, 1, 1, 0],
  [85, 0, 1.9, 1.09, .89, -.027],
  [215, 1, -3.5, .955, 1.025, .045],
  [320, 1.4, -2.9, 1.015, .99, .028],
  [445, 0, 1.4, 1.085, .91, -.036],
  [555, -.7, -.65, .985, 1.017, .016],
  [740, 0, 0, 1, 1, 0],
];

const combo: readonly Beat[] = [
  ...pop.slice(0, 5),
  [635, -4.3, -.75, 1.04, .96, -.105],
  [825, 1.1, -3, .965, 1.025, .025],
  [1040, 4.6, .85, 1.07, .94, .11],
  [1250, -2.5, -1.6, .975, 1.015, -.075],
  [1450, 0, 0, 1, 1, 0],
];

const level: readonly Beat[] = [
  ...pop.slice(0, 5),
  [665, -5, .75, 1.074, .935, -.12],
  [890, 0, -3.15, .959, 1.023, .013],
  [1090, 5, .72, 1.074, .938, .119],
  [1320, 2, -2, .98, 1.02, .05],
  [1530, -4.4, .1, 1.032, .972, -.101],
  [1750, 3.1, -.95, .982, 1.018, .082],
  [1990, -.9, .38, 1.018, .988, -.026],
  [2280, 0, 0, 1, 1, 0],
];

const reactions = {
  match: { priority: 1, still: 650, beats: pop },
  combo: { priority: 2, still: 1000, beats: combo },
  level: { priority: 3, still: 1450, beats: level },
};

type Reaction = keyof typeof reactions;

function dance(beats: readonly Beat[], age: number): Transform {
  const index = beats.findIndex(([time]) => time > age);
  if (index < 1) return MASCOT_REST;
  const from = beats[index - 1];
  const to = beats[index];
  const progress = (age - from[0]) / (to[0] - from[0]);
  const ease = progress * progress * (3 - 2 * progress);
  const mix = (axis: 1 | 2 | 3 | 4 | 5) => from[axis] + (to[axis] - from[axis]) * ease;
  return { x: mix(1), y: mix(2), scaleX: mix(3), scaleY: mix(4), rotation: mix(5), hands: 0 };
}

function tremble(remaining: number, phase: number): Transform {
  const power = remaining === 1 ? 1 : remaining === 2 ? .73 : .47;
  const tuck = Math.sin(Math.PI * phase) ** 2 * power;
  const sway = Math.sin((remaining === 1 ? 8 : 6) * Math.PI * phase) * tuck;
  return { x: sway * 2.6, y: tuck * 1.1, scaleX: 1 - .045 * tuck, scaleY: 1 - .035 * tuck,
    rotation: sway * .055, hands: tuck + .35 * sway };
}

interface MascotSituation {
  readonly blocked: boolean;
  readonly terminal: boolean;
  readonly hint: boolean;
  readonly paused: boolean;
  readonly reduced: boolean;
  readonly committed: number;
  readonly urgency: { remaining: number; started: number | null; duration: number };
}

export interface MascotFrame {
  readonly pose: MascotPose;
  readonly transform: Transform;
}

const still = (pose: MascotPose): MascotFrame => ({ pose, transform: MASCOT_REST });
const waving = still('waving');
const pensive = still('pensive');
const confused = still('confused');
const laughing = still('laughing');
const frightened = still('frightened');

export class MascotMotion {
  private queuedMatch: { kind: 'match' | 'combo'; started: number; reduced: boolean } | null = null;
  private reaction: { kind: Reaction; started: number } | null = null;
  animating = false;
  deadline = 0;

  start(kind: Reaction, now: number, reduced: boolean): void {
    if (this.reaction) {
      const { kind: current, started } = this.reaction;
      if (now < started + this.duration(current, reduced) && reactions[current].priority > reactions[kind].priority) return;
    }
    this.reaction = { kind, started: now };
  }

  queueMatch(combo: boolean, at: number, reduced: boolean): void {
    this.queuedMatch = { kind: combo ? 'combo' : 'match', started: at, reduced };
  }

  reset(): void {
    this.reaction = this.queuedMatch = null;
    this.animating = false;
    this.deadline = 0;
  }

  show(now: number, { blocked, terminal, hint, paused, reduced, committed, urgency }: MascotSituation): MascotFrame {
    const { remaining, started, duration } = urgency;
    const critical = remaining > 0 && remaining <= 3 && committed <= remaining;
    this.animating = false;
    this.deadline = 0;
    if (paused || terminal) {
      this.reset();
      return terminal ? confused : critical ? frightened : waving;
    }
    if (this.queuedMatch && now >= this.queuedMatch.started) {
      const { kind, started, reduced } = this.queuedMatch;
      this.queuedMatch = null;
      this.start(kind, started, reduced);
    }
    if (this.reaction && now >= this.reaction.started + this.duration(this.reaction.kind, reduced)) this.reaction = null;

    if (blocked) return confused;
    if (hint) return pensive;
    if (critical && !reduced && started !== null && now < started + duration) {
      this.animating = true;
      return { pose: 'frightened', transform: tremble(remaining, Math.max(0, now - started) / duration) };
    }
    if (!this.reaction) return critical ? frightened : waving;
    const { kind, started: begins } = this.reaction;
    if (reduced) {
      this.deadline = begins + reactions[kind].still;
      return laughing;
    }
    this.animating = true;
    return { pose: 'laughing', transform: dance(reactions[kind].beats, now - begins) };
  }

  private duration(kind: Reaction, reduced: boolean): number {
    const { beats, still } = reactions[kind];
    return reduced ? still : beats[beats.length - 1][0];
  }
}
