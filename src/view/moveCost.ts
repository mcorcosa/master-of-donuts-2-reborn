import { Container, Text } from 'pixi.js';
import { GAME_FONT_FAMILY, gameText } from './gameFont';
import type { Point } from './gestures';
import { BOARD_FOOTER_SPACE, BOARD_TOP, VIEW_WIDTH } from './layout';
import { unit } from './movePlayback';
import type { SceneTextResolution } from './textResolution';

const TEXT = '−1 move';
const STILL_HOLD_MS = 450;
const ORIGIN_HOLD_MS = 125;
const DOCK_MS = 370;
const GAIN_STILL_HOLD_MS = 620;
export const GAIN_ORIGIN_HOLD_MS = 235;
export const GAIN_DOCK_MS = 600;
export const LEVEL_GAIN_DOCK_MS = 520;
const LEVEL_FOLLOW_MS = 360;
const LEVEL_STILL_HOLD_MS = 240;
const DOCK_FADE_MS = 48;
const HALF_WIDTH = 72;
const ROW_GAP = 37;
export const MOVE_COST_INK = '#731328';
export const MOVE_GAIN_INK = '#FDEFD6';
export const MOVE_SPEND_MS = 128;
export const MOVE_RECOVERY_MS = 340;
export const MOVE_GAIN_MS = 440;

export type MoveRecovery = { source: 'level' | 'combo' | 'extra'; restored: number; remaining: number };

interface BudgetUpdate {
  remaining: number;
  reduced: boolean;
  recovery?: MoveRecovery;
}

interface Cue extends BudgetUpdate {
  ready: number;
  anchor?: Point;
  level?: number;
  flight?: VisibleCue;
}

interface VisibleCue extends BudgetUpdate {
  label: Text;
  started: number;
  origin: Point;
  captionScale?: Point;
  dockAt: number;
  docked?: number;
}

function updateFor({ remaining, reduced, recovery }: BudgetUpdate): BudgetUpdate {
  return recovery ? { remaining, reduced, recovery } : { remaining, reduced };
}

export function moveSliceDuration(recovery: MoveRecovery | undefined, reduced: boolean): number {
  if (!recovery) return MOVE_SPEND_MS;
  return reduced || recovery.source === 'extra' ? MOVE_RECOVERY_MS : MOVE_GAIN_MS;
}

function sliceDuration({ recovery, reduced }: BudgetUpdate): number {
  return moveSliceDuration(recovery, reduced);
}

function stillHold({ recovery, captionScale }: VisibleCue): number {
  return captionScale ? LEVEL_STILL_HOLD_MS : recovery ? GAIN_STILL_HOLD_MS : STILL_HOLD_MS;
}

function originHold({ recovery }: BudgetUpdate): number {
  return recovery ? GAIN_ORIGIN_HOLD_MS : ORIGIN_HOLD_MS;
}

export class MoveCost {
  readonly root = new Container({ label: 'move-cost', eventMode: 'none' });
  private readonly labels: Text[] = [];
  private readonly pending: Cue[] = [];
  private readonly visible: VisibleCue[] = [];
  private nextStart = 0;
  private nextImpact = 0;

  constructor(private readonly textResolution?: SceneTextResolution) {}

  get animating(): boolean {
    return this.visible.some(cue => !cue.reduced);
  }

  get deadline(): number {
    if (this.animating) return 0;
    const pending = this.pending[0];
    const next = pending?.flight ? Math.max(pending.flight.dockAt, this.nextImpact) :
      pending ? Math.max(pending.ready, this.nextStart, pending.reduced || !pending.anchor ? this.nextImpact : 0) : Infinity;
    const due = this.visible.reduce((earliest, cue) => cue.reduced
      ? Math.min(earliest, cue.started + stillHold(cue)) : earliest, next);
    return Number.isFinite(due) ? due : 0;
  }

  enqueue(anchor: Point, ready: number, reduced: boolean, remaining: number): void {
    this.pending.push({ anchor, ready, reduced, remaining });
  }

  recover(recovery: MoveRecovery, ready: number, reduced: boolean, anchor?: Point): void {
    if (recovery.restored <= 0) return;
    this.pending.push({ recovery, remaining: recovery.remaining, ready, reduced, anchor });
  }

