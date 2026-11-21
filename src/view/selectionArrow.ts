import { Graphics } from 'pixi.js';
import type { Point } from './gestures';

export interface MovePreview {
  point: Point;
  destination: number | null;
  blocked: boolean;
}

type ArrowTone = 'move' | 'gap' | 'blocked' | 'hint';

const ARROW_COLORS = {
  move: { fill: 0xffdf86, outline: 0x713a20 },
  gap: { fill: 0xffedd6, outline: 0x7b503e },
  blocked: { fill: 0xff8e8d, outline: 0x7e2631 },
  hint: { fill: 0xa6fff0, outline: 0x164c48 },
};

export class SelectionArrow {
  readonly root = new Graphics({ eventMode: 'none', visible: false });
  private last?: { from: Point; to: Point; tone: ArrowTone };

  show(from: Point, to: Point, tone: ArrowTone): void {
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const length = Math.hypot(dx, dy);
    if (length < 24) {
      this.hide();
      return;
    }
    this.root.visible = true;
    const last = this.last;
    if (last?.tone === tone && last.from.x === from.x && last.from.y === from.y &&
        last.to.x === to.x && last.to.y === to.y) return;
    this.last = { from, to, tone };

    const ux = dx / length;
    const uy = dy / length;
    const headLength = 13;
    const neck = { x: to.x - ux * headLength, y: to.y - uy * headLength };
    const left = { x: neck.x + uy * 6, y: neck.y - ux * 6 };
    const right = { x: neck.x - uy * 6, y: neck.y + ux * 6 };
    const { fill, outline } = ARROW_COLORS[tone];
    this.root.clear();

    const stroke = (color: number, width: number) => {
      if (tone === 'gap') {
        const shaftLength = length - headLength - 3;
        for (let start = 0; start < shaftLength; start += 18) {
          const end = Math.min(start + 7, shaftLength);
          this.root.moveTo(from.x + ux * start, from.y + uy * start)
            .lineTo(from.x + ux * end, from.y + uy * end);
        }
        this.root.moveTo(left.x, left.y).lineTo(to.x, to.y).lineTo(right.x, right.y);
      } else {
        const end = tone === 'blocked' ? to : neck;
        this.root.moveTo(from.x, from.y).lineTo(end.x, end.y);
        if (tone === 'blocked') {
          this.root.moveTo(to.x + uy * 7, to.y - ux * 7).lineTo(to.x - uy * 7, to.y + ux * 7);
        }
      }
      this.root.stroke({ color, width, cap: 'round', join: 'round' });
    };
    stroke(outline, tone === 'gap' ? 5.5 : 7.5);
    stroke(fill, tone === 'gap' ? 2.8 : 4.5);
    if (tone === 'move' || tone === 'hint') {
      this.root.poly([to.x, to.y, left.x, left.y, right.x, right.y])
        .fill(fill).stroke({ color: outline, width: 2, join: 'round' });
    }
    if (tone === 'hint') this.root.circle(from.x, from.y, 5).fill(fill).stroke({ color: outline, width: 2 });
  }

  hide(): void {
    this.root.visible = false;
  }
}
