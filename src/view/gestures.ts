import type { BoosterKind } from '../game/boosters';

export interface Point {
  x: number;
  y: number;
}

export type ResultsAction = 'restart' | 'personal' | 'friends' | 'submit';
export type BoosterButton = BoosterKind;
type ButtonAction = ResultsAction | 'hint' | BoosterButton;
export type Target = number | ButtonAction | 'outside' | null;

export type GestureResult =
  | { kind: 'move' | 'blocked'; from: number; to: number }
  | { kind: 'joker-target'; stack: number }
  | { kind: ButtonAction };

interface Press {
  id: number;
  origin: Point;
  target: Target;
  hover: Target;
  dragged: boolean;
  jokerTarget: boolean;
  mouseStackPress: boolean;
  swipeDistanceSquared: number;
  destinationDistanceSquared: number;
  maxDistanceSquared: number;
  neighbor: number | null;
  destinationGrace: boolean;
}

const DESTINATION_TAP_GRACE = 6;

export class StackGestures {
  private press: Press | null = null;
  private selection: number | null = null;

  constructor(
    private readonly hasDonuts: (stack: number) => boolean,
    private readonly canMove: (from: number, to: number) => boolean,
  ) {}

  get active(): boolean {
    return this.press !== null;
  }

  get boosterPress(): boolean {
    const press = this.press;
    return !!press && (press.jokerTarget || press.target === 'joker' || press.target === 'sweep');
  }

  get dragSource(): number | null {
    const press = this.press;
    if (press?.dragged && !press.jokerTarget && typeof press.target === 'number' && this.hasDonuts(press.target)) {
      return press.target;
    }
    return null;
  }

  get source(): number | null {
    return this.dragSource ?? this.selection;
  }

  get destination(): number | null {
    const source = this.dragSource;
    const hover = this.press?.hover;
    return source !== null && typeof hover === 'number' && hover !== source ? hover : null;
  }

  get pressedStack(): number | null {
    const press = this.press;
    return press && !press.dragged && typeof press.target === 'number' && press.hover !== 'outside'
      ? press.target : null;
  }

  start(id: number, point: Point, target: Target, pointerType = 'mouse', jokerTarget = false): boolean {
    if (this.press) return false;
    const swipeDistance = pointerType === 'touch' ? 12 : 10;
    const destinationTap = pointerType === 'touch' &&
      this.selection !== null && typeof target === 'number' && target !== this.selection;
    this.press = {
      id, origin: point, target, hover: target, dragged: false, jokerTarget,
      mouseStackPress: pointerType === 'mouse' && typeof target === 'number',
      swipeDistanceSquared: swipeDistance ** 2,
      destinationDistanceSquared: (swipeDistance + (destinationTap ? DESTINATION_TAP_GRACE : 0)) ** 2,
      maxDistanceSquared: 0, neighbor: null, destinationGrace: destinationTap,
    };
    return true;
  }

  update(id: number, point: Point, target: Target): boolean {
    const press = this.press;
    if (!press || press.id !== id) return false;
    const wasDragged = press.dragged;
    const previous = press.hover;
    if (!press.dragged) {
      const dx = point.x - press.origin.x;
      const dy = point.y - press.origin.y;
      const distanceSquared = dx * dx + dy * dy;
      press.maxDistanceSquared = Math.max(press.maxDistanceSquared, distanceSquared);
      if (press.destinationGrace) {
        // Allow one nearby boundary crossing, but drop grace on an out-and-back or a gap.
        if (target === press.target) press.destinationGrace = press.neighbor === null;
        else if (typeof target !== 'number' || (press.neighbor !== null && press.neighbor !== target)) {
          press.destinationGrace = false;
        } else press.neighbor = target;
      }
      const threshold = press.destinationGrace ? press.destinationDistanceSquared : press.swipeDistanceSquared;
      // A mouse can travel the width of a stack while clicking it. Only leaving
      // that stack beyond ordinary pointer jitter can turn its press into a drag.
      press.dragged = press.mouseStackPress
        ? target !== press.target && distanceSquared >= threshold
        : press.maxDistanceSquared >= threshold;
    }
    press.hover = target;
    return wasDragged !== press.dragged || previous !== target;
  }

  finish(id: number, point: Point, target: Target): GestureResult | null {
    const press = this.press;
    if (!press || press.id !== id) return null;
    this.update(id, point, target);
    this.press = null;
    if (target === 'outside' ||
        ((target === 'hint' || target === 'joker' || target === 'sweep') && press.target !== target)) return null;

    if (press.jokerTarget && typeof press.target === 'number') {
      return !press.dragged && target === press.target && this.hasDonuts(target)
        ? { kind: 'joker-target', stack: target } : null;
    }

    if (press.dragged) {
      const from = press.target;
      if (typeof from === 'number' && typeof target === 'number' && from !== target && this.hasDonuts(from)) {
        return this.attempt(from, target);
      }
      return null;
    }

    const pressed = press.target;
    if (typeof pressed !== 'number') return pressed !== null && pressed === target ? { kind: pressed } : null;
    if (pressed === this.selection) {
      this.selection = null;
    } else if (this.selection !== null) {
      return this.attempt(this.selection, pressed);
    } else if (this.hasDonuts(pressed)) {
      this.selection = pressed;
    }
    return null;
  }

  private attempt(from: number, to: number): GestureResult {
    if (!this.canMove(from, to)) {
      this.selection = from;
      return { kind: 'blocked', from, to };
    }
    this.selection = null;
    return { kind: 'move', from, to };
  }

  owns(id: number): boolean {
    return this.press?.id === id;
  }

  cancel(id?: number): boolean {
    if (!this.press || (id !== undefined && !this.owns(id))) return false;
    this.press = null;
    return true;
  }

  reset(): void {
    this.press = null;
    this.selection = null;
  }
}
