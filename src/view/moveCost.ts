import { Container, Text } from 'pixi.js';
import { GAME_FONT_FAMILY, gameText } from './gameFont';
import type { Point } from './gestures';
import { BOARD_FOOTER_SPACE, BOARD_TOP, VIEW_WIDTH } from './layout';
import { unit } from './movePlayback';

const TEXT = '−1 move';
const STILL_HOLD_MS = 450;
const ORIGIN_HOLD_MS = 125;
const DOCK_MS = 370;
const DOCK_FADE_MS = 48;
const HALF_WIDTH = 72;
const ROW_GAP = 37;
export const MOVE_COST_INK = '#731328';
export const MOVE_SPEND_MS = 128;
export const MOVE_RECOVERY_MS = 340;

export type MoveRecovery = { source: 'level' | 'combo' | 'extra'; restored: number; remaining: number };

type Cue = {
  ready: number;
  reduced: boolean;
} & ({ anchor: Point; remaining: number } | { recovery: MoveRecovery });

interface VisibleCue {
  label: Text;
  started: number;
  origin: Point;
  remaining: number;
  reduced: boolean;
  docked?: number;
}

type BudgetUpdate = { reduced: boolean } & ({ remaining: number } | { recovery: MoveRecovery });

export class MoveCost {
  readonly root = new Container({ label: 'move-cost', eventMode: 'none' });
  private readonly labels: Text[] = [];
  private readonly pending: Cue[] = [];
  private readonly visible: VisibleCue[] = [];
  private nextStart = 0;
  private nextImpact = 0;

  get animating(): boolean {
    return this.visible.some(cue => !cue.reduced);
  }

  get deadline(): number {
    if (this.animating) return 0;
    const pending = this.pending[0];
    const next = pending ? Math.max(pending.ready, this.nextStart,
      pending.reduced || 'recovery' in pending ? this.nextImpact : 0) : Infinity;
    const stationary = this.visible.find(cue => cue.reduced);
    const due = Math.min(next, stationary ? stationary.started + STILL_HOLD_MS : Infinity);
    return Number.isFinite(due) ? due : 0;
  }

  enqueue(anchor: Point, ready: number, reduced: boolean, remaining: number): void {
    this.pending.push({ anchor, ready, reduced, remaining });
  }

  recover(recovery: MoveRecovery, ready: number, reduced: boolean): void {
    this.pending.push({ recovery, ready, reduced });
  }

  show(now: number, boardHeight: number, dockFor: (remaining: number) => Point, boardLeft = 0): BudgetUpdate | undefined {
    for (let index = this.visible.length - 1; index >= 0; index--) {
      const cue = this.visible[index];
      const expiry = cue.reduced ? cue.started + STILL_HOLD_MS : (cue.docked ?? Infinity) + DOCK_FADE_MS;
      if (now < expiry) continue;
      cue.label.visible = false;
      this.visible.splice(index, 1);
    }

    // A burst of late frames can make several labels due at once. Dock one per
    // paint so the counter still shows every decrement, in transfer order.
    const flight = this.visible.find(cue => !cue.reduced && cue.docked === undefined);
    let update: BudgetUpdate | undefined;
    if (flight && now >= Math.max(flight.started + DOCK_MS, this.nextImpact)) {
      flight.docked = now;
      this.nextImpact = now + MOVE_SPEND_MS;
      update = { remaining: flight.remaining, reduced: false };
    }

    const next = this.pending[0];
    const ready = next && now >= Math.max(next.ready, this.nextStart);
    // Let the current slice finish before the next impact or recovery. New
    // flights can already leave the board while the vial shows that slice.
    const cue = ready && ((!next.reduced && 'anchor' in next) || (!flight && now >= this.nextImpact)) ? next : undefined;
    if (cue) {
      this.pending.shift();
      this.nextStart = now + ('recovery' in cue ? MOVE_RECOVERY_MS : MOVE_SPEND_MS);
    }
    if (cue && 'recovery' in cue) update = { recovery: cue.recovery, reduced: cue.reduced };
    else if (cue) {
      const label = this.labels.find(label => !label.visible) ?? this.createLabel();
      const x = Math.max(boardLeft + HALF_WIDTH, Math.min(VIEW_WIDTH - HALF_WIDTH, cue.anchor.x));
      const min = BOARD_TOP + ROW_GAP / 2;
      const max = boardHeight - BOARD_FOOTER_SPACE - ROW_GAP / 2;
      const y = Math.max(min, Math.min(max, cue.anchor.y));
      const nearby = this.visible.filter(other => (other.reduced || now < other.started + ORIGIN_HOLD_MS) &&
        Math.abs(other.label.x - x) < 2 * HALF_WIDTH).map(other => other.label.y);
      const fromY = [y, ...nearby.flatMap(other => [other - ROW_GAP, other + ROW_GAP])]
        .filter(position => position >= min && position <= max && nearby.every(other => Math.abs(other - position) >= ROW_GAP - 0.01))
        .sort((a, b) => Math.abs(a - y) - Math.abs(b - y))[0] ?? y;
      label.visible = true;
      const origin = { x, y: fromY };
      this.visible.push({ label, started: now, origin, reduced: cue.reduced, remaining: cue.remaining });
      if (cue.reduced) {
        this.nextImpact = now + MOVE_SPEND_MS;
        update = { remaining: cue.remaining, reduced: true };
      }
    }

    for (const cue of this.visible) this.placeLabel(cue, now, dockFor(cue.remaining));
    return update;
  }

  clear(): void {
    for (const cue of this.visible) cue.label.visible = false;
    this.visible.length = this.pending.length = this.nextStart = this.nextImpact = 0;
  }

  private placeLabel({ label, origin, started, reduced, docked }: VisibleCue, now: number, dock: Point): void {
    const age = now - started;
    if (reduced || age < ORIGIN_HOLD_MS) {
      label.position.copyFrom(origin);
      label.scale.set(reduced ? 1 : 1 + 0.15 * (1 - unit(age / 100)) ** 2);
      label.alpha = 1;
      return;
    }

    if (docked !== undefined) {
      label.position.copyFrom(dock);
      label.scale.set(0.16);
      label.alpha = 0.5 * (1 - unit((now - docked) / DOCK_FADE_MS));
      return;
    }

    const phase = Math.min(0.96, unit((age - ORIGIN_HOLD_MS) / (DOCK_MS - ORIGIN_HOLD_MS)));
    const glide = phase * phase * (3 - 2 * phase);
    const bend = 14 * Math.sin(Math.PI * glide);
    label.position.set(origin.x + (dock.x - origin.x) * glide, origin.y + (dock.y - origin.y) * glide - bend);
    label.scale.set(1 - 0.82 * glide);
    label.alpha = 1 - 0.16 * glide;
  }

  private createLabel(): Text {
    const label = this.root.addChild(new Text({ text: gameText(TEXT), anchor: 0.5, eventMode: 'none', style: {
      fontFamily: GAME_FONT_FAMILY, fontSize: 29, fontWeight: '700', fill: MOVE_COST_INK,
      stroke: { color: '#fff1db', width: 6, join: 'round' },
      dropShadow: { color: '#6b2330', alpha: 0.72, angle: Math.PI / 2, blur: 1.5, distance: 2 },
    } }));
    this.labels.push(label);
    return label;
  }
}
