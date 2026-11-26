import { Container, FillGradient, Graphics, Text } from 'pixi.js';
import { DOUGH_METER_LIMIT, type GameState } from '../game';
import { GAME_FONT_FAMILY, gameText } from './gameFont';
import type { Point } from './gestures';
import { BOARD_FOOTER_SPACE, BOARD_TOP } from './layout';
import { MOVE_COST_INK, MOVE_RECOVERY_MS, MOVE_SPEND_MS, type MoveRecovery } from './moveCost';
import { unit } from './movePlayback';

const CAP_WIDTH = 46;
const CAP_HEIGHT = 59;
const NECK_Y = CAP_HEIGHT + 4;
const GLASS_WIDTH = 24;
const WELL_INSET = 2.35;
const WELL_WIDTH = GLASS_WIDTH - 2 * WELL_INSET;
const FITTING_WIDTH = 18;
const FITTING_HEIGHT = 4.5;
const FITTING_OVERLAP = 2.1;
const ICING_WIDTH = 15;
const RAIL_X = 33;
const SLICE_HOLD_MS = 72;
const RECOVERY_HIT_MS = 230;
const RECOVERY_NOTICE_MS = 1150;

type Tone = 'full' | 'warning' | 'critical';
type MoveBudget = Pick<GameState, 'doughMeter'>;

const palette = {
  full: { cap: [0xfff2d4, 0xf7d498], icing: [0xffe483, 0xfec40b, 0xe69d05], ink: '#731328', halo: 0xffc01d, border: 0xce9d63 },
  warning: { cap: [0xffdd90, 0xf2a336], icing: [0xffcc70, 0xf3982d, 0xc9681c], ink: '#542514', halo: 0xf0a028, border: 0xc7843f },
  critical: { cap: [0xa82748, 0x731328], icing: [0xe3738a, 0xb32d50, 0x731328], ink: '#fff3d7', halo: 0xaf3555, border: 0xb1746d },
};

export function icingVialReading({ doughMeter = 0 }: MoveBudget, limit = DOUGH_METER_LIMIT) {
  const spent = Number.isFinite(doughMeter) ? Math.trunc(doughMeter) : 0;
  const remaining = Math.max(0, Math.min(limit, limit - spent));
  const fraction = remaining / limit;
  const tone: Tone = fraction <= 3 / 28 ? 'critical' : fraction <= 7 / 28 ? 'warning' : 'full';
  return { remaining, fraction, tone };
}

function gradient(colors: readonly number[], vertical = false): FillGradient {
  return new FillGradient({
    end: vertical ? { x: 0, y: 1 } : { x: 1, y: 0 },
    colorStops: colors.map((color, index) => ({ offset: index / (colors.length - 1), color })),
  });
}

function text(value: string, y: number, size: number, weight: '600' | '700'): Text {
  return new Text({ text: gameText(value), y, anchor: 0.5, style: {
    fontFamily: GAME_FONT_FAMILY,
    fontSize: size, fontWeight: weight, lineHeight: 11, align: 'center',
  } });
}

function fitWidth(label: Text, width: number): void {
  label.scale.x = Math.min(1, width / Math.max(1, label.getLocalBounds().width));
}

