export interface Point {
  x: number;
  y: number;
}

export type Target = number | 'restart' | null;

export type GestureResult =
  | { kind: 'move' | 'blocked'; from: number; to: number }
  | { kind: 'restart' };

interface Press {
  id: number;
  origin: Point;
  target: Target;
  hover: Target;
  dragged: boolean;
}

const SWIPE_DISTANCE = 10;

export class StackGestures {
  private press: Press | null = null;
  private selection: number | null = null;

  constructor(
    private readonly hasDonuts: (stack: number) => boolean,
    private readonly canMove: (from: number, to: number) => boolean,
  ) {}

  get source(): number | null {
    const press = this.press;
    if (press?.dragged && typeof press.target === 'number' && this.hasDonuts(press.target)) {
      return press.target;
    }
    return this.selection;
  }

  get destination(): number | null {
    const press = this.press;
    if (press?.dragged && typeof press.target === 'number' && this.hasDonuts(press.target) &&
        typeof press.hover === 'number' && press.hover !== press.target) {
      return press.hover;
    }
    return null;
  }

  get pressedStack(): number | null {
    const press = this.press;
    return press && !press.dragged && typeof press.target === 'number' && press.target === press.hover
      ? press.target : null;
  }

  start(id: number, point: Point, target: Target): boolean {
    if (this.press) return false;
    this.press = { id, origin: point, target, hover: target, dragged: false };
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
      press.dragged = dx * dx + dy * dy >= SWIPE_DISTANCE * SWIPE_DISTANCE;
    }
    press.hover = target;
    return wasDragged !== press.dragged || previous !== target;
  }

  finish(id: number, point: Point, target: Target): GestureResult | null {
    const press = this.press;
    if (!press || press.id !== id) return null;
    this.update(id, point, target);
    this.press = null;

    if (press.dragged) {
      const from = press.target;
      if (typeof from === 'number' && typeof target === 'number' && from !== target && this.hasDonuts(from)) {
        return this.attempt(from, target);
      }
      return null;
    }

    if (target !== press.target) return null;
    if (target === 'restart') return { kind: 'restart' };
    if (target === null || target === this.selection) {
      this.selection = null;
    } else if (this.selection !== null) {
      return this.attempt(this.selection, target);
    } else if (this.hasDonuts(target)) {
      this.selection = target;
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
