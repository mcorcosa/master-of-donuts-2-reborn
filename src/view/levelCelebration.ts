import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import { GAME_FONT_FAMILY, gameText } from './gameFont';
import { BOARD_CENTER, BOARD_FOOTER_SPACE, BOARD_TOP, type Rect } from './layout';
import { unit } from './movePlayback';

export const LEVEL_CELEBRATION_MS = 2000;

export type BoardUpgrade = { kind: 'slots'; previousCapacity: number; capacity: number }
  | { kind: 'stack'; firstNewStack: number; stackCount: number };

export interface LevelCelebrationDetails {
  level: number;
  rank: string;
  movesRestored?: number;
  upgrade?: BoardUpgrade;
}

const CREAM = 0xfff3d7;
const BURGUNDY = 0x731328;
const BUTTER = 0xfec40b;
const MEDALLION_WIDTH = 142;
const MEDALLION_HEIGHT = 148;
const SUPPORT_WIDTH = 216;
const SETTLE_MS = 320;
const FADE_OUT_AT = 1760;
const SUGAR_MS = 740;
const number = new Intl.NumberFormat();

const SUGAR = [
  { x: -76, y: -49, dx: -21, dy: -9, tilt: -0.18, glint: true },
  { x: 74, y: -40, dx: 24, dy: -10, tilt: 0.18, glint: true },
  { x: -91, y: 18, dx: -16, dy: 4, tilt: 0.52, glint: false },
  { x: 91, y: 23, dx: 15, dy: 5, tilt: -0.52, glint: false },
  { x: -66, y: 47, dx: -18, dy: 12, tilt: 0.11, glint: true },
  { x: 69, y: 45, dx: 15, dy: 10, tilt: -0.15, glint: true },
  { x: -56, y: -68, dx: -10, dy: -9, tilt: -0.40, glint: false },
  { x: 55, y: -66, dx: 11, dy: -10, tilt: 0.40, glint: false },
] as const;

function caption(name: string, size: number, fill: number, y = 0): Text {
  return new Text({ label: name, text: '', y, anchor: 0.5, style: {
    fontFamily: GAME_FONT_FAMILY, fontWeight: '700', fontSize: size, fill,
  } });
}

function fit(text: Text, value: string, width: number): void {
  text.text = gameText(value);
  text.scale.set(Math.min(1, width / Math.max(1, text.getLocalBounds().width)));
}

function upgradeCaption(upgrade?: BoardUpgrade): string {
  if (!upgrade) return '';
  if (upgrade.kind === 'stack') return upgrade.stackCount - upgrade.firstNewStack === 1 ? 'New stack' : 'New stacks';
  const extra = upgrade.capacity - upgrade.previousCapacity;
  return `+${extra} ${extra === 1 ? 'slot' : 'slots'} per stack`;
}

function moveCaption(restored?: number): string {
  if (restored === undefined) return '';
  if (restored === 0) return 'Moves full';
  return `+${restored} ${restored === 1 ? 'move' : 'moves'}`;
}

function sugarPiece(glint: boolean): Graphics {
  const piece = new Graphics();
  if (!glint) return piece.roundRect(-4.5, -1.8, 9, 3.6, 1.8).fill(BUTTER)
    .roundRect(-3.2, -1.4, 5.5, 1, 0.5).fill(CREAM);
  return piece.moveTo(0, -7).quadraticCurveTo(1, -1, 7, 0)
    .quadraticCurveTo(1, 1, 0, 7).quadraticCurveTo(-1, 1, -7, 0)
    .quadraticCurveTo(-1, -1, 0, -7).closePath()
    .fill(0xfffcf1).stroke({ color: BUTTER, width: 1.2, alpha: 0.72 });
}

function stackCorners(focus: Graphics, { x, y, width, height }: Rect): void {
  const length = Math.min(18, width / 4, height / 4);
  const corner = 5;
  const right = x + width;
  const bottom = y + height;
  focus.moveTo(x, y + length).lineTo(x, y + corner).quadraticCurveTo(x, y, x + corner, y).lineTo(x + length, y)
    .moveTo(right - length, y).lineTo(right - corner, y).quadraticCurveTo(right, y, right, y + corner).lineTo(right, y + length)
    .moveTo(right, bottom - length).lineTo(right, bottom - corner).quadraticCurveTo(right, bottom, right - corner, bottom)
    .lineTo(right - length, bottom)
    .moveTo(x + length, bottom).lineTo(x + corner, bottom).quadraticCurveTo(x, bottom, x, bottom - corner).lineTo(x, bottom - length);
}

