export interface Point {
  x: number;
  y: number;
}

export type ResultsAction = 'restart' | 'personal' | 'friends' | 'submit';
export type Target = number | ResultsAction | 'outside' | null;

export type GestureResult =
  | { kind: 'move' | 'blocked'; from: number; to: number }
  | { kind: ResultsAction };

interface Press {
  id: number;
  origin: Point;
  target: Target;
  hover: Target;
  dragged: boolean;
  swipeDistanceSquared: number;
}

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

  get dragSource(): number | null {
    const press = this.press;
    if (press?.dragged && typeof press.target === 'number' && this.hasDonuts(press.target)) {
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

  start(id: number, point: Point, target: Target, swipeDistance = 10): boolean {
    if (this.press) return false;
    this.press = { id, origin: point, target, hover: target, dragged: false, swipeDistanceSquared: swipeDistance ** 2 };
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
      press.dragged = dx * dx + dy * dy >= press.swipeDistanceSquared;
    }
    press.hover = target;
    return wasDragged !== press.dragged || previous !== target;
  }

  finish(id: number, point: Point, target: Target): GestureResult | null {
    const press = this.press;
    if (!press || press.id !== id) return null;
    this.update(id, point, target);
    this.press = null;
    if (target === 'outside') return null;

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