  reserveLevel(level: number, recovery: MoveRecovery, reduced: boolean): void {
    this.pending.push({ level, recovery, remaining: recovery.remaining, reduced, ready: Infinity });
  }

  releaseLevel(level: number, label: Text, now: number): boolean {
    const cue = this.pending.find(candidate => candidate.level === level && !candidate.flight);
    if (!cue) return false;
    const transform = label.getGlobalTransform().prepend(this.root.getGlobalTransform().invert());
    this.root.addChild(label);
    label.eventMode = 'none';
    label.setFromMatrix(transform);
    const origin = { x: label.x, y: label.y };
    const captionScale = { x: label.scale.x, y: label.scale.y };
    cue.ready = now;
    const dockAt = Math.max(now + (cue.reduced ? 0 : LEVEL_GAIN_DOCK_MS), this.earlierImpact(cue, now));
    cue.flight = { label, origin, captionScale, started: now, dockAt, ...updateFor(cue) };
    this.visible.push(cue.flight);
    return true;
  }

  show(now: number, boardHeight: number, dockFor: (remaining: number, recovery?: MoveRecovery) => Point,
    boardLeft = 0): BudgetUpdate | undefined {
    for (let index = this.visible.length - 1; index >= 0; index--) {
      const cue = this.visible[index];
      const expiry = cue.reduced ? cue.started + stillHold(cue) : (cue.docked ?? Infinity) + DOCK_FADE_MS;
      if (now < expiry) continue;
      this.hideLabel(cue);
      this.visible.splice(index, 1);
    }

    // A burst of late frames can make several labels due at once. Dock one per
    // paint and finish the prior slice so every change is shown in transfer order.
    const head = this.pending[0];
    const flight = head?.flight;
    let update: BudgetUpdate | undefined;
    if (flight && now >= Math.max(flight.dockAt, this.nextImpact)) {
      flight.docked = now;
      this.nextImpact = now + sliceDuration(flight);
      this.pending.shift();
      update = updateFor(flight);
    }

    const index = this.pending.findIndex(cue => !cue.flight);
    const next = this.pending[index];
    const preceding = this.pending[index - 1]?.flight;
    const followsCard = preceding?.captionScale && !preceding.reduced ? preceding.started + LEVEL_FOLLOW_MS : 0;
    const ready = next && now >= Math.max(next.ready, this.nextStart, followsCard);
    const cue = ready && ((next.anchor && !next.reduced) || (index === 0 && now >= this.nextImpact)) ? next : undefined;
    if (cue) {
      this.nextStart = now + sliceDuration(cue);
    }
    if (cue && (!cue.anchor || cue.reduced)) {
      this.pending.shift();
      this.nextImpact = now + sliceDuration(cue);
      update = updateFor(cue);
    }
    if (cue?.anchor) {
      const label = this.labels.find(label => !label.visible) ?? this.createLabel();
      const x = Math.max(boardLeft + HALF_WIDTH, Math.min(VIEW_WIDTH - HALF_WIDTH, cue.anchor.x));
      const min = BOARD_TOP + ROW_GAP / 2;
      const max = boardHeight - BOARD_FOOTER_SPACE - ROW_GAP / 2;
      const y = Math.max(min, Math.min(max, cue.anchor.y));
      const nearby = this.visible.filter(other => (other.reduced || (!other.captionScale && now < other.started + originHold(other))) &&
        Math.abs(other.label.x - x) < 2 * HALF_WIDTH).map(other => other.label.y);
      const fromY = [y, ...nearby.flatMap(other => [other - ROW_GAP, other + ROW_GAP])]
        .filter(position => position >= min && position <= max && nearby.every(other => Math.abs(other - position) >= ROW_GAP - 0.01))
        .sort((a, b) => Math.abs(a - y) - Math.abs(b - y))[0] ?? y;
      label.visible = true;
      const restored = cue.recovery?.restored;
      label.text = gameText(restored ? `+${restored} ${restored === 1 ? 'move' : 'moves'}` : TEXT);
      label.style.fill = restored ? MOVE_GAIN_INK : MOVE_COST_INK;
      label.style.stroke = { color: restored ? MOVE_COST_INK : '#fff1db', width: 6, join: 'round' };
      const origin = { x, y: fromY };
      // Spread the glide across the wait for an earlier gain to settle so a
      // quick miss doesn't hang at the vial before its slice can start.
      const dockAt = cue.reduced ? now : Math.max(now + (restored ? GAIN_DOCK_MS : DOCK_MS), this.earlierImpact(cue, now));
      const entry = { label, started: now, origin, dockAt, ...updateFor(cue) };
      if (!cue.reduced) cue.flight = entry;
      this.visible.push(entry);
    }

    for (const cue of this.visible) this.placeLabel(cue, now, dockFor(cue.remaining, cue.recovery));
    return update;
  }

