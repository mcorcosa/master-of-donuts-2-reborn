import { Container, FillGradient, Graphics, Text } from 'pixi.js';
import { DOUGH_METER_LIMIT, type GameState } from '../game';
import { GAME_FONT_FAMILY, gameText } from './gameFont';
import type { Point } from './gestures';
import { BOARD_FOOTER_SPACE, BOARD_TOP } from './layout';
import { MOVE_COST_INK, MOVE_GAIN_INK, MOVE_GAIN_MS, MOVE_RECOVERY_MS, MOVE_SPEND_MS, type MoveRecovery, moveSliceDuration } from './moveCost';
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
const GAIN_RISE_MS = 300;
const GAIN_FADE_START_MS = 330;
const RECOVERY_HIT_MS = 230;
const RECOVERY_NOTICE_MS = 1150;
const RAIL_HALF_WIDTH = 29;

const amberBurst = { duration: 330, quiet: 0, widen: 0.13, compress: 0.012, shake: 0 };
const criticalBursts = [
  { duration: 430, quiet: 1550, widen: 0.16, compress: 0.024, shake: 5.0 },
  { duration: 390, quiet: 2650, widen: 0.14, compress: 0.019, shake: 3.5 },
  { duration: 360, quiet: 3700, widen: 0.12, compress: 0.015, shake: 2.0 },
];

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
  private readonly body = new Container({ label: 'vial body' });
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
  private readonly gainSlice = new Graphics({ visible: false, label: 'restored icing slice' })
    .rect(-ICING_WIDTH / 2, 0, ICING_WIDTH, 1).fill(MOVE_GAIN_INK);
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
  private transition: { started: number; from: number; recovery?: MoveRecovery; reduced: boolean } | null = null;
  private recoveryNotice: { recovery: MoveRecovery; expires: number } | null = null;
  private urgencyPaused = true;
  private burstStarted: number | null = null;
  private nextBurst = 0;

  constructor() {
    fitWidth(this.caption, CAP_WIDTH - 8);
    this.contents.addChild(this.icing, this.sliceClip, this.spendSlice, this.gainSlice, this.graduations);
    this.body.addChild(this.glass, this.wellClip, this.contents, this.fittings, this.accent, this.face,
      this.count, this.caption);
    this.root.addChild(this.body, this.noticeBacking, this.notice);
    this.contents.mask = this.wellClip;
    this.spendSlice.mask = this.sliceClip;
    this.gainSlice.mask = this.sliceClip;
    this.drawCap();
    this.drawNotice();
    this.root.once('destroyed', () => {
      for (const fill of [this.glassColor, this.wellColor, this.rimColor,
        ...Object.values(this.capColor), ...Object.values(this.icingColor)]) fill.destroy();
    });
  }

  get animating(): boolean {
    return this.burstStarted !== null || (this.transition !== null && !this.transition.reduced);
  }

  get deadline(): number {
    const still = this.transition?.reduced
      ? this.transition.started + moveSliceDuration(this.transition.recovery, true) : Infinity;
    const next = Math.min(still, this.recoveryNotice?.expires ?? Infinity, this.nextBurst || Infinity);
    return Number.isFinite(next) ? next : 0;
  }

  spendTarget(remaining: number): Point {
    return this.surface(remaining + 1);
  }

  gainTarget(recovery: MoveRecovery): Point {
    return this.surface(recovery.remaining - recovery.restored);
  }

  private surface(remaining: number): Point {
    const localY = this.fillBottom - this.fillHeight(remaining / DOUGH_METER_LIMIT);
    return { x: this.root.x + this.body.x, y: this.root.y + this.body.y + localY * this.body.scale.y };
  }

  // Sample once before labeling and painting each frame. Budget changes at
  // contact schedule a new burst without moving the surface under that label.
  showUrgency(now: number, paused: boolean, committed = this.reading.remaining): void {
    const { remaining } = this.reading;
    const relieved = (remaining <= 3 && committed > 3) || (remaining <= 7 && committed > 7);
    if (paused || committed === 0 || relieved) {
      this.stopUrgency();
      return;
    }

    const critical = criticalBursts[remaining - 1];
    if (this.urgencyPaused) {
      this.urgencyPaused = false;
      this.nextBurst = critical ? now + critical.quiet : 0;
    }
    if (this.nextBurst && now >= this.nextBurst) {
      this.nextBurst = 0;
      this.burstStarted = now;
    }
    const burst = critical ?? amberBurst;
    const phase = this.burstStarted === null ? 1 : unit((now - this.burstStarted) / burst.duration);
    if (phase === 1) {
      if (this.burstStarted !== null) this.nextBurst = critical ? now + critical.quiet : 0;
      this.burstStarted = null;
      this.setVialPose(1, 1, 0);
      return;
    }
    const pulse = Math.sin(Math.PI * phase) ** 2;
    const sway = critical ? Math.sin(4 * Math.PI * phase) : 0;
    // Widen on the center beat and leave room for the lateral beats.
    const widthPulse = pulse * (1 - 0.8 * Math.abs(sway));
    this.setVialPose(1 + burst.widen * widthPulse, 1 - burst.compress * pulse, burst.shake * pulse * sway);
  }

  private setVialPose(scaleX: number, scaleY: number, shake: number): void {
    // The cap is the widest moving piece. Keep it inside the fixed warning rail.
    const wiggleRoom = RAIL_HALF_WIDTH - (CAP_WIDTH / 2 + 1) * scaleX;
    this.body.position.set(Math.max(-wiggleRoom, Math.min(wiggleRoom, shake)), this.bottom * (1 - scaleY) / 2);
    this.body.scale.set(scaleX, scaleY);
  }

  private stopUrgency(): void {
    this.urgencyPaused = true;
    this.burstStarted = null;
    this.nextBurst = 0;
    this.setVialPose(1, 1, 0);
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
    this.stopUrgency();
    this.reading = icingVialReading(state);
    this.recoveryNotice = null;
    this.transition = null;
    this.show(0, true);
  }

  apply(remaining: number, now: number, reduced: boolean, recovery?: MoveRecovery): void {
    this.show(now, reduced);
    const next = icingVialReading({ doughMeter: DOUGH_METER_LIMIT - remaining });
    const previous = this.reading.remaining;
    if (previous === next.remaining) return;
    const extra = recovery?.source === 'extra';
    const from = extra ? this.displayed : this.reading.fraction;
    this.reading = next;
    const critical = criticalBursts[next.remaining - 1];
    if (!reduced && !this.urgencyPaused && next.remaining < previous &&
      (critical || (next.remaining === 7 && previous > 7))) {
      this.burstStarted = now;
      this.nextBurst = 0;
    } else if (next.remaining > previous || next.remaining === 0 || reduced) {
      this.burstStarted = null;
      this.nextBurst = !reduced && !this.urgencyPaused && critical ? now + critical.quiet : 0;
    }
    this.recoveryNotice = extra ? { recovery, expires: now + RECOVERY_NOTICE_MS } : null;
    this.transition = extra && reduced ? null : { started: now, from, recovery, reduced };
    this.show(now, reduced);
  }

  show(now: number, still: boolean): void {
    if (still && !this.transition?.reduced) this.transition = null;
    let motion = this.transition;
    const age = motion ? Math.max(0, now - motion.started) : 0;
    if (motion && age >= moveSliceDuration(motion.recovery, motion.reduced)) motion = this.transition = null;
    const extra = motion?.recovery?.source === 'extra';
    const gain = motion?.recovery && !extra;
    const t = gain ? (motion?.reduced ? 1 : unit(age / GAIN_RISE_MS)) : extra ? unit(age / MOVE_RECOVERY_MS) : motion?.reduced ? 0 :
      unit((age - SLICE_HOLD_MS) / (MOVE_SPEND_MS - SLICE_HOLD_MS));
    const tail = 1 - t * t * (3 - 2 * t);
    this.displayed = motion ? this.reading.fraction + (motion.from - this.reading.fraction) * tail
      : this.reading.fraction;
    const count = extra ? Math.floor(this.displayed * DOUGH_METER_LIMIT + 1e-7) : this.reading.remaining;
    if (count !== this.painted.remaining) {
      this.painted = icingVialReading({ doughMeter: DOUGH_METER_LIMIT - count });
      this.drawCap();
    }
    const spend = motion && !motion.recovery && !motion.reduced && count > 0;
    const punch = spend ? (1 - unit(age / MOVE_SPEND_MS)) ** 2 : 0;
    this.accent.alpha = extra ? 0.76 * (1 - unit(age / RECOVERY_HIT_MS)) ** 2 : 0;
    this.accent.visible = this.accent.alpha > 0;
    this.count.scale.set(1 + (count === 1 ? 0.32 : 0.25) * punch);
    this.gainSlice.alpha = gain && !motion?.reduced ? 1 - unit((age - GAIN_FADE_START_MS) / (MOVE_GAIN_MS - GAIN_FADE_START_MS)) : 1;
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
    const warning = remaining === 0 ? 'Out of\nmoves' : remaining === 1 ? 'Next miss\nends the\nrun' :
      remaining <= 3 ? 'Low\nmoves' : '';
    const restored = recovery && remaining > 1 ? `+${recovery.restored} ${recovery.restored === 1 ? 'move' : 'moves'}\nExtra\nChance` : '';
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
    const motion = this.transition;
    const sliceHeight = !motion || motion.recovery?.source === 'extra' ? 0 : motion.recovery
      ? height - this.fillHeight(motion.from)
      : this.fillHeight(this.reading.fraction) - height;
    if (height === this.lastHeight && sliceHeight === this.lastSliceHeight) return;
    this.lastHeight = height;
    this.lastSliceHeight = sliceHeight;
    this.spendSlice.visible = sliceHeight < 0;
    this.gainSlice.visible = sliceHeight > 0;
    this.icing.clear();
    if (height === 0) return;
    const radius = Math.min(ICING_WIDTH, height) / 2;
    const y = this.fillBottom - height;
    this.icing.roundRect(-ICING_WIDTH / 2, y, ICING_WIDTH, height, radius).fill(this.icingColor[this.painted.tone]);
    if (sliceHeight) {
      this.sliceClip.clear().roundRect(-ICING_WIDTH / 2, y, ICING_WIDTH, height, radius).fill(0xffffff);
      const slice = sliceHeight > 0 ? this.gainSlice : this.spendSlice;
      slice.y = y;
      slice.scale.y = Math.abs(sliceHeight);
    }
  }
}
