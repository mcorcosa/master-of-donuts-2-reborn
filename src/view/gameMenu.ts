import { viewport, type Rect } from './layout';

export const COMPACT_COMMERCE_MAX_WIDTH = 840;

const CONTROL_SIZE = 44;
const CONTROL_GAP = 8;
const WORDMARK_CENTER_Y = 49;
const WORDMARK_SIDE_GUTTER = 59;

export const GAME_MENU_LABELS = {
  menu: 'Game menu',
  sound: 'Sound effects',
  soundOn: 'On',
  soundOff: 'Off',
  resume: 'Resume',
  title: 'Game Menu',
};

export interface SafeArea {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

export function layoutGameMenu(width: number, height: number, safeArea: SafeArea, commerceMounted: boolean) {
  const compactCommerce = commerceMounted && width <= COMPACT_COMMERCE_MAX_WIDTH;
  const commerceTop = Math.max(6, safeArea.top);
  const boardTop = compactCommerce ? Math.min(Math.max(0, height - 1), commerceTop + CONTROL_SIZE + 7) : 0;
  const fit = viewport(width, height - boardTop, safeArea.bottom);
  const standardTop = Math.max(6, safeArea.top + 4, fit.y + WORDMARK_CENTER_Y * fit.scale - CONTROL_SIZE / 2);
  const gutter = fit.x + Math.max(4, (WORDMARK_SIDE_GUTTER * fit.scale - CONTROL_SIZE) / 2);
  const makeControl = (x: number, y: number): Rect => ({ x, y, width: CONTROL_SIZE, height: CONTROL_SIZE });
  const commerceLeft = Math.max(CONTROL_GAP, safeArea.left);
  const menu = compactCommerce
    ? makeControl(commerceLeft, commerceTop)
    : makeControl(Math.max(gutter, safeArea.left + 4), standardTop);
  const sound = compactCommerce
    ? makeControl(commerceLeft + CONTROL_SIZE + CONTROL_GAP, commerceTop)
    : makeControl(Math.max(0, width - Math.max(gutter, safeArea.right + 4) - CONTROL_SIZE), standardTop);
  return { boardTop, menuLayout: { width, height, menu, sound } };
}
