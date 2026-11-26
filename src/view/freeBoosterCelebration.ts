import { Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { BoosterKind } from '../game/boosters';
import { GAME_FONT_FAMILY, gameText } from './gameFont';
import type { Point } from './gestures';
import { BOARD_TOP, VIEW_WIDTH } from './layout';
import { unit } from './movePlayback';

export const FREE_BOOSTER_HOLD_MS = 650;
export const FREE_BOOSTER_FLIGHT_MS = 300;
export const FREE_BOOSTER_LANDING_MS = 180;

const CENTER = VIEW_WIDTH / 2;
const COIN_Y = BOARD_TOP + 40;
const COIN_SIZE = 78;
const CREAM = 0xfff4ce;
const GOLD = 0xffd36f;
const INK = 0x502830;
const NAMES = { joker: 'FREE JOKER', sweep: 'FREE GOLDEN GUST' } as const;

export interface BoosterDropTarget extends Point {
  texture: Texture;
  size: number;
}

export interface BoosterDropLanding {
  kind: BoosterKind;
  glow: number;
  scale: number;
}

function caption(text: string, y: number, fontSize: number, fill: number, label: string): Text {
  return new Text({ text: gameText(text), y, anchor: 0.5, label, style: {
    fontFamily: GAME_FONT_FAMILY, fontSize, fontWeight: '700', fill,
    stroke: { color: INK, width: 2.5, join: 'round' },
  } });
}

export class FreeBoosterCelebration {
  readonly root = new Container({ eventMode: 'none', label: 'free booster celebration', visible: false });
  private readonly banner = new Container({ x: CENTER, y: BOARD_TOP + 82, label: 'free booster banner' });
  private readonly heading = caption('', 19, 38, GOLD, 'free booster title');
  private readonly sugar = new Container({ label: 'gold sugar stars' });
  private readonly coin = new Sprite({ texture: Texture.EMPTY, anchor: 0.5, label: 'awarded medallion' });
  private readonly stars: Graphics[];
  private active: { kind: BoosterKind; target: BoosterDropTarget; started: number; reduced: boolean } | null = null;

  get deadline(): number {
    if (!this.active) return 0;
    const { started, reduced } = this.active;
    return started + FREE_BOOSTER_HOLD_MS + (reduced ? 0 : FREE_BOOSTER_FLIGHT_MS + FREE_BOOSTER_LANDING_MS);
  }

  get animating(): boolean {
    return this.active?.reduced === false;
  }

  constructor() {
    const plaque = new Graphics()
      .roundRect(-167, -24, 334, 69, 23).fill({ color: 0x59302b, alpha: 0.35 })
      .roundRect(-167, -29, 334, 69, 23).fill(INK)
      .stroke({ color: GOLD, width: 2.5 })
      .roundRect(-162, -24, 324, 59, 18).stroke({ color: 0xca8750, width: 1, alpha: 0.85 })
      .star(-146, -5, 4, 5, 1.7).fill(GOLD)
      .star(146, -5, 4, 5, 1.7).fill(GOLD);
    this.banner.addChild(plaque, caption('5× Combo', -7, 20, CREAM, 'free booster combo'), this.heading);
    this.root.addChild(this.sugar, this.banner, this.coin);
    this.stars = Array.from({ length: 12 }, (_, index) => this.sugar.addChild(new Graphics()
      .star(0, 0, 4, index % 3 === 0 ? 7 : 4, index % 3 === 0 ? 2.5 : 1.5)
      .fill(index % 2 === 0 ? CREAM : GOLD).stroke({ color: 0xac602d, width: 0.9 })));
  }

  start(kind: BoosterKind, target: BoosterDropTarget, now: number, reduced: boolean): void {
    this.active = { kind, target, started: now, reduced };
    this.heading.text = NAMES[kind];
    this.heading.scale.set(Math.min(1, 306 / Math.max(1, this.heading.getLocalBounds().width)));
    this.coin.texture = target.texture;
    this.root.visible = true;
  }

  show(now: number): BoosterDropLanding | null {
    if (!this.active) return null;
    if (now >= this.deadline) {
      this.cancel();
      return null;
    }
    const { started, kind, target, reduced } = this.active;
    const age = Math.max(0, now - started);
    const travel = age - FREE_BOOSTER_HOLD_MS;
    this.banner.alpha = 1 - unit(travel / 115);
    this.banner.visible = this.banner.alpha > 0;
    this.sugar.visible = !reduced && age < 410;
    this.coin.visible = travel < FREE_BOOSTER_FLIGHT_MS;
    if (travel < 0) {
      this.coin.position.set(CENTER, COIN_Y);
      const pop = reduced ? 0 : Math.sin(Math.PI * unit(age / 180));
      this.coin.width = this.coin.height = COIN_SIZE * (1 + 0.09 * pop);
      this.coin.rotation = 0;
      if (this.sugar.visible) this.showSugar(age);
      return reduced ? { kind, glow: 0.95, scale: 1 } : null;
    }
    if (travel < FREE_BOOSTER_FLIGHT_MS) {
      const t = (travel / FREE_BOOSTER_FLIGHT_MS) ** 1.15;
      const u = 1 - t;
      // Curve left before moving down the board, then arrive at the actual footer center.
      this.coin.position.set(
        CENTER * u ** 3 - 3 * 14 * u ** 2 * t + 3 * 24 * u * t ** 2 + target.x * t ** 3,
        COIN_Y * u ** 3 + 3 * (COIN_Y + 5) * u ** 2 * t + 3 * (target.y - 93) * u * t ** 2 + target.y * t ** 3,
      );
      this.coin.width = this.coin.height = COIN_SIZE + (target.size - COIN_SIZE) * t;
      this.coin.rotation = -0.33 * Math.sin(Math.PI * t);
      return null;
    }
    const landing = (travel - FREE_BOOSTER_FLIGHT_MS) / FREE_BOOSTER_LANDING_MS;
    return { kind, glow: 1 - landing, scale: 1 + 0.14 * Math.sin(Math.PI * landing) };
  }

  cancel(kind?: BoosterKind): boolean {
    if (!this.active || (kind && this.active.kind !== kind)) return false;
    this.active = null;
    this.root.visible = false;
    this.coin.texture = Texture.EMPTY;
    return true;
  }

  private showSugar(age: number): void {
    this.stars.forEach((star, index) => {
      const time = unit((age - index % 3 * 22) / 360);
      const spread = 1 - (1 - time) ** 2;
      const angle = index * 2.399963;
      star.visible = time > 0 && time < 1;
      star.position.set(CENTER + Math.cos(angle) * (26 + (67 + index % 3 * 12) * spread),
        Math.max(BOARD_TOP + 9, COIN_Y + Math.sin(angle) * (21 + 40 * spread) + 29 * time ** 2));
      star.rotation = angle + spread;
      star.alpha = 1 - time;
    });
  }
}