  clear(): void {
    for (const cue of this.visible) this.hideLabel(cue);
    this.visible.length = this.pending.length = this.nextStart = this.nextImpact = 0;
  }

  private hideLabel({ label, captionScale }: VisibleCue): void {
    if (captionScale) label.destroy();
    else label.visible = false;
  }

  private earlierImpact(cue: Cue, now: number): number {
    let impact = this.nextImpact;
    let launch = Math.max(now, this.nextStart);
    for (const earlier of this.pending) {
      if (earlier === cue) break;
      if (earlier.flight) {
        impact = Math.max(impact, earlier.flight.dockAt) + sliceDuration(earlier);
      } else {
        launch = Math.max(launch, Number.isFinite(earlier.ready) ? earlier.ready : now);
        const travel = earlier.anchor && !earlier.reduced ? earlier.recovery ? GAIN_DOCK_MS : DOCK_MS : 0;
        impact = Math.max(impact, launch + travel) + sliceDuration(earlier);
        launch += sliceDuration(earlier);
      }
    }
    return impact;
  }

  private placeLabel(cue: VisibleCue, now: number, dock: Point): void {
    const { label, origin, started, reduced, docked, dockAt, recovery, captionScale } = cue;
    const age = now - started;
    const hold = captionScale ? 0 : originHold(cue);
    if (reduced || age < hold) {
      label.position.copyFrom(origin);
      const punch = recovery ? 0.10 : 0.15;
      const scale = reduced ? 1 : 1 + punch * (1 - unit(age / 100)) ** 2;
      label.scale.set((captionScale?.x ?? 1) * scale, (captionScale?.y ?? 1) * scale);
      label.alpha = 1;
      return;
    }

    if (docked !== undefined) {
      label.position.copyFrom(dock);
      label.scale.set((captionScale?.x ?? 1) * 0.16, (captionScale?.y ?? 1) * 0.16);
      label.alpha = 0.5 * (1 - unit((now - docked) / DOCK_FADE_MS));
      return;
    }

    const duration = Math.max(dockAt, this.nextImpact) - started;
    const phase = Math.min(0.96, unit((age - hold) / (duration - hold)));
    const glide = phase * phase * (3 - 2 * phase);
    const bend = 14 * Math.sin(Math.PI * glide);
    label.position.set(origin.x + (dock.x - origin.x) * glide, origin.y + (dock.y - origin.y) * glide - bend);
    const scale = 1 - 0.82 * glide;
    label.scale.set((captionScale?.x ?? 1) * scale, (captionScale?.y ?? 1) * scale);
    label.alpha = captionScale ? 1 : 1 - 0.16 * glide;
    if (captionScale && glide >= 0.18 && !label.style.stroke) {
      // Keep the original card footprint at handoff, then edge the text as
      // it leaves the biscuit and crosses the donuts.
      label.style.stroke = { color: MOVE_GAIN_INK, width: 3.4, join: 'round' };
    }
  }

  private createLabel(): Text {
    const label = this.root.addChild(new Text({ text: '', anchor: 0.5, eventMode: 'none', style: {
      fontFamily: GAME_FONT_FAMILY, fontSize: 29, fontWeight: '700',
      dropShadow: { color: '#6b2330', alpha: 0.72, angle: Math.PI / 2, blur: 1.5, distance: 2 },
    } }));
    this.textResolution?.track(label);
    this.labels.push(label);
    return label;
  }
}
