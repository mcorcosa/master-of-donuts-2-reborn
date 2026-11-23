import { Container, Graphics, GraphicsPath } from 'pixi.js';
import type { Point } from './gestures';
import { unit } from './movePlayback';

const SOURCE_HOLD_MS = 420;
const SWIPE_MS = 880;
const DESTINATION_HOLD_MS = 420;
const FADE_MS = 180;
const FADE_START_MS = SOURCE_HOLD_MS + SWIPE_MS + DESTINATION_HOLD_MS;
const LOOP_MS = FADE_START_MS + FADE_MS;

export type FirstMatchHandMotion = 'animate' | 'paused' | 'reduced';

export class FirstMatchHand {
  readonly root = new Container({ eventMode: 'none', visible: false });
  private route: { from: number; to: number } | undefined;
  private elapsed = 0;
  private previousTime: number | undefined;

  constructor() {
    // The fingertip sits at the origin so the palm and cuff stay above the donut.
    const silhouette = new GraphicsPath()
      .moveTo(0, -0.5).bezierCurveTo(-3.4, -1.3, -3.5, -4.9, -1.1, -7.5).lineTo(10.5, -21.9)
      .bezierCurveTo(8.7, -21, 6.9, -20.3, 4.9, -20.8).bezierCurveTo(1.9, -21.4, 1.1, -24, 2.7, -26.1)
      .bezierCurveTo(4.2, -28.1, 7.9, -28.4, 10.7, -31.2).bezierCurveTo(13.4, -34.2, 16.1, -37.8, 21, -39.1)
      .bezierCurveTo(28.4, -41, 36, -36.5, 38.5, -30.9).bezierCurveTo(40.2, -27.1, 39, -23.4, 36, -21.7)
      .bezierCurveTo(36.4, -18.6, 33.5, -16.8, 30.5, -17.6).bezierCurveTo(30, -14.1, 25.7, -13, 22.8, -14.9)
      .bezierCurveTo(21.4, -11.9, 17.8, -11.2, 15.8, -13.4).lineTo(6.6, -2.3)
      .bezierCurveTo(4.4, 0.4, 2, 0.7, 0, -0.5).closePath();
    const edge = { color: 0x79503d, width: 2.2, join: 'round' } as const;
    const shadow = this.root.addChild(new Graphics().path(silhouette).fill({ color: 0x79472d, alpha: 0.19 }));
    shadow.position.set(1.3, 1.1);
    this.root.addChild(new Graphics()
      // Rolled cuff, with a lighter rim on the lit side.
      .moveTo(21, -39.1).bezierCurveTo(24, -44.9, 27.3, -46.4, 31.1, -45.2)
      .bezierCurveTo(36.9, -43.5, 42.1, -38, 42.5, -34.8).quadraticCurveTo(43.2, -32, 38.5, -30.9)
      .bezierCurveTo(36, -36.5, 28.4, -41, 21, -39.1).closePath().fill(0xe3b38b).stroke(edge)
      .moveTo(25.4, -42.4).bezierCurveTo(30.5, -46, 38.3, -39.5, 40.5, -35.4)
      .stroke({ color: 0xffead2, width: 2, cap: 'round' })
      .path(silhouette).fill(0xfff2d8).stroke(edge)
      // Warm shade around the folded fingers and the underside of the index.
      .moveTo(33.9, -33.1).bezierCurveTo(39.6, -29, 37.4, -24, 34.7, -22.4)
      .bezierCurveTo(36.6, -19.4, 32.4, -17.5, 29.6, -19).bezierCurveTo(28.9, -15.3, 25.3, -14.7, 22.4, -16.3)
      .bezierCurveTo(20.8, -13.2, 17.9, -12.9, 15.8, -15.1).lineTo(5.7, -3.2)
      .quadraticCurveTo(3.1, 0.1, 0.5, -1.9).bezierCurveTo(6.1, -5.2, 10.4, -15.1, 14.8, -18.1)
      .bezierCurveTo(19.2, -21.4, 22.6, -18, 26.8, -21.5).bezierCurveTo(31.7, -25.3, 34.8, -26.4, 33.9, -33.1)
      .closePath().fill({ color: 0xd7976e, alpha: 0.58 })
      .moveTo(22.8, -15.6).quadraticCurveTo(22.7, -19.3, 25.7, -21.5)
      .moveTo(30.5, -18.1).quadraticCurveTo(30.4, -21.7, 33.1, -23.6)
      .moveTo(10.5, -21.9).quadraticCurveTo(12.6, -25.4, 16.9, -26.1)
      .stroke({ color: 0xa67458, width: 1.4, cap: 'round' })
      .moveTo(13.8, -31.2).bezierCurveTo(17.7, -37, 24.4, -39.7, 29.5, -35.7)
      .bezierCurveTo(25.2, -35.8, 21.6, -33.9, 18.7, -31.1).quadraticCurveTo(15.6, -27.9, 13.8, -31.2)
      .closePath().fill(0xfffcf1)
      .moveTo(0.6, -5.2).quadraticCurveTo(4.7, -10.6, 9.8, -16.7)
      .stroke({ color: 0xfffcf1, width: 1.8, cap: 'round' }));
  }

  show(route: { from: number; to: number }, source: Point, destination: Point, now: number, motion: FirstMatchHandMotion): boolean {
    if (route !== this.route || motion === 'reduced') {
      this.route = route;
      this.elapsed = 0;
      this.pause();
    }

    const animating = motion === 'animate';
    if (animating && this.previousTime !== undefined) {
      this.elapsed = (this.elapsed + now - this.previousTime) % LOOP_MS;
    }
    this.previousTime = animating ? now : undefined;

    const travel = unit((this.elapsed - SOURCE_HOLD_MS) / SWIPE_MS);
    const progress = travel * travel * (3 - 2 * travel);
    this.root.position.set(
      source.x + (destination.x - source.x) * progress,
      source.y + (destination.y - source.y) * progress - Math.sin(Math.PI * progress) * 8,
    );
    this.root.scale.x = destination.x >= source.x ? 1 : -1;
    this.root.alpha = 1 - unit((this.elapsed - FADE_START_MS) / FADE_MS);
    this.root.visible = true;
    return animating;
  }

  pause(): void {
    this.previousTime = undefined;
  }

  hide(): void {
    this.root.visible = false;
    this.route = undefined;
    this.pause();
  }
}