export class IcingVial {
  readonly root = new Container({ x: RAIL_X, y: BOARD_TOP, eventMode: 'none', label: 'icing-vial' });
  private readonly glass = new Graphics({ label: 'glass' });
  private readonly wellClip = new Graphics({ label: 'inner glass silhouette' });
  private readonly contents = new Container({ label: 'well contents' });
  private readonly icing = new Graphics({ label: 'icing' });
  private readonly graduations = new Graphics({ label: 'graduations' });
  private readonly fittings = new Graphics({ label: 'gold fittings' });
  private readonly accent = new Graphics({ visible: false, label: 'cap emphasis' });
  private readonly face = new Graphics();
  private readonly sliceClip = new Graphics({ label: 'icing silhouette' });
  private readonly spendSlice = new Graphics({ visible: false, label: 'spent icing slice' })
    .rect(-ICING_WIDTH / 2, 0, ICING_WIDTH, 1).fill(MOVE_COST_INK);
  private readonly count = text('', 19, 25, '700');
  private readonly caption = text('moves\nleft', 43, 11.2, '700');
  private readonly noticeBacking = new Graphics();
  private readonly notice = text('', NECK_Y + 23, 10.2, '700');
  private readonly glassColor = new FillGradient({
    end: { x: 1, y: 0 },
    colorStops: [
      { offset: 0, color: 0xbd8d5e },
      { offset: 0.095, color: 0xf7d9a8 },
      { offset: 0.16, color: 0xffedce },
      { offset: 0.51, color: 0xf2d2a1 },
      { offset: 0.9, color: 0xe6ba88 },
      { offset: 1, color: 0xbc875a },
    ],
  });
  private readonly wellColor = new FillGradient({
    end: { x: 1, y: 0 },
    colorStops: [
      { offset: 0, color: 0xf1d5ac },
      { offset: 0.1, color: 0xfff5dc },
      { offset: 0.23, color: 0xfff1d5 },
      { offset: 0.57, color: 0xf4dfbe },
      { offset: 0.87, color: 0xf9e6c8 },
      { offset: 1, color: 0xe9c698 },
    ],
  });
  private readonly rimColor = gradient([0xfde1ad, 0xf3ce90, 0xe1b277, 0xbe8855], true);
  private readonly capColor = {
    full: gradient(palette.full.cap, true),
    warning: gradient(palette.warning.cap, true),
    critical: gradient(palette.critical.cap, true),
  };
  private readonly icingColor = {
    full: gradient(palette.full.icing),
    warning: gradient(palette.warning.icing),
    critical: gradient(palette.critical.icing),
  };
  private reading = icingVialReading({});
  private painted = icingVialReading({});
  private displayed = 1;
  private bottom = NECK_Y;
  private lastHeight = -1;
  private lastSliceHeight = 0;
  private transition: { started: number; from: number; recovery: boolean; reduced: boolean } | null = null;
  private recoveryNotice: { recovery: MoveRecovery; expires: number } | null = null;

  constructor() {
    fitWidth(this.caption, CAP_WIDTH - 8);
    this.contents.addChild(this.icing, this.sliceClip, this.spendSlice, this.graduations);
    this.root.addChild(this.glass, this.wellClip, this.contents, this.fittings, this.accent, this.face,
      this.count, this.caption,
      this.noticeBacking, this.notice);
    this.contents.mask = this.wellClip;
    this.spendSlice.mask = this.sliceClip;
    this.drawCap();
    this.drawNotice();
    this.root.once('destroyed', () => {
      for (const fill of [this.glassColor, this.wellColor, this.rimColor,
        ...Object.values(this.capColor), ...Object.values(this.icingColor)]) fill.destroy();
    });
  }

  get animating(): boolean {
    return this.transition !== null && !this.transition.reduced;
  }

  get deadline(): number {
    return this.recoveryNotice?.expires ?? (this.transition?.reduced ? this.transition.started + MOVE_SPEND_MS : 0);
  }

  spendTarget(remaining: number): Point {
    const before = (remaining + 1) / DOUGH_METER_LIMIT;
    return { x: this.root.x, y: this.root.y + this.fillBottom - this.fillHeight(before) };
  }