export class LevelCelebration {
  readonly root = new Container({ eventMode: 'none', visible: false, label: 'level-up celebration' });
  private readonly focus = new Graphics({ label: 'upgrade focus' });
  private readonly sugar = new Container({ label: 'sugar glints and sprinkles' });
  private readonly hero = new Container({ label: 'level-up pastry' });
  private readonly supportBiscuit: Sprite;
  private readonly heading = caption('level label', 22, CREAM, -32);
  private readonly level = caption('level numeral', 51, CREAM, 17);
  private readonly recovery = caption('moves restored', 21, BURGUNDY);
  private readonly upgrade = caption('board upgrade', 17, BURGUNDY);
  private readonly particles = SUGAR.map(({ glint, tilt }) => {
    const piece = this.sugar.addChild(sugarPiece(glint));
    piece.rotation = tilt;
    return piece;
  });
  private active: { started: number; reduced: boolean; y: number } | null = null;

  get animating(): boolean {
    return this.active !== null;
  }

  constructor(jamCookie: Texture, vanillaBiscuit: Texture) {
    const medallion = new Sprite({ texture: jamCookie, anchor: 0.5, width: MEDALLION_WIDTH, height: MEDALLION_HEIGHT });
    this.supportBiscuit = new Sprite({ texture: vanillaBiscuit, anchor: 0.5, width: SUPPORT_WIDTH });
    this.heading.text = gameText('Level');
    this.heading.style.dropShadow = { color: '#511023', alpha: 0.58, blur: 1.7, angle: Math.PI / 2, distance: 1.6 };
    this.level.style.dropShadow = this.heading.style.dropShadow;
    this.hero.addChild(medallion, this.supportBiscuit, this.heading, this.level, this.recovery, this.upgrade);
    this.root.addChild(this.focus, this.sugar, this.hero);
    this.root.once('destroyed', () => { this.active = null; });
  }

  start(details: LevelCelebrationDetails, markers: readonly Rect[], now: number, reduced: boolean, height: number): void {
    const { level, upgrade, movesRestored } = details;
    const recovery = moveCaption(movesRestored);
    const change = upgradeCaption(upgrade);
    const twoLines = !!recovery && !!change;
    fit(this.level, number.format(level), 103);
    fit(this.recovery, recovery, 163);
    fit(this.upgrade, change, 169);
    this.recovery.visible = !!recovery;
    this.upgrade.visible = !!change;
    this.supportBiscuit.visible = this.recovery.visible || this.upgrade.visible;
    this.supportBiscuit.height = twoLines ? 68 : 54;
    this.supportBiscuit.y = MEDALLION_HEIGHT / 2 + this.supportBiscuit.height / 2;
    this.recovery.y = this.supportBiscuit.y + (twoLines ? -15 : -4);
    this.upgrade.y = this.supportBiscuit.y + (twoLines ? 10 : -4);

    this.focus.clear();
    for (const marker of markers) {
      if (upgrade?.kind === 'stack') stackCorners(this.focus, marker);
      else this.focus.roundRect(marker.x, marker.y, marker.width, marker.height, marker.height / 2);
    }
    if (markers.length) this.focus.stroke({ color: BUTTER, width: 3.4, alpha: 0.63, cap: 'round' })
      .stroke({ color: 0xfffbea, width: 1.35, alpha: 0.94, cap: 'round' });

    const boardHeight = height - BOARD_FOOTER_SPACE - BOARD_TOP;
    const y = BOARD_TOP + Math.min(138, Math.max(92, boardHeight * 0.25));
    this.active = { started: now, reduced, y };
    this.sugar.position.set(BOARD_CENTER, y);
    this.show(now);
  }

  show(now: number): void {
    if (!this.active) return;
    const { started, reduced, y } = this.active;
    const age = Math.max(0, now - started);
    if (age >= LEVEL_CELEBRATION_MS) {
      this.cancel();
      return;
    }
    this.root.visible = true;
    const fade = unit((age - FADE_OUT_AT) / (LEVEL_CELEBRATION_MS - FADE_OUT_AT));
    this.root.alpha = 1 - fade * fade * (3 - 2 * fade);

    const travel = 1 - unit(age / SETTLE_MS);
    this.hero.position.set(BOARD_CENTER, y + (reduced ? 0 : 7 * travel ** 3));
    this.hero.scale.set(reduced ? 1 : 1 + travel ** 2 * (0.40 - 0.51 * travel));
    this.focus.alpha = reduced ? 0.88 : 0.72 + 0.23 * (1 - unit(age / 480));
    this.sugar.visible = !reduced && age < SUGAR_MS;
    if (!this.sugar.visible) return;

    this.particles.forEach((piece, index) => {
      const { x, y, dx, dy } = SUGAR[index];
      const local = age - 36 - (index % 4) * 24;
      const progress = unit(local / 540);
      const drift = 1 - (1 - progress) ** 2;
      piece.position.set(x + dx * drift, y + dy * drift + 7 * progress ** 2);
      piece.alpha = 0.94 * unit(local / 88) * (1 - unit((local - 260) / 280));
      piece.scale.set(0.72 + 0.28 * unit(local / 195));
    });
  }

  cancel(): void {
    this.active = null;
    this.root.visible = false;
  }
}
