import type { Point } from './gestures';

export interface Rect extends Point {
  width: number;
  height: number;
}

export interface StackSlot {
  x: number;
  base: number;
  hit: Rect;
}

export const VIEW_WIDTH = 400;
export const BOARD_TOP = 124;
export const BOARD_FOOTER_SPACE = 94;
export const STACK_LIFT = 6;

const BOARD_INSET = 12;
const BASE_HIT_DEPTH = 20;
const ROW_PADDING = 5;
const DONUT_ASPECT = 320 / 430;
const WIDTH_FIT_STEP_RATIO = 0.28;
const MAX_STEP_RATIO = 0.52;
const STEP_SCALE = 0.85;

export function viewport(width: number, height: number) {
  const scale = Math.min(Math.max(1, width) / VIEW_WIDTH, Math.max(1, height) / 540, 1.6);
  const contentHeight = Math.min(height / scale, 740);
  return {
    scale,
    height: contentHeight,
    x: (width - VIEW_WIDTH * scale) / 2,
    y: (height - contentHeight * scale) / 2,
  };
}

export function layoutStacks(height: number, count: number) {
  // The game numbers the lower row first when it splits a formation.
  const rows = count < 6 ? [count] : [Math.floor(count / 2), Math.ceil(count / 2)];
  const rowHeight = (height - BOARD_TOP - BOARD_FOOTER_SPACE) / rows.length;
  const cellWidth = (VIEW_WIDTH - BOARD_INSET * 2) / Math.max(...rows);
  // Reserve the last capacity reached at this stack count to keep upgrades stable.
  const maxCapacity = Math.min(10, count + 3);
  const stackHeightRatio = DONUT_ASPECT * (1 + (maxCapacity - 1) * WIDTH_FIT_STEP_RATIO);
  const usableRowHeight = rowHeight - ROW_PADDING * 2 - STACK_LIFT - BASE_HIT_DEPTH;
  const donutWidth = Math.min(cellWidth - 8, usableRowHeight / stackHeightRatio);
  const donutHeight = donutWidth * DONUT_ASPECT;
  const availableStep = (usableRowHeight - donutHeight) / (maxCapacity - 1);
  const step = STEP_SCALE * Math.min(donutHeight * MAX_STEP_RATIO, availableStep);
  const stackHeight = donutHeight + (maxCapacity - 1) * step;
  const typicalStackHeight = donutHeight + (stackHeight - donutHeight) * 0.75;
  const centeredBase = (rowHeight + typicalStackHeight + STACK_LIFT - BASE_HIT_DEPTH) / 2;
  const slots: StackSlot[] = rows.flatMap((columns, index) => {
    const rowTop = BOARD_TOP + (rows.length - 1 - index) * rowHeight;
    const base = rowTop + Math.max(centeredBase, ROW_PADDING + STACK_LIFT + stackHeight);
    const rowLeft = (VIEW_WIDTH - columns * cellWidth) / 2;
    return Array.from({ length: columns }, (_, column) => {
      const left = rowLeft + column * cellWidth;
      return {
        x: left + cellWidth / 2,
        base,
        hit: { x: left, y: rowTop, width: cellWidth, height: rowHeight },
      };
    });
  });
  return { slots, donutWidth, donutHeight, step };
}

export function stackHit(slot: StackSlot, count: number, donutHeight: number, step: number): Rect {
  const top = slot.base - Math.max(0, count - 1) * step;
  const y = Math.max(slot.hit.y, Math.min(slot.base - 46, top - donutHeight - STACK_LIFT - 5));
  return { ...slot.hit, y, height: slot.base + BASE_HIT_DEPTH - y };
}

export function contains(rect: Rect, point: Point): boolean {
  return point.x >= rect.x && point.x < rect.x + rect.width &&
    point.y >= rect.y && point.y < rect.y + rect.height;
}
