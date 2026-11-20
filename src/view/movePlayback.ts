import type { DoughInsert } from '../game';
import type { Point } from './gestures';

export const FLIGHT_MS = 170;
export const LAND_MS = 116;
const INSERT_SPACING = 116;
const STACK_STAGGER = 34;
const INSERT_MS = 168;
const REDUCED_INSERT_MS = 150;

interface PieceMotion {
  depth: number;
  entry?: number;
  bumps: number[];
}

export function refillPlan(stackSizes: readonly number[], inserts: readonly DoughInsert[]) {
  const stacks = new Map<number, PieceMotion[]>();
  const counts = new Map<number, number>();
  for (const { stack } of inserts) counts.set(stack, (counts.get(stack) ?? 0) + 1);
  for (const [stack, count] of counts) {
    stacks.set(stack, Array.from({ length: stackSizes[stack] - count }, (_, depth) => ({ depth, bumps: [] })));
  }
  // Replay inserts by index so adjacent donuts of the same color keep their identities.
  const lastEntry = new Map<number, number>();
  let entry = -STACK_STAGGER;
  for (const { stack, depth } of inserts) {
    const pieces = stacks.get(stack)!;
    entry = Math.max(entry + STACK_STAGGER, (lastEntry.get(stack) ?? -INSERT_SPACING) + INSERT_SPACING);
    lastEntry.set(stack, entry);
    for (let index = depth; index < pieces.length; index++) pieces[index].bumps.push(entry);
    pieces.splice(depth, 0, { depth, entry, bumps: [] });
  }
  return { stacks, duration: inserts.length ? entry + INSERT_MS : 0 };
}

export function unit(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function easeOut(value: number): number {
  return 1 - (1 - value) ** 3;
}

export function flightPosition(start: Point, end: Point, progress: number, arc: number): Point {
  const travel = 1 - (1 - progress) ** 2;
  return {
    x: start.x + (end.x - start.x) * travel,
    y: start.y + (end.y - start.y) * travel - Math.sin(Math.PI * progress) * arc,
  };
}

export function landingSquash(age: number): number {
  const impact = unit(age / 27);
  const settle = unit((age - 27) / (LAND_MS - 27));
  return impact * (1 - settle) ** 2;
}

export function refillDuration(duration: number, reduced: boolean): number {
  return reduced && duration ? REDUCED_INSERT_MS : duration;
}

function refillRise(elapsed: number): number {
  const lift = unit(elapsed / 96);
  const settle = unit((elapsed - 78) / (INSERT_MS - 78));
  return easeOut(lift) + Math.sin(settle * Math.PI) * (1 - settle) * 0.16;
}

export function refillFrame(piece: PieceMotion, finalDepth: number, age: number, reduced: boolean) {
  const entryAge = piece.entry === undefined ? INSERT_MS : age - (reduced ? 0 : piece.entry);
  if (reduced) {
    if (age < 0) {
      return { depth: piece.depth, alpha: piece.entry === undefined ? 1 : 0, scaleX: 1, scaleY: 1, accent: 0 };
    }
    return {
      depth: finalDepth, alpha: 0.6 + 0.4 * unit(entryAge / 90),
      scaleX: 1, scaleY: 1, accent: 0.75 * (1 - unit(entryAge / REDUCED_INSERT_MS)),
    };
  }
  const depth = piece.bumps.reduce((depth, entry) => depth + refillRise(age - entry), piece.depth);
  const appear = easeOut(unit(entryAge / 94));
  const squash = 1 - easeOut(unit(entryAge / 120));
  const rebound = Math.sin(unit((entryAge - 56) / (INSERT_MS - 56)) * Math.PI);
  const accent = unit(entryAge / 34) * (1 - unit((entryAge - 62) / (INSERT_MS - 62))) ** 2;
  return { depth, alpha: appear, scaleX: 1 + 0.05 * squash - 0.03 * rebound,
    scaleY: 1 - 0.28 * squash + 0.045 * rebound, accent };
}