  resize(height: number): void {
    this.bottom = height - BOARD_FOOTER_SPACE - BOARD_TOP - 6;
    const glassHeight = this.bottom - NECK_Y;
    const wellTop = NECK_Y + WELL_INSET;
    const wellHeight = glassHeight - 2 * WELL_INSET;
    // The shell and well share their end centers. Glass highlights come from
    // the gradients inside those curves, so no stroke or highlight ends at a seam.
    this.glass.clear()
      .roundRect(-GLASS_WIDTH / 2, NECK_Y, GLASS_WIDTH, glassHeight, GLASS_WIDTH / 2).fill(this.glassColor)
      .roundRect(-WELL_WIDTH / 2, wellTop, WELL_WIDTH, wellHeight, WELL_WIDTH / 2).fill(this.wellColor);
    this.wellClip.clear().roundRect(-WELL_WIDTH / 2, wellTop, WELL_WIDTH, wellHeight, WELL_WIDTH / 2).fill(0xffffff);
    this.fittings.clear()
      .roundRect(-FITTING_WIDTH / 2, NECK_Y + FITTING_OVERLAP - FITTING_HEIGHT, FITTING_WIDTH, FITTING_HEIGHT, FITTING_HEIGHT / 2)
      .fill(this.rimColor)
      .roundRect(-FITTING_WIDTH / 2, this.bottom - FITTING_OVERLAP, FITTING_WIDTH, FITTING_HEIGHT, FITTING_HEIGHT / 2)
      .fill(this.rimColor);
    this.graduations.clear();
    for (let mark = 1; mark < 7; mark++) {
      const y = NECK_Y + glassHeight * mark / 7;
      this.graduations.roundRect(8, y, 1.3, 0.75, 0.375).fill({ color: 0xad7c51, alpha: 0.64 });
    }
    this.lastHeight = -1;
    this.drawIcing();
  }

  sync(state: MoveBudget): void {
    this.reading = icingVialReading(state);
    this.recoveryNotice = null;
    this.transition = null;
    this.show(0, true);
  }

  apply(remaining: number, now: number, reduced: boolean, recovery?: MoveRecovery): void {
    this.show(now, reduced);
    const next = icingVialReading({ doughMeter: DOUGH_METER_LIMIT - remaining });
    if (this.reading.remaining === next.remaining) return;
    const from = recovery ? this.displayed : this.reading.fraction;
    this.reading = next;
    this.recoveryNotice = recovery ? { recovery, expires: now + RECOVERY_NOTICE_MS } : null;
    this.transition = recovery && reduced ? null : { started: now, from, recovery: !!recovery, reduced };
    this.show(now, reduced);
  }

  show(now: number, still: boolean): void {
    if (still && !this.transition?.reduced) this.transition = null;
    let motion = this.transition;
    const age = motion ? Math.max(0, now - motion.started) : 0;
    if (motion && age >= (motion.recovery ? MOVE_RECOVERY_MS : MOVE_SPEND_MS)) motion = this.transition = null;
    const t = motion?.recovery ? unit(age / MOVE_RECOVERY_MS) : motion?.reduced ? 0 :
      unit((age - SLICE_HOLD_MS) / (MOVE_SPEND_MS - SLICE_HOLD_MS));
    const tail = 1 - t * t * (3 - 2 * t);
    this.displayed = motion ? this.reading.fraction + (motion.from - this.reading.fraction) * tail
      : this.reading.fraction;
    const count = motion?.recovery ? Math.floor(this.displayed * DOUGH_METER_LIMIT + 1e-7) : this.reading.remaining;
    if (count !== this.painted.remaining) {
      this.painted = icingVialReading({ doughMeter: DOUGH_METER_LIMIT - count });
      this.drawCap();
    }
    this.accent.alpha = motion?.recovery ? 0.76 * (1 - unit(age / RECOVERY_HIT_MS)) ** 2 : 0;
    this.accent.visible = this.accent.alpha > 0;
    const punch = motion && !motion.recovery && !motion.reduced ? (1 - unit(age / MOVE_SPEND_MS)) ** 2 : 0;
    this.count.scale.set(1 + 0.25 * punch);
    this.count.x = this.painted.tone === 'critical' ? 2 * Math.sin(age / 14) * punch : 0;
    if (this.recoveryNotice && now >= this.recoveryNotice.expires) this.recoveryNotice = null;
    this.drawNotice();
    this.drawIcing();
  }

