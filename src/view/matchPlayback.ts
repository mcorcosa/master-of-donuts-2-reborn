import { type GameState, resolveMatch } from '../game';
import type { Point } from './gestures';
import { BOARD_FOOTER_SPACE, BOARD_TOP, VIEW_WIDTH } from './layout';
import { unit } from './movePlayback';

export interface MatchPlayback {
  from: number;
  to: number;
  color: string;
  runLength: number;
  jokerIndex?: number;
  points: number;
  combo: number;
  started: number;
  reduced: boolean;
  arrivalMs: number;
  morphMs?: number;
  clearMs: number;
}

export function beginMatch(before: GameState, after: GameState, from: number, to: number,
  started: number, reduced: boolean): MatchPlayback | null {
  const points = after.score - before.score;
  const incoming = before.stacks[from].at(-1);
  if (points <= 0 || !incoming) return null;
  const match = resolveMatch(before.stacks[to], incoming);
  if (!match) return null;

  return {
    ...match, from, to, points, combo: after.combo ?? 0,
    morphMs: match.jokerIndex !== undefined && !reduced ? 110 : 0,
    started, reduced, arrivalMs: reduced ? 0 : 220, clearMs: reduced ? 230 : 320,
  };
}

export function clearStart(match: MatchPlayback): number {
  return match.started + match.arrivalMs + (match.morphMs ?? 0);
}

export function matchFrame(match: MatchPlayback, now: number) {
  const age = Math.max(0, now - match.started);
  if (age < match.arrivalMs) return { phase: 'arrival', progress: age / match.arrivalMs } as const;
  const morph = match.morphMs ?? 0;
  const arrived = age - match.arrivalMs;
  if (arrived < morph) return { phase: 'morph', progress: arrived / morph } as const;
  const clear = arrived - morph;
  if (clear < match.clearMs) return { phase: 'clear', progress: clear / match.clearMs } as const;
  return { phase: 'resolved', progress: 1 } as const;
}

export type MatchFrame = ReturnType<typeof matchFrame>;

export interface MatchGeometry {
  start: Point;
  landing: Point;
  width: number;
  height: number;
  step: number;
  viewHeight: number;
}

interface DonutPose extends Point {
  scaleX: number;
  scaleY: number;
  rotation: number;
}

interface MatchLaunch {
  seat: Point;
  apex: DonutPose;
  burst: Point;
  takeoff: number;
  pop: number;
}

const SNAP_MS = 30;
const AWARD_HOLD_MS = 40;
const SCORE_FLIGHT_MS = 270;
const COMBO_START_DELAY_MS = 56;
const COMBO_EXTRA_MS = 300;
const COMBO_FADE_MS = 190;

