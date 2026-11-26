import type { Point, Target } from './gestures';

export interface Rect extends Point {
  width: number;
  height: number;
}

export interface StackSlot {
  x: number;
  base: number;
  hit: Rect;
}

export type StackLayout = ReturnType<typeof layoutStacks>;

export const VIEW_WIDTH = 400;
export const BOARD_TOP = 141;
const FOOTER_CENTER_FROM_BOTTOM = 56;
export const BOARD_FOOTER_SPACE = FOOTER_CENTER_FROM_BOTTOM + 30;
export const FOOTER_TARGET_SIZE = 44;
export const STACK_LIFT = 6;

const BOARD_LEFT = 62;
const BOARD_RIGHT = VIEW_WIDTH - 13;
export const BOARD_CENTER = (BOARD_LEFT + BOARD_RIGHT) / 2;
const BASE_HIT_DEPTH = 20;
const ROW_PADDING = 5;
const DONUT_ASPECT = 320 / 430;
const DONUT_STEP_RATIO = 0.52 * 0.92;
const TAP_SLOP = 14;
const SWIPE_SLOP = 22;

export type HitMode = 'exact' | 'tap' | 'swipe';

export function footerCenterY(height: number): number {
  return height - FOOTER_CENTER_FROM_BOTTOM;
}

export function viewport(width: number, height: number, safeAreaBottom = 0) {
  const usableHeight = Math.max(1, height - Math.max(0, safeAreaBottom));
  const scale = Math.min(Math.max(1, width) / VIEW_WIDTH, usableHeight / 540, 1.6);
  const contentHeight = Math.min(usableHeight / scale, 870);
  return {
    scale,
    height: contentHeight,
    x: (width - VIEW_WIDTH * scale) / 2,
    y: (usableHeight - contentHeight * scale) / 2,
  };
}

export function layoutStacks(height: number, count: number, capacity = Math.min(10, count + 3)) {
  // Compute two-row formations from the lower row up.
  const rows = count < 5 ? [count] : [Math.floor(count / 2), Math.ceil(count / 2)];
  const rowHeight = (height - BOARD_TOP - BOARD_FOOTER_SPACE) / rows.length;
  const cellWidth = (BOARD_RIGHT - BOARD_LEFT) / Math.max(...rows);
  // Five stacks use their current capacity. Other formations reserve their next capacity.
  const maxCapacity = count === 5 ? capacity : Math.min(10, count + 3);
  const stackHeightRatio = DONUT_ASPECT * (1 + (maxCapacity - 1) * DONUT_STEP_RATIO);
  const usableRowHeight = rowHeight - ROW_PADDING * 2 - STACK_LIFT - BASE_HIT_DEPTH;
  const donutWidth = Math.min(cellWidth - 8, usableRowHeight / stackHeightRatio);
  const donutHeight = donutWidth * DONUT_ASPECT;
  const step = donutHeight * DONUT_STEP_RATIO;
  const stackHeight = donutHeight + (maxCapacity - 1) * step;
  const typicalStackHeight = donutHeight + (stackHeight - donutHeight) * 0.75;
  const centeredBase = (rowHeight + typicalStackHeight + STACK_LIFT - BASE_HIT_DEPTH) / 2;
  const rowSlots: StackSlot[] = rows.flatMap((columns, index) => {
    const rowTop = BOARD_TOP + (rows.length - 1 - index) * rowHeight;
    const base = rowTop + Math.max(centeredBase, ROW_PADDING + STACK_LIFT + stackHeight);
    const rowLeft = BOARD_CENTER - columns * cellWidth / 2;
    return Array.from({ length: columns }, (_, column) => {
      const left = rowLeft + column * cellWidth;
      return {
        x: left + cellWidth / 2,
        base,
        hit: { x: left, y: rowTop, width: cellWidth, height: rowHeight },
      };
    });
  });
  // Give stack zero the leftmost column in both formations so it can move down at six.
  const slots = count === 5 ? [rowSlots[2], rowSlots[0], rowSlots[1], rowSlots[3], rowSlots[4]] : rowSlots;
  return { slots, donutWidth, donutHeight, step };
}

export function stackHit(slot: StackSlot, capacity: number, donutHeight: number, step: number): Rect {
  const top = slot.base - Math.max(0, capacity - 1) * step;
  const y = Math.max(slot.hit.y, Math.min(slot.base - 46, top - donutHeight - STACK_LIFT - 5));
  const bottom = Math.min(slot.hit.y + slot.hit.height, slot.base + BASE_HIT_DEPTH);
  return { ...slot.hit, y, height: bottom - y };
}

export function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width &&
    point.y >= rect.y && point.y < rect.y + rect.height;
}

export function stackTarget(stacks: readonly { hit: Rect }[], point: Point, height: number, mode: HitMode): Target {
  if (point.x < BOARD_LEFT || point.x >= BOARD_RIGHT ||
      point.y < BOARD_TOP || point.y >= height - BOARD_FOOTER_SPACE) return 'outside';

  const exact = stacks.findIndex(({ hit }) => contains(hit, point));
  if (exact >= 0) return exact;
  if (mode === 'exact') return null;

  const slop = mode === 'tap' ? TAP_SLOP : SWIPE_SLOP;
  let nearby: number | null = null;
  for (let index = 0; index < stacks.length; index++) {
    const hit = stacks[index].hit;
    const dx = Math.max(hit.x - point.x, point.x - (hit.x + hit.width), 0);
    const dy = Math.max(hit.y - point.y, point.y - (hit.y + hit.height), 0);
    if (dx * dx + dy * dy > slop * slop) continue;
    if (nearby !== null) return null;
    nearby = index;
  }
  return nearby;
}