  private drawCap(): void {
    const { remaining, tone } = this.painted;
    const { border, halo, ink } = palette[tone];
    const x = -CAP_WIDTH / 2;
    this.count.text = String(remaining);
    this.count.style.fill = this.caption.style.fill = ink;
    this.face.clear()
      .roundRect(x + 0.8, 1.4, CAP_WIDTH, CAP_HEIGHT, 16).fill({ color: 0x9a582f, alpha: 0.19 })
      .roundRect(x, 0, CAP_WIDTH, CAP_HEIGHT, 16).fill(0xffedce).stroke({ color: border, width: 1.1 })
      .roundRect(x + 3, 3, CAP_WIDTH - 6, CAP_HEIGHT - 6, 13).fill(this.capColor[tone])
      .stroke({ color: 0xfff6dd, alpha: 0.42, width: 0.65 });
    this.accent.clear()
      .roundRect(x - 1.2, -1.2, CAP_WIDTH + 2.4, CAP_HEIGHT + 2.4, 17.2).stroke({ color: halo, width: 3.2, alpha: 0.54 })
      .roundRect(x - 0.7, -0.7, CAP_WIDTH + 1.4, CAP_HEIGHT + 1.4, 16.7).stroke({ color: halo, width: 1.25 });
    this.lastHeight = -1;
  }

  private drawNotice(): void {
    const { remaining } = this.reading;
    const recovery = this.recoveryNotice?.recovery;
    const source = recovery?.source === 'combo' ? 'Combo' : recovery?.source === 'extra' ? 'Extra\nChance' : 'Level up';
    const warning = remaining === 0 ? 'Out of\nmoves' : remaining === 1 ? 'Next miss\nends the\nrun' :
      remaining <= 3 ? 'Low\nmoves' : '';
    const restored = recovery && remaining > 1 ? `+${recovery.restored} ${recovery.restored === 1 ? 'move' : 'moves'}\n${source}` : '';
    const copy = gameText([restored, warning].filter(Boolean).join('\n'));
    this.noticeBacking.visible = this.notice.visible = !!copy;
    if (this.notice.text === copy) return;
    this.notice.text = copy;
    fitWidth(this.notice, 48);
    const gain = copy.startsWith('+');
    this.notice.style.fill = gain ? '#582d1b' : '#fff3d7';
    const height = 8 + 11 * copy.split('\n').length;
    this.notice.y = Math.max(NECK_Y + 23, NECK_Y + 3 + height / 2);
    this.noticeBacking.clear().roundRect(-28, this.notice.y - height / 2, 56, height, 8)
      .fill(gain ? 0xffe29a : 0x87213c).stroke({ color: gain ? 0xbb7742 : 0xffdaaa, width: 1 });
  }

  private get fillBottom(): number { return this.bottom - 2.7; }

  private fillHeight(fraction: number): number {
    return Math.round(Math.max(0, this.fillBottom - NECK_Y - 2.7) * fraction * 4) / 4;
  }

  private drawIcing(): void {
    const height = this.fillHeight(this.displayed);
    const sliceHeight = this.transition && !this.transition.recovery ? height - this.fillHeight(this.reading.fraction) : 0;
    if (height === this.lastHeight && sliceHeight === this.lastSliceHeight) return;
    this.lastHeight = height;
    this.lastSliceHeight = sliceHeight;
    this.spendSlice.visible = sliceHeight > 0;
    this.icing.clear();
    if (height === 0) return;
    const radius = Math.min(ICING_WIDTH, height) / 2;
    const y = this.fillBottom - height;
    this.icing.roundRect(-ICING_WIDTH / 2, y, ICING_WIDTH, height, radius).fill(this.icingColor[this.painted.tone]);
    if (sliceHeight > 0) {
      this.sliceClip.clear().roundRect(-ICING_WIDTH / 2, y, ICING_WIDTH, height, radius).fill(0xffffff);
      this.spendSlice.y = y;
      this.spendSlice.scale.y = sliceHeight;
    }
  }
}