export function matchPopTime(runLength: number, index: number): number {
  return 194 + 74 * (runLength - 1 - index) / (runLength - 1);
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function fitDonut(pose: DonutPose, { width, height, viewHeight }: MatchGeometry): DonutPose {
  const sin = Math.abs(Math.sin(pose.rotation));
  const cos = Math.cos(pose.rotation);
  const half = width * pose.scaleX / 2;
  const tall = height * pose.scaleY;
  const side = half * cos + tall * sin;
  return {
    ...pose,
    x: clamp(pose.x, side + 2, VIEW_WIDTH - side - 2),
    y: clamp(pose.y, BOARD_TOP + tall * cos + half * sin + 2,
      viewHeight - BOARD_FOOTER_SPACE - half * sin - 2),
  };
}

export function matchLaunches(match: MatchPlayback, geometry: MatchGeometry): MatchLaunch[] {
  const { runLength } = match;
  const { landing, width, height, step } = geometry;
  const columns = runLength <= 4 ? runLength : Math.ceil(runLength / 2);
  // A full stack near the HUD needs smaller airborne donuts to reserve space for the jump.
  const headroom = (landing.y - BOARD_TOP - Math.max(17, height * 0.36) - 4) / (height + width * 0.09);
  const scale = Math.min(0.86, Math.max(0.56, headroom), (VIEW_WIDTH - 34 - (columns - 1) * 5) / (columns * width));
  const spacing = width * scale + 5;
  const rowHeight = height * scale;
  const edge = width * scale / 2 + rowHeight * 0.17 + 4;
  const jump = Math.min(136, 34 + height * 1.03 + step * 0.45);
  const crest = Math.max(BOARD_TOP + rowHeight + width * scale * 0.09 + 4, landing.y - jump);

  return Array.from({ length: runLength }, (_, index) => {
    const order = runLength - 1 - index;
    const row = Math.floor(order / columns);
    const size = Math.min(columns, runLength - row * columns);
    // The top donut leads from the middle, with subsequent donuts spreading left and right.
    const lane = (order % columns + Math.floor(size / 2)) % size;
    const side = lane - (size - 1) / 2;
    const spread = (size - 1) / 2 * spacing;
    const center = clamp(landing.x, edge + spread, VIEW_WIDTH - edge - spread);
    const apex = fitDonut({
      x: center + side * spacing,
      y: crest + row * (rowHeight + 5) + 6 * Math.abs(side),
      rotation: side === 0 ? -0.09 : Math.sign(side) * 0.17,
      scaleX: scale, scaleY: scale,
    }, geometry);
    return {
      seat: { x: landing.x, y: landing.y + order * step },
      apex,
      burst: { x: apex.x + Math.sin(apex.rotation) * rowHeight / 2, y: apex.y - Math.cos(apex.rotation) * rowHeight / 2 },
      takeoff: 49 + 39 * order / (runLength - 1),
      pop: matchPopTime(runLength, index),
    };
  });
}

export function launchedDonut(launch: MatchLaunch, geometry: MatchGeometry, age: number) {
  const { seat, apex, burst, takeoff, pop } = launch;
  const impact = Math.min(geometry.height * 0.18, geometry.step * 0.56);
  if (age < takeoff) {
    const squash = unit((age - (takeoff - 43)) / 35);
    return { ...fitDonut({
      x: seat.x, y: seat.y + impact * squash, rotation: 0,
      scaleX: 1 + 0.12 * squash, scaleY: 1 - 0.25 * squash,
    }, geometry), alpha: 1 };
  }
  if (age < pop) {
    const fraction = unit((age - takeoff) / (pop - takeoff));
    const rise = 1 - (1 - fraction) ** 2;
    const stretch = Math.sin(Math.PI * unit(fraction / 0.68));
    return { ...fitDonut({
      x: seat.x + (apex.x - seat.x) * rise,
      y: seat.y + impact + (apex.y - seat.y - impact) * rise,
      rotation: apex.rotation * rise,
      scaleX: 1.12 + (apex.scaleX - 1.12) * rise - 0.14 * stretch,
      scaleY: 0.75 + (apex.scaleY - 0.75) * rise + 0.39 * stretch,
    }, geometry), alpha: 1 };
  }
  const snap = (age - pop) / SNAP_MS;
  if (snap >= 1) return null;
  const collapse = (1 - snap) ** 2;
  return { ...apex,
    x: burst.x + (apex.x - burst.x) * collapse, y: burst.y + (apex.y - burst.y) * collapse,
    scaleX: apex.scaleX * collapse, scaleY: apex.scaleY * collapse, alpha: 1 - snap ** 2,
  };
}

function scoreEmphasis(points: number): number {
  return Math.min(1, Math.log(Math.max(300, points) / 300) / Math.log(2500 / 300));
}

export function scoreSize(points: number): number {
  return 50 + 24 * scoreEmphasis(points);
}

export function scorePopPeak(points: number) {
  const strength = scoreEmphasis(points);
  return { x: 1.38 + 0.14 * strength, y: 1.51 + 0.14 * strength };
}

export function comboPopPeak(combo: number): number {
  return 1.19 + 0.14 * unit((combo - 2) / 4);
}

function flightStart(match: MatchPlayback): number {
  return clearStart(match) + match.clearMs + AWARD_HOLD_MS;
}

export function scoreImpactTime(match: MatchPlayback): number {
  return match.reduced ? clearStart(match) + match.clearMs : flightStart(match) + SCORE_FLIGHT_MS;
}

export function scoreFlightFrame(match: MatchPlayback, now: number): number | null {
  const age = now - flightStart(match);
  return match.reduced || age < 0 || age >= SCORE_FLIGHT_MS ? null : age / SCORE_FLIGHT_MS;
}

export function scoreFlightPosition(start: Point, target: Point, progress: number): Point {
  const time = progress ** 1.35;
  const arc = Math.sin(time * Math.PI);
  const inset = Math.sign(target.x - start.x) * Math.min(19, Math.abs(target.x - start.x) * 0.14);
  return {
    x: start.x + (target.x - start.x) * time - arc * inset,
    y: start.y + (target.y - start.y) * time - arc * Math.min(35, (start.y - target.y) * 0.24),
  };
}

function awardStart(match: MatchPlayback): number {
  return clearStart(match) + (match.reduced ? 0 : matchPopTime(match.runLength, match.runLength - 1));
}

function awardEnd(match: MatchPlayback): number {
  return match.reduced ? clearStart(match) + 420 + 130 * scoreEmphasis(match.points) : flightStart(match);
}

export function awardFrame(match: MatchPlayback, now: number) {
  const age = now - awardStart(match);
  const end = awardEnd(match);
  if (age < 0 || now >= end) return null;
  if (match.reduced) {
    return { alpha: unit(age / 50) * unit((end - now) / 135), scaleX: 1, scaleY: 1 };
  }

  const peak = scorePopPeak(match.points);
  return {
    alpha: 1,
    scaleX: popScale(age, 0.83, peak.x, 34, 82),
    scaleY: popScale(age, 0.74, peak.y, 34, 82),
  };
}

export function comboStartTime(match: MatchPlayback): number {
  return awardStart(match) + (match.reduced ? 0 : COMBO_START_DELAY_MS);
}

export function comboEndTime(match: MatchPlayback): number {
  if (match.combo < 2) return 0;
  return awardEnd(match) + (match.reduced ? 0 : SCORE_FLIGHT_MS * 0.7) + COMBO_EXTRA_MS;
}

export function comboFrame(match: MatchPlayback, now: number, end = comboEndTime(match)) {
  const age = now - comboStartTime(match);
  if (age < 0 || now >= end) return null;
  if (match.reduced) return { alpha: 1, scale: 1 };
  const fade = unit((end - now) / COMBO_FADE_MS);
  return {
    alpha: unit(age / 22) * fade * fade * (3 - 2 * fade),
    scale: popScale(age, 0.9, comboPopPeak(match.combo), 34, 50),
  };
}

function popScale(age: number, start: number, peak: number, riseMs: number, settleMs: number): number {
  if (age < riseMs) return peak - (peak - start) * (1 - unit(age / riseMs)) ** 2;
  return 1 + (peak - 1) * (1 - unit((age - riseMs) / settleMs)) ** 2;
}
