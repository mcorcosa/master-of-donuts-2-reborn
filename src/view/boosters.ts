import { Container, Graphics, Sprite, Text, type Texture } from 'pixi.js';
import { createBoosterMedallion, MEDALLION_ART_SIZE } from './boosterMedallion';
import type { BoosterDropLanding, BoosterDropTarget } from './freeBoosterCelebration';
import type { BoosterButton, Point } from './gestures';
import { BOARD_FOOTER_SPACE, contains } from './layout';
import { unit } from './movePlayback';

const BUTTONS = [
  { kind: 'joker', x: 40 },
  { kind: 'sweep', x: 98 },
] as const;
const MEDALLION_SCALE = 1.25;
const MEDALLION_SIZE = MEDALLION_ART_SIZE * MEDALLION_SCALE;
const RING_RADIUS = 20.9;
const BADGE_INK = 0x572947;

export interface BoosterButtonView {
  mode: 'ad' | 'charging' | 'locked' | 'loading' | 'free' | 'held';
  usable: boolean;
}

export interface BoosterFooterView {
  joker: BoosterButtonView;
  sweep: BoosterButtonView;
  progress: number;
  armed: boolean;
  visible: boolean;
  adUnavailable: boolean;
}

function medallionButton(parent: Container, kind: BoosterButton, x: number, jokerArt: Texture) {
  const root = parent.addChild(new Container({ x, y: 13, label: kind }));
  const armed = kind === 'joker' ? root.addChild(new Graphics({ visible: false })
    .circle(0, -0.25, 22.1).stroke({ color: 0xffd678, width: 4.4, alpha: 0.46 })
    .circle(0, -0.25, 22.1).stroke({ color: 0xfff8d1, width: 1.5 })) : undefined;
  const texture = createBoosterMedallion(kind, jokerArt);
  const face = root.addChild(new Sprite({ texture, anchor: 0.5 }));
  face.width = face.height = MEDALLION_SIZE;
  const glow = root.addChild(new Graphics({ visible: false, label: 'free booster landing glow' })
    .circle(0, -0.6, 21).stroke({ color: 0xffbe50, width: 3.8, alpha: 0.65 })
    .circle(0, -0.6, 21).stroke({ color: 0xfff5be, width: 1.6 }));
  const meter = root.addChild(new Container({ visible: false }));
  meter.addChild(new Graphics().circle(0, 0, RING_RADIUS).stroke({ color: 0x70452d, width: 1.55, alpha: 0.62 }));
  const progress = meter.addChild(new Graphics());

  const badge = root.addChild(new Container({ x: 13.5, y: -12 }));
  badge.scale.set(MEDALLION_SCALE);
  const play = badge.addChild(new Graphics().circle(0, 0, 5).fill(0x542a2c)
    .stroke({ color: 0xfff4d9, width: 0.6 })
    .circle(0, -0.25, 4.3).fill(0xfff6dd)
    .poly([-1.05, -2.45, 2.24, -0.26, -1.05, 1.87]).fill(BADGE_INK));
  const tag = badge.addChild(new Container());
  tag.addChild(new Graphics().roundRect(-11, -5.6, 22, 11.2, 4.1).fill(0xfff6dd)
    .stroke({ color: 0x70452d, width: 0.85 }));
  const badgeText = tag.addChild(new Text({ text: '', anchor: 0.5, style: {
    fontFamily: ['Reborn Fredoka', 'Trebuchet MS', 'sans-serif'], fontSize: 8, fontWeight: '700', fill: BADGE_INK,
  } }));
  return { kind, root, texture, face, glow, armed, meter, progress, badge, play, tag, badgeText, fill: 0,
    bounds: { x: x - 28, y: -8, width: 56, height: BOARD_FOOTER_SPACE + 8 } };
}

export class BoosterControls {
  readonly root = new Container({ eventMode: 'none' });
  private readonly buttons: ReturnType<typeof medallionButton>[];

  constructor(jokerArt: Texture) {
    this.buttons = BUTTONS.map(({ kind, x }) => medallionButton(this.root, kind, x, jokerArt));
    this.root.once('destroyed', () => {
      for (const button of this.buttons) button.texture.destroy(true);
    });
  }

  resize(height: number): void {
    this.root.y = height - BOARD_FOOTER_SPACE;
  }

  dropTarget(kind: BoosterButton): BoosterDropTarget {
    const { root, texture } = this.buttons.find(button => button.kind === kind)!;
    return { x: this.root.x + root.x, y: this.root.y + root.y, texture, size: MEDALLION_SIZE };
  }

  showDropLanding(landing: BoosterDropLanding | null): void {
    for (const { kind, face, glow } of this.buttons) {
      const pulse = landing?.kind === kind ? landing : null;
      if (!pulse && !glow.visible) continue;
      glow.visible = pulse !== null;
      glow.alpha = pulse?.glow ?? 0;
      face.width = face.height = MEDALLION_SIZE * (pulse?.scale ?? 1);
    }
  }

