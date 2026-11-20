import { Assets, Container, DOMAdapter, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { GameState } from '../game';
import type { Point, StackGestures, Target } from './gestures';
import { BOARD_TOP, contains, layoutStacks, type Rect, stackHit, STACK_LIFT, type StackSlot, VIEW_WIDTH, viewport } from './layout';
import { MatchEffect } from './matchEffect';
import type { MatchFrame, MatchPlayback } from './matchPlayback';
import { ScoreBar } from './scoreBar';

const DONUT_ART = ['gold', 'red', 'yellow', 'choco', 'gray', 'purple', 'blue', 'green'];
const CREAM = '#fff2dc';
const INK = '#672e20';
const GOLD = 0xab591a;
const MINT = 0x237d61;
const RED = 0xaa3339;
const CENTER = VIEW_WIDTH / 2;
const DIALOG_WIDTH = 288;
const DIALOG_HEIGHT = 194;

export async function loadArt(): Promise<Map<string, Texture>> {
  const textures = await Promise.all(['kitchen', 'logo', ...DONUT_ART].map(async name => {
    const src = `${import.meta.env.BASE_URL}art/${name}.png`;
    const texture = await Assets.load<Texture>(DONUT_ART.includes(name)
      ? { src, data: { autoGenerateMipmaps: true, scaleMode: 'linear' } }
      : src);
    return [name, texture] as const;
  }));
  return new Map(textures);
}

export interface Feedback {
  target: number;
  started: number;
  duration: number;
  color?: string;
  start?: Point;
  levelUp?: boolean;
}

interface StackView {
  slot: StackSlot;
  hit: Rect;
  mark: Graphics;
  markColor?: number;
  pieces: Container[];
  top?: Container;
  topShadow?: Sprite;
  topY: number;
}

function sprite(parent: Container, texture: Texture, x = 0, y = 0, width?: number, height?: number): Sprite {
  const display = new Sprite(texture);
  display.position.set(x, y);
  if (width !== undefined) display.width = width;
  if (height !== undefined) display.height = height;
  return parent.addChild(display);
}

function createContactTexture(): Texture {
  const radius = 32;
  const canvas = DOMAdapter.get().createCanvas(radius * 2, radius * 2);
  const context = canvas.getContext('2d')!;
  const gradient = context.createRadialGradient(radius, radius, 0, radius, radius, radius);
  gradient.addColorStop(0, 'rgba(65, 25, 15, 0.28)');
  gradient.addColorStop(0.55, 'rgba(65, 25, 15, 0.16)');
  gradient.addColorStop(1, 'rgba(65, 25, 15, 0)');
  context.fillStyle = gradient;
  context.fillRect(0, 0, canvas.width, canvas.height);
  return Texture.from(canvas, true);
}

function label(parent: Container, value: string, size: number, x: number, y: number, fill = INK): Text {
  const display = new Text({ text: value, style: {
    fontFamily: ['Reborn Fredoka', 'Trebuchet MS', 'sans-serif'], fontSize: size, fontWeight: '600', fill,
  } });
  display.anchor.set(0.5);
  display.position.set(x, y);
  return parent.addChild(display);
}

function drawCapacity(group: Container, slot: StackSlot, count: number, capacity: number, width: number): void {
  const { x, base } = slot;
  const half = Math.min(34, width / 2 + 3);
  const cue = group.addChild(new Graphics({ x, y: base }));

  if (count === capacity) {
    cue.roundRect(-half, 5, half * 2, 14, 6).fill(0x562a1e);
    for (let x = 6 - half; x <= half - 5; x += 6) {
      cue.circle(x, 7, 3).fill(0x83452e).circle(x, 16, 3).fill(0x83452e);
    }
    cue.roundRect(1 - half, 6, half * 2 - 2, 10, 5).fill(0x773e2b)
      .moveTo(6 - half, 13).lineTo(11 - half, 8)
      .moveTo(11 - half, 15).lineTo(16 - half, 10)
      .moveTo(half - 16, 13).lineTo(half - 11, 8)
      .moveTo(half - 11, 15).lineTo(half - 6, 10)
      .stroke({ color: 0xc6885b, width: 1.2, cap: 'round' });
    label(group, 'FULL', 10.5, x, base + 11.5, CREAM);
    return;
  }

  cue.roundRect(-half, 7, half * 2, 8, 4).fill(0xc48561)
    .roundRect(1 - half, 8, half * 2 - 2, 6, 3).fill(0xa66244);
  const pitch = (half * 2 - 3) / capacity;
  for (let index = 0; index < capacity; index++) {
    const left = 1.5 - half + index * pitch;
    const filled = index < count;
    cue.roundRect(left, 8.5, pitch - 0.8, 5, 1.6).fill(filled ? 0xe5a02f : 0xffe0b8)
      .roundRect(left + 0.5, 9, pitch - 1.8, 1.5, 0.75).fill(filled ? 0xffd572 : 0xffedcf);
  }
}

export class GameScene {
  readonly root = new Container({ eventMode: 'none' });
  private readonly kitchen: Sprite;
  private readonly content = new Container();
  private readonly hud = new Container();
  private readonly board = new Container();
  private readonly overlay = new Container();
  private readonly flight: Sprite;
  private readonly contactTexture = createContactTexture();
  private readonly matchEffect: MatchEffect;
  private readonly scoreBar = new ScoreBar();
  private readonly pressure: Text;
  private readonly beads = new Graphics();
  private readonly status: Text;
  private readonly result: Text;
  private readonly scrim = new Graphics();
  private readonly dialog = new Container();
  private readonly restart: Rect = { x: 61, y: 126, width: 166, height: 46 };
  private readonly restartHit: Rect = { ...this.restart, y: this.restart.y - 5, height: this.restart.height + 10 };
  private stacks: StackView[] = [];
  private fit = viewport(400, 600);
  private layout = layoutStacks(this.fit.height, 3);
  private matchTarget: StackView | undefined;

  constructor(private readonly art: Map<string, Texture>) {
    this.root.once('destroyed', () => this.contactTexture.destroy(true));
    this.kitchen = sprite(this.root, this.texture('kitchen'));
    this.kitchen.anchor.set(0.5);
    this.root.addChild(this.content, this.scrim, this.overlay);
    this.matchEffect = new MatchEffect(Texture.EMPTY);
    this.content.addChild(this.board, this.matchEffect.root, this.hud);
    this.flight = sprite(this.content, Texture.EMPTY);
    this.flight.anchor.set(0.5, 1);

    const logo = sprite(this.hud, this.texture('logo'), CENTER, 34);
    logo.anchor.set(0.5);
    logo.scale.set(Math.min(150 / logo.texture.width, 58 / logo.texture.height));
    this.scoreBar.root.y = 68;
    this.hud.addChild(this.scoreBar.root, this.beads);
    this.pressure = label(this.hud, '', 22, CENTER, 0);
    this.status = label(this.hud, '', 15, CENTER, 0);

    this.overlay.addChild(this.dialog);
    const { x, y, width, height } = this.restart;
    this.dialog.addChild(new Graphics()
      .roundRect(0, 6, DIALOG_WIDTH, DIALOG_HEIGHT, 24).fill({ color: 0x682e21, alpha: 0.24 })
      .roundRect(0, 0, DIALOG_WIDTH, DIALOG_HEIGHT, 24).fill(0xffedda).stroke({ color: 0xfff6e9, width: 1.5 })
      .roundRect(x, y + 3, width, height, 15).fill(0x873023)
      .roundRect(x, y, width, height, 15).fill(0xa94130).stroke({ color: 0xb45642, width: 1 }));
    label(this.dialog, 'Game Over', 31, DIALOG_WIDTH / 2, 38);
    label(this.dialog, 'Final score', 14, DIALOG_WIDTH / 2, 70);
    this.result = label(this.dialog, '', 27, DIALOG_WIDTH / 2, 97);
    label(this.dialog, 'Play Again', 21, x + width / 2, y + height / 2, CREAM);
  }

  private texture(name: string): Texture {
    return this.art.get(name)!;
  }

  resize(width: number, height: number): void {
    this.fit = viewport(width, height);
    for (const layer of [this.content, this.overlay]) {
      layer.position.set(this.fit.x, this.fit.y);
      layer.scale.set(this.fit.scale);
    }
    const cover = Math.max(width / this.kitchen.texture.width, height / this.kitchen.texture.height);
    this.kitchen.scale.set(cover);
    this.kitchen.position.set(width / 2, height / 2);
    this.scrim.clear().rect(0, 0, width, height).fill({ color: 0x4e2019, alpha: 0.6 });
    this.pressure.y = this.fit.height - 56;
    this.beads.position.set(CENTER, this.fit.height - 28);
    this.status.y = this.fit.height - 84;
    this.dialog.position.set((VIEW_WIDTH - DIALOG_WIDTH) / 2, (this.fit.height - DIALOG_HEIGHT) / 2);
  }

  private drawPressure(movesLeft: number, pressureLimit: number): void {
    this.pressure.text = `New dough in ${movesLeft}`;
    const rail = 188;
    this.beads.clear()
      .roundRect(-rail / 2, -2.5, rail, 6, 3).fill(0xac6045)
      .roundRect(-rail / 2, -2.5, rail, 2, 1).fill(0xe5936d);
    for (let index = 0; index < pressureLimit; index++) {
      const x = -rail / 2 + index * rail / (pressureLimit - 1);
      const filled = index < pressureLimit - movesLeft;
      this.beads.circle(x, 1.5, 7).fill({ color: 0x993f29, alpha: 0.22 })
        .circle(x, 0, 6.8).fill(filled ? 0xf6ae15 : 0xf2ba9e)
        .stroke({ color: filled ? 0xb66b15 : 0xb77861, width: 1 })
        .ellipse(x - 1, -2.2, 3.4, 1.6).fill(filled ? 0xffdc62 : 0xffdcc2);
    }
  }

  draw(state: GameState, levelStartScore: number, pressureLimit: number): void {
    for (const child of this.board.removeChildren()) child.destroy({ children: true });
    this.board.alpha = 1;
    this.layout = layoutStacks(this.fit.height, state.stacks.length);
    const { slots, donutWidth, donutHeight, step } = this.layout;
    this.stacks = state.stacks.map((stack, index) => {
      const slot = slots[index];
      const group = this.board.addChild(new Container());
      const mark = group.addChild(new Graphics());
      mark.visible = false;
      drawCapacity(group, slot, stack.length, state.capacity, donutWidth);
      let topShadow: Sprite | undefined;
      const pieces = stack.map((color, depth) => {
        const layer = group.addChild(new Container({ x: slot.x, y: slot.base - depth * step }));
        const shadowWidth = donutWidth * (depth === 0 ? 1.04 : 0.82);
        topShadow = sprite(layer, this.contactTexture, 0, -donutHeight * 0.02, shadowWidth, donutHeight * 0.16);
        topShadow.anchor.set(0.5);
        const piece = sprite(layer, this.texture(color), 0, 0, donutWidth, donutHeight);
        piece.anchor.set(0.5, 1);
        return layer;
      });
      const top = pieces.at(-1);
      const topY = top?.y ?? slot.base;
      const hit = stackHit(slot, pieces.length, donutHeight, step);
      return { slot, hit, mark, pieces, top, topShadow, topY };
    });

    this.scoreBar.draw(state, levelStartScore);
    this.drawPressure(state.movesLeft, pressureLimit);
    this.scrim.visible = this.overlay.visible = state.gameOver;
    if (state.gameOver) this.result.text = state.score.toLocaleString();
  }

  toLocal(point: Point): Point {
    return { x: (point.x - this.fit.x) / this.fit.scale, y: (point.y - this.fit.y) / this.fit.scale };
  }

  hit(point: Point): Target {
    if (this.overlay.visible) {
      const inDialog = { x: point.x - this.dialog.x, y: point.y - this.dialog.y };
      return contains(this.restartHit, inDialog) ? 'restart' : null;
    }
    const index = this.stacks.findIndex(({ hit }) => contains(hit, point));
    return index >= 0 ? index : null;
  }

  topPosition(index: number): Point {
    const { slot, top } = this.stacks[index];
    return { x: slot.x, y: top?.y ?? slot.base };
  }

  startMatch(match: MatchPlayback): void {
    const target = this.stacks[match.to];
    const { donutWidth, donutHeight, step } = this.layout;
    this.matchEffect.start(match, {
      start: this.topPosition(match.from),
      landing: { x: target.slot.x, y: target.slot.base - target.pieces.length * step },
      width: donutWidth,
      height: donutHeight,
      step,
      viewHeight: this.fit.height,
    }, this.texture(match.color));
    this.matchTarget = target;
    this.stacks[match.from].top!.visible = false;
    for (const stack of this.stacks) stack.mark.visible = false;
    this.flight.visible = false;
    this.status.text = '';
  }

  showMatch(frame: MatchFrame): void {
    this.matchEffect.showPieces(frame);
    if (frame.phase === 'clear' && this.matchTarget) {
      const { pieces } = this.matchTarget;
      pieces[pieces.length - 1].visible = pieces[pieces.length - 2].visible = false;
      this.board.alpha = 1 - 0.42 * Math.min(1, frame.progress * 7);
    }
    if (frame.phase === 'resolved') this.matchTarget = undefined;
  }

  showAward(now: number): void {
    this.matchEffect.showAward(now);
  }

  cancelMatch(): void {
    this.matchTarget = undefined;
    this.matchEffect.cancel();
  }

  showInteraction(gestures: StackGestures, legal: boolean, feedback: Feedback | null, now: number): void {
    if (this.overlay.visible) {
      this.flight.visible = false;
      this.status.text = '';
      return;
    }

    const source = gestures.source;
    const destination = gestures.destination;
    const age = feedback ? now - feedback.started : 0;
    const flying = !!feedback?.start && age < 170;
    this.flight.visible = flying;

    this.stacks.forEach((view, index) => {
      const result = feedback?.target === index ? feedback : null;
      const color = index === destination ? (legal ? MINT : RED)
        : index === source ? GOLD
        : result ? (!result.color ? RED : result.levelUp ? GOLD : MINT) : undefined;
      const { hit } = view;
      view.mark.visible = color !== undefined;
      if (color !== undefined && view.markColor !== color) {
        view.mark.clear().roundRect(hit.x + 3, hit.y + 2, hit.width - 6, hit.height - 4, 16)
          .fill({ color, alpha: 0.11 }).stroke({ color, width: 2.2 });
        view.markColor = color;
      }
      view.mark.alpha = result && index !== source && index !== destination ? 1 - 0.7 * age / result.duration : 1;
      if (view.top) {
        view.top.y = view.topY - (index === source ? STACK_LIFT : 0);
        view.top.visible = !(flying && index === feedback?.target);
        if (view.topShadow) view.topShadow.visible = index !== source;
      }
    });

    if (flying && feedback?.start && feedback.color) {
      const end = this.topPosition(feedback.target);
      const fraction = Math.min(1, age / 170);
      const eased = fraction * (2 - fraction);
      const arc = Math.min(32, Math.max(4, Math.min(feedback.start.y, end.y) - this.layout.donutHeight - BOARD_TOP));
      this.flight.texture = this.texture(feedback.color);
      this.flight.width = this.layout.donutWidth;
      this.flight.height = this.layout.donutHeight;
      this.flight.position.set(
        feedback.start.x + (end.x - feedback.start.x) * eased,
        feedback.start.y + (end.y - feedback.start.y) * eased - Math.sin(Math.PI * fraction) * arc,
      );
    }

    this.status.text = !feedback ? ''
      : !feedback.color ? 'That stack is full'
      : feedback.levelUp ? 'Level up!'
      : '';
    this.status.style.fill = feedback && !feedback.color ? RED : INK;
  }
}
