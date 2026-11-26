import { Container, Sprite, type Texture } from 'pixi.js';
import { MASCOT_REST, type MascotFrame } from './mascotMotion';

export const MASCOT_POSES = ['waving', 'laughing', 'pensive', 'confused', 'frightened'] as const;
export type MascotPose = typeof MASCOT_POSES[number];
export const MASCOT_GLOVES = ['mascot-frightened-left', 'mascot-frightened-right'] as const;
const FRAME_WIDTH = 236;
const FRAME_HEIGHT = 176;
const CENTER_X = 103;
const CENTER_Y = 80;
const ART_BODY_WIDTH = 144;
const HUD_BODY_WIDTH = 64;

export function mascotArt(pose: MascotPose): string {
  return `mascot-${pose}`;
}

export function mascotSprite(texture: Texture, label: string, x: number, y: number, bodyWidth: number): Sprite {
  // All four frames share a body center. The transparent margins leave room for the detached gloves.
  return new Sprite({ texture, label, x, y, eventMode: 'none', anchor: { x: CENTER_X / FRAME_WIDTH, y: CENTER_Y / FRAME_HEIGHT },
    width: bodyWidth * FRAME_WIDTH / ART_BODY_WIDTH, height: bodyWidth * FRAME_HEIGHT / ART_BODY_WIDTH });
}

export class MascotPuppet {
  readonly root = new Container({ x: -61, y: 44, label: 'hud-mascot-puppet', eventMode: 'none' });
  private readonly body: Sprite;
  private readonly hands;
  private transform = MASCOT_REST;

  constructor(waving: Texture, gloves?: readonly [Texture, Texture]) {
    this.body = this.root.addChild(mascotSprite(waving, 'hud-mascot', 0, 0, HUD_BODY_WIDTH));
    this.hands = gloves?.map((texture, index) => {
      // The cuffs are the pivots. The rest positions register each hand to the body art.
      const pivotX = index === 0 ? 33 : 174;
      const pivotY = 75;
      const x = (pivotX - CENTER_X) * HUD_BODY_WIDTH / ART_BODY_WIDTH;
      const y = (pivotY - CENTER_Y) * HUD_BODY_WIDTH / ART_BODY_WIDTH;
      const sprite = mascotSprite(texture, MASCOT_GLOVES[index], x, y, HUD_BODY_WIDTH);
      sprite.anchor.set(pivotX / FRAME_WIDTH, pivotY / FRAME_HEIGHT);
      sprite.visible = false;
      this.root.addChild(sprite);
      return { sprite, x, y, inward: index === 0 ? 1 : -1 };
    }) ?? [];
  }

  show(texture: Texture, { pose, transform }: MascotFrame): void {
    if (this.body.texture !== texture) this.body.texture = texture;
    const fear = pose === 'frightened';
    for (const { sprite } of this.hands) sprite.visible = fear;
    this.move(transform);
  }

  settle(): void {
    this.move(MASCOT_REST);
  }

  private move(transform: MascotFrame['transform']): void {
    if (this.transform === transform) return;
    this.transform = transform;
    const { x, y, scaleX, scaleY, rotation, hands } = transform;
    this.root.position.set(-61 + x, 44 + y);
    this.root.scale.set(scaleX, scaleY);
    this.root.rotation = rotation;
    for (const { sprite, x, y, inward } of this.hands) {
      sprite.position.set(x + inward * hands * 1.7, y - hands * 2.1);
      sprite.rotation = inward * hands * 0.17;
    }
  }
}