  show(view: BoosterFooterView): void {
    this.root.visible = view.visible;
    for (const button of this.buttons) {
      const { mode, usable } = view[button.kind];
      button.face.alpha = usable ? 1 : 0.46;
      if (button.armed) button.armed.visible = view.armed;
      button.meter.visible = mode === 'charging' || mode === 'ad' || mode === 'loading';
      if (button.meter.visible && button.fill !== view.progress) {
        button.fill = view.progress;
        button.progress.clear();
        if (view.progress === 1) button.progress.circle(0, 0, RING_RADIUS);
        else if (view.progress > 0) {
          const start = -Math.PI / 2;
          button.progress.arc(0, 0, RING_RADIUS, start, start + Math.PI * 2 * view.progress);
        }
        if (view.progress > 0) button.progress.stroke({ color: 0xffecc4, width: 1.7, cap: 'round' });
      }
      button.badge.visible = mode !== 'held';
      button.badge.alpha = mode === 'ad' || mode === 'free' || mode === 'loading' ? 1 : 0.56;
      button.tag.visible = mode === 'free' || mode === 'loading';
      button.play.visible = !button.tag.visible;
      if (button.tag.visible) button.badgeText.text = mode === 'free' ? 'FREE' : '…';
    }
  }

  hit(point: Point): BoosterButton | undefined {
    if (!this.root.visible) return undefined;
    const local = { x: point.x, y: point.y - this.root.y };
    return this.buttons.find(button => contains(button.bounds, local))?.kind;
  }
}

export interface BoosterMark extends Point {
  width: number;
  height: number;
  texture?: Texture;
}

const CUE_MS = 230;

export class BoosterCue {
  readonly root = new Container({ eventMode: 'none', visible: false });
  private active: {
    started: number;
    marks: { mark: BoosterMark; ring: Graphics; spark: Graphics; ghost?: Sprite }[];
  } | null = null;

  get deadline(): number {
    return this.active ? this.active.started + CUE_MS : 0;
  }

  start(kind: BoosterButton, marks: readonly BoosterMark[], now: number, reduced: boolean): void {
    this.cancel();
    const joker = kind === 'joker';
    this.active = { started: now, marks: marks.map(mark => {
      const group = this.root.addChild(new Container({ x: mark.x, y: mark.y }));
      const ghost = mark.texture ? group.addChild(new Sprite({ texture: mark.texture, anchor: 0.5 })) : undefined;
      const ring = group.addChild(new Graphics().ellipse(0, 0, mark.width * 0.47, mark.height * 0.34)
        .stroke({ color: joker ? 0xa06224 : 0x256b7d, width: 4 })
        .stroke({ color: joker ? 0xffe17c : 0xa5f1ff, width: 2.3 }));
      const spark = group.addChild(new Graphics());
      if (joker) {
        spark.star(mark.width * 0.31, -mark.height * 0.22, 4, 9, 3).fill(0xfff5c9)
          .star(-mark.width * 0.33, mark.height * 0.15, 4, 6, 2).fill(0xffdc7c);
      } else {
        spark.moveTo(-mark.width * 0.39, mark.height * 0.17)
          .quadraticCurveTo(0, mark.height * 0.24, mark.width * 0.45, -mark.height * 0.19)
          .stroke({ color: 0xe1fcff, width: 2.7, cap: 'round' });
      }
      return { mark, ring, spark, ghost };
    }) };
    this.root.visible = true;
    this.show(now, reduced);
  }

  show(now: number, reduced: boolean): void {
    if (!this.active) return;
    if (now >= this.deadline) {
      this.cancel();
      return;
    }
    const progress = unit((now - this.active.started) / CUE_MS);
    const travel = 1 - (1 - progress) ** 2;
    for (const { mark, ring, spark, ghost } of this.active.marks) {
      ring.scale.set(reduced ? 1 : 0.94 + 0.22 * travel);
      ring.alpha = reduced ? 1 : 1 - 0.85 * progress;
      spark.x = reduced ? 0 : mark.width * 0.14 * travel;
      spark.alpha = reduced ? 1 : 1 - progress;
      if (!ghost) continue;
      ghost.visible = !reduced;
      if (reduced) continue;
      ghost.position.set(mark.width * 0.48 * travel, -mark.height * 0.32 * travel);
      ghost.width = mark.width * (1 - 0.28 * travel);
      ghost.height = mark.height * (1 - 0.28 * travel);
      ghost.alpha = 0.85 * (1 - progress);
    }
  }

  cancel(): void {
    if (!this.active) return;
    this.active = null;
    this.root.visible = false;
    for (const group of this.root.removeChildren()) group.destroy({ children: true });
  }
}
