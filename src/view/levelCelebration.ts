import { Container, Graphics, Text } from 'pixi.js';
import { BOARD_FOOTER_SPACE, BOARD_TOP, type Rect, VIEW_WIDTH } from './layout';
import { unit } from './movePlayback';

export const LEVEL_CELEBRATION_MS = 1040;

export type BoardUpgrade = { kind: 'slots'; previousCapacity: number; capacity: number }
  | { kind: 'stack'; firstNewStack: number; stackCount: number };

export interface LevelCelebrationDetails {
  level: number;
  rank: string;
  upgrade?: BoardUpgrade;
}

const CREAM = 0xfff5d9;
const HONEY = 0xffcc5a;
const TOAST = 0x71351e;
const CENTER = VIEW_WIDTH / 2;

function title(size: number, color: number, y: number, stroke: number): Text {
  return new Text({ text: '', y, anchor: 0.5, style: {
    fontFamily: ['Reborn Fredoka', 'Trebuchet MS', 'sans-serif'], fontWeight: '700', fontSize: size,
    fill: color, stroke: { color: TOAST, width: stroke, join: 'round' }, align: 'center',
  } });
}

function setTitle(text: Text, value: string, width: number): void {
  text.text = value;
  text.scale.set(Math.min(1, width / Math.max(1, text.getLocalBounds().width)));
}

export class LevelCelebration {
  readonly root = new Container({ eventMode: 'none', visible: false });
  private readonly focus = new Graphics();
  private readonly rays = new Container();
  private readonly sugar = new Container();
  private readonly hero = new Container();
  private readonly heading = title(43, HONEY, 0, 4.5);
  private readonly upgrade = title(15, 0xffe3a7, 21, 2.5);
  private readonly plaque = new Graphics();
  private readonly stars: Graphics[];
  private active: { started: number; reduced: boolean; height: number; y: number } | null = null;

  get animating(): boolean {
    return this.active !== null;
  }

  constructor() {
    this.root.addChild(this.focus, this.rays, this.sugar, this.hero);
    this.hero.addChild(this.plaque, this.heading, this.upgrade);
    for (let index = 0; index < 12; index++) {
      const length = index % 2 ? 115 : 136;
      const ray = new Graphics().poly([22, -2, length, -13, length, 13, 22, 2])
        .fill({ color: index % 3 ? HONEY : CREAM, alpha: index % 2 ? 0.54 : 0.85 });
      ray.rotation = index * Math.PI / 6;
      this.rays.addChild(ray);
    }
    this.stars = Array.from({ length: 20 }, (_, index) => this.sugar.addChild(new Graphics()
      .star(0, 0, index % 3 ? 4 : 5, index % 4 ? 5 : 8, index % 4 ? 2 : 3)
      .fill(index % 3 ? CREAM : HONEY).stroke({ color: 0xc46a25, width: 1 })));
  }

  start(details: LevelCelebrationDetails, markers: readonly Rect[], now: number, reduced: boolean, height: number): void {
    const { level, upgrade } = details;
    let text = '';
    if (upgrade?.kind === 'stack') text = upgrade.stackCount - upgrade.firstNewStack === 1 ? 'New stack' : 'New stacks';
    if (upgrade?.kind === 'slots') {
      const extra = upgrade.capacity - upgrade.previousCapacity;
      text = `+${extra} ${extra === 1 ? 'slot' : 'slots'} per stack`;
    }
    setTitle(this.heading, `Level ${level}`, 244);
    setTitle(this.upgrade, text, 240);
    this.heading.y = text ? -12 : 0;
    this.upgrade.visible = !!text;
    const halfHeight = text ? 43 : 36;
    this.plaque.clear()
      .roundRect(-141, 5 - halfHeight, 282, halfHeight * 2, 24).fill({ color: 0x64301f, alpha: 0.38 })
      .roundRect(-141, -halfHeight, 282, halfHeight * 2, 24).fill({ color: 0x71351e, alpha: 0.95 })
      .stroke({ color: HONEY, width: 2.8 })
      .roundRect(-135, 6 - halfHeight, 270, halfHeight * 2 - 12, 20)
      .stroke({ color: 0xf6a45d, width: 1, alpha: 0.65 });

    this.focus.clear();
    for (const { x, y, width, height } of markers) {
      this.focus.roundRect(x, y, width, height, Math.min(8, height / 2))
        .fill({ color: HONEY, alpha: 0.27 }).stroke({ color: TOAST, width: 4 })
        .stroke({ color: HONEY, width: 2.2 });
    }
    const y = BOARD_TOP + Math.min(142, (height - BOARD_FOOTER_SPACE - BOARD_TOP) * 0.39);
    this.active = { started: now, reduced, height, y };
    this.rays.position.set(CENTER, y);
    this.hero.position.set(CENTER, y);
    this.rays.visible = this.sugar.visible = !reduced;
    this.show(now);
  }

  show(now: number): void {
    if (!this.active) return;
    const { started, reduced, height, y } = this.active;
    const age = Math.max(0, now - started);
    if (age >= LEVEL_CELEBRATION_MS) {
      this.cancel();
      return;
    }

    this.root.visible = true;
    this.root.alpha = 1 - unit((age - 820) / (LEVEL_CELEBRATION_MS - 820));
    const entry = 1 - unit(age / 215);
    this.hero.scale.set(reduced ? 1 : 1 + 1.7 * entry ** 2 - 2.04 * entry ** 3);
    this.focus.alpha = reduced ? 1 : 0.76 + 0.24 * (1 - unit(age / 300));
    if (reduced) return;

    this.rays.scale.set(0.78 + 0.22 * (1 - entry));
    this.rays.rotation = age / 3300;
    this.rays.alpha = 0.28 + 0.4 * (1 - unit(age / 580));
    this.stars.forEach((star, index) => {
      const delay = (index % 5) * 27;
      const time = unit((age - delay) / 940);
      const angle = index * 2.399963;
      const radius = 71 + (1 - (1 - time) ** 2) * (79 + index % 4 * 8);
      star.visible = age >= delay;
      star.position.set(CENTER + Math.cos(angle) * radius,
        Math.min(height - BOARD_FOOTER_SPACE - 9, Math.max(BOARD_TOP + 9, y + Math.sin(angle) * radius * 0.78)));
      star.rotation = angle + time * (index % 2 ? 1.5 : -1.5);
      star.scale.set(0.65 + 0.55 * Math.sin(time * Math.PI));
      star.alpha = 1 - 0.8 * time;
    });
  }

  cancel(): void {
    this.active = null;
    this.root.visible = false;
  }
}
