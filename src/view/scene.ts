import { Assets, Container, DOMAdapter, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { DoughInsert, GameState } from '../game';
import type { Point, StackGestures, Target } from './gestures';
import { BOARD_TOP, contains, type HitMode, layoutStacks, type Rect, stackHit, STACK_LIFT, type StackSlot, stackTarget, VIEW_WIDTH, viewport } from './layout';
import { LevelCelebration, type LevelCelebrationDetails } from './levelCelebration';
import { MatchEffect } from './matchEffect';
import type { MatchFrame, MatchPlayback } from './matchPlayback';
import { FLIGHT_MS, flightPosition, LAND_MS, landingSquash, refillDuration, refillFrame, refillPlan } from './movePlayback';
import { ScoreBar, type ScoreDisplay } from './scoreBar';
import { type MovePreview, SelectionArrow } from './selectionArrow';
import { VacancyArt } from './vacancyArt';

const DONUT_ART = ['gold', 'red', 'yellow', 'choco', 'gray', 'purple', 'blue', 'green'];
const CREAM = '#fff2dc';
const INK = '#672e20';
const GOLD = 0xab591a;
const MINT = 0x237d61;
const RED = 0xaa3339;
const CENTER = VIEW_WIDTH / 2;
const DIALOG_WIDTH = 288;
const DIALOG_HEIGHT = 194;
const REDUCED_PRESSURE_MS = 110;
const SELECTION_LIFT_MS = 105;
const SELECTION_WIGGLE_MS = 540;

export async function loadArt(): Promise<Map<string, Texture>> {
  const textures = await Promise.all(['kitchen', 'logo', 'clear', ...DONUT_ART].map(async name => {
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
}

interface Transfer {
  to: number;
  start: Point;
  color: string;
  pressure?: { movesLeft: number; limit: number };
}

interface MovePresentation {
  started: number;
  reduced: boolean;
  refills: ReturnType<typeof refillPlan>;
  refillDelay: number;
  pendingPressure?: Transfer['pressure'];
  transfer?: Transfer & { landing: Point };
}

interface StackView {
  slot: StackSlot;
  hit: Rect;
  vacancies: Sprite;
  vacancyCount: number;
  pieces: Container[];
  refillCue: Graphics;
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

function capacityRail(width: number, capacity: number) {
  const half = Math.min(34, width / 2 + 3);
  return { half, first: 1.5 - half, pitch: (half * 2 - 3) / capacity };
}

function drawCapacity(group: Container, slot: StackSlot, count: number, capacity: number, width: number): void {
  const { x, base } = slot;
  const { half, first, pitch } = capacityRail(width, capacity);
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
  for (let index = 0; index < capacity; index++) {
    const left = first + index * pitch;
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
  private readonly arrow = new SelectionArrow();
  private readonly selectionCue = new Graphics({ eventMode: 'none', visible: false })
    .circle(0, 0, 4).fill(0xffdf86).stroke({ color: GOLD, width: 1.5 });
  private readonly feedbackCue = new Graphics({ eventMode: 'none', visible: false })
    .circle(0, 0, 5).stroke({ color: 0xffffff, width: 3 });
  private readonly contactTexture = createContactTexture();
  private readonly vacancyArt: VacancyArt;
  private readonly celebration = new LevelCelebration();
  private readonly matchEffects = new Container();
  private readonly matchPool: MatchEffect[] = [];
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
  private matchedDestination: readonly Container[] = [];
  private currentMatch: MatchEffect | null = null;
  private movePresentation: MovePresentation | null = null;
  private gameOver = false;
  private capacity = 0;
  private liftedStack: number | null = null;
  private liftStarted: number | null = null;

  get selectionAnimating(): boolean {
    return this.liftStarted !== null;
  }

  get moveAnimating(): boolean {
    return this.movePresentation !== null;
  }

  constructor(private readonly art: Map<string, Texture>) {
    this.vacancyArt = new VacancyArt(this.texture('clear'));
    this.root.once('destroyed', () => {
      this.contactTexture.destroy(true);
      this.vacancyArt.destroy();
    });
    this.kitchen = sprite(this.root, this.texture('kitchen'));
    this.kitchen.anchor.set(0.5);
    this.root.addChild(this.content, this.scrim, this.overlay);
    this.content.addChild(this.board);
    this.flight = sprite(this.content, Texture.EMPTY);
    this.flight.anchor.set(0.5, 1);
    this.flight.visible = false;
    this.content.addChild(this.selectionCue, this.feedbackCue, this.arrow.root, this.celebration.root, this.hud, this.matchEffects);

    const logo = sprite(this.hud, this.texture('logo'), CENTER, 34);
    logo.anchor.set(0.5);
    logo.scale.set(Math.min(150 / logo.texture.width, 58 / logo.texture.height));
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
    this.hideMoveGuides();
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
    this.pressure.text = movesLeft === 0 ? 'New dough' : `New dough in ${movesLeft}`;
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

  draw(state: GameState, pressureLimit: number): void {
    this.finishMove();
    this.hideMoveGuides();
    this.gameOver = state.gameOver;
    this.capacity = state.capacity;
    for (const child of this.board.removeChildren()) child.destroy({ children: true });
    this.layout = layoutStacks(this.fit.height, state.stacks.length);
    const { slots, donutWidth, donutHeight, step } = this.layout;
    this.vacancyArt.setStride(step / donutHeight);
    this.stacks = state.stacks.map((stack, index) => {
      const slot = slots[index];
      const group = this.board.addChild(new Container());
      drawCapacity(group, slot, stack.length, state.capacity, donutWidth);
      const vacancies = sprite(group, Texture.EMPTY, slot.x);
      vacancies.eventMode = 'none';
      vacancies.anchor.set(0.5, 1);
      vacancies.visible = false;
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
      const refillCue = group.addChild(new Graphics());
      const side = donutWidth * 0.44;
      const y = -donutHeight * 0.21;
      refillCue.moveTo(-side, y - 5).lineTo(-side - 3, y - 2).lineTo(-side, y + 2)
        .moveTo(side, y - 5).lineTo(side + 3, y - 2).lineTo(side, y + 2)
        .stroke({ color: 0xffdfa0, width: 2.6, cap: 'round', join: 'round' });
      refillCue.visible = false;
      return { slot, hit, vacancies, vacancyCount: 0, pieces, refillCue, top, topShadow, topY };
    });
    this.updateVacancies();

    this.drawPressure(state.movesLeft, pressureLimit);
    this.scrim.visible = this.overlay.visible = state.gameOver;
    if (state.gameOver) this.result.text = state.score.toLocaleString();
  }

  drawScore(display: ScoreDisplay): void {
    this.scoreBar.draw(display);
  }

  creditScore(now: number, reduced: boolean): void {
    this.scoreBar.credit(now, reduced);
  }

  reachScoreGoal(now: number, reduced: boolean): void {
    this.scoreBar.reachGoal(now, reduced);
  }

  startLevelCelebration(details: LevelCelebrationDetails, now: number, reduced: boolean): void {
    const { upgrade } = details;
    const { donutWidth, donutHeight, step } = this.layout;
    const markers: Rect[] = [];
    if (upgrade?.kind === 'slots') {
      const { first, pitch } = capacityRail(donutWidth, this.capacity);
      for (const { slot } of this.stacks) {
        markers.push({
          x: slot.x + first + upgrade.previousCapacity * pitch - 1.4, y: slot.base + 7.5,
          width: (upgrade.capacity - upgrade.previousCapacity) * pitch + 2.2, height: 6.8,
        });
      }
    } else if (upgrade?.kind === 'stack') {
      for (const { slot, pieces } of this.stacks.slice(upgrade.firstNewStack, upgrade.stackCount)) {
        const y = Math.max(BOARD_TOP, slot.base - Math.max(0, pieces.length - 1) * step - donutHeight - 3);
        markers.push({ x: slot.x - donutWidth / 2 - 4, y, width: donutWidth + 8, height: slot.base + 18 - y });
      }
    }
    this.celebration.start(details, markers, now, reduced, this.fit.height);
  }

  showScoreEffects(now: number): void {
    this.scoreBar.showEffects(now);
    this.celebration.show(now);
  }

  cancelScoreEffects(): void {
    this.scoreBar.resetEffects();
    this.celebration.cancel();
  }

  private updateVacancies(): void {
    const { donutWidth, step } = this.layout;
    for (const stack of this.stacks) {
      const { slot, vacancies, pieces } = stack;
      // Count the visible stack while a transfer, clear or refill is playing.
      let occupied = 0;
      for (const piece of pieces) {
        if (piece.visible && piece.alpha > 0) occupied++;
      }
      const count = this.capacity - occupied;
      if (count === stack.vacancyCount) continue;
      stack.vacancyCount = count;
      vacancies.visible = count > 0;
      if (!count) continue;
      vacancies.texture = this.vacancyArt.texture(count);
      vacancies.y = slot.base - occupied * step;
      vacancies.width = donutWidth;
      vacancies.height = vacancies.texture.height * donutWidth / vacancies.texture.width;
    }
  }

  toLocal(point: Point): Point {
    return { x: (point.x - this.fit.x) / this.fit.scale, y: (point.y - this.fit.y) / this.fit.scale };
  }

  hit(point: Point, mode: HitMode = 'exact'): Target {
    if (this.overlay.visible) {
      const inDialog = { x: point.x - this.dialog.x, y: point.y - this.dialog.y };
      return contains(this.restartHit, inDialog) ? 'restart' : null;
    }
    if (this.gameOver) return null;
    return stackTarget(this.stacks, point, this.fit.height, mode);
  }

  topPosition(index: number): Point {
    const { slot, top } = this.stacks[index];
    return { x: slot.x, y: top?.y ?? slot.base };
  }

  private guidePoint(index: number): Point {
    const { slot, top } = this.stacks[index];
    const center = this.layout.donutHeight * 0.58;
    if (!top) return { x: slot.x, y: slot.base - center };
    const offset = center * top.scale.y;
    return { x: top.x + Math.sin(top.rotation) * offset, y: top.y - Math.cos(top.rotation) * offset };
  }

  private hideMoveGuides(): void {
    this.arrow.hide();
    this.selectionCue.visible = this.feedbackCue.visible = false;
    if (this.liftedStack !== null) {
      const { top, topY, topShadow } = this.stacks[this.liftedStack];
      if (top) {
        top.y = topY;
        top.rotation = 0;
        top.scale.set(1);
      }
      if (topShadow) topShadow.visible = true;
    }
    this.liftedStack = this.liftStarted = null;
  }

  startMove(inserts: readonly DoughInsert[], started: number, reduced: boolean, transfer?: Transfer): void {
    if (!inserts.length && (!transfer || reduced)) return;
    const refills = refillPlan(this.stacks.map(stack => stack.pieces.length), inserts);
    const pendingPressure = transfer?.pressure;
    const refillDelay = transfer && !reduced ? FLIGHT_MS + LAND_MS : pendingPressure ? REDUCED_PRESSURE_MS : 0;
    this.movePresentation = { started, reduced, refills, refillDelay, pendingPressure };
    if (pendingPressure) this.drawPressure(0, pendingPressure.limit);
    if (transfer && !reduced) {
      const { slot, pieces } = this.stacks[transfer.to];
      const depth = refills.stacks.get(transfer.to)?.at(-1)?.depth ?? pieces.length - 1;
      this.movePresentation.transfer = { ...transfer, landing: { x: slot.x, y: slot.base - depth * this.layout.step } };
      this.flight.texture = this.texture(transfer.color);
      this.flight.width = this.layout.donutWidth;
      this.flight.height = this.layout.donutHeight;
    }
    this.scrim.visible = this.overlay.visible = false;
    this.showMove(started);
  }

  showMove(now: number): void {
    const move = this.movePresentation;
    if (!move) return;
    const { started, reduced, refills, refillDelay, transfer } = move;
    const { donutHeight, step } = this.layout;
    const age = now - started;
    const refillAge = age - refillDelay;
    if (move.pendingPressure && refillAge >= 0) this.resetPressure(move);
    if (refillAge >= refillDuration(refills.duration, reduced)) {
      this.finishMove();
      return;
    }

    for (const [index, motions] of refills.stacks) {
      const { slot, pieces, refillCue } = this.stacks[index];
      refillCue.visible = false;
      motions.forEach((motion, depth) => {
        const frame = refillFrame(motion, depth, refillAge, reduced);
        const piece = pieces[depth];
        piece.y = slot.base - frame.depth * step;
        piece.alpha = frame.alpha;
        piece.scale.set(frame.scaleX, frame.scaleY);
        if (frame.accent > 0) {
          refillCue.visible = true;
          refillCue.alpha = frame.accent;
          refillCue.position.set(slot.x, piece.y);
        }
      });
    }
    if (!transfer) {
      this.updateVacancies();
      return;
    }
    const piece = this.stacks[transfer.to].top!;
    const flying = age < FLIGHT_MS;
    this.flight.visible = flying;
    piece.visible = !flying;
    if (flying) {
      const arc = Math.max(0, Math.min(32, Math.min(transfer.start.y, transfer.landing.y) - donutHeight - BOARD_TOP));
      this.flight.position.copyFrom(flightPosition(transfer.start, transfer.landing, age / FLIGHT_MS, arc));
    } else if (age < refillDelay) {
      const squash = landingSquash(age - FLIGHT_MS);
      piece.scale.set(1 + 0.06 * squash, 1 - 0.12 * squash);
    } else if (!refills.stacks.has(transfer.to)) {
      piece.scale.set(1);
    }
    this.updateVacancies();
  }

  finishMove(): void {
    const move = this.movePresentation;
    if (!move) return;
    this.resetPressure(move);
    for (const index of move.refills.stacks.keys()) {
      const { slot, pieces, refillCue } = this.stacks[index];
      refillCue.visible = false;
      pieces.forEach((piece, depth) => {
        piece.alpha = 1;
        piece.scale.set(1);
        piece.y = slot.base - depth * this.layout.step;
      });
    }
    if (move.transfer) {
      const piece = this.stacks[move.transfer.to].top!;
      piece.scale.set(1);
      piece.visible = true;
    }
    this.flight.visible = false;
    this.scrim.visible = this.overlay.visible = this.gameOver;
    this.movePresentation = null;
    this.updateVacancies();
  }

  private resetPressure(move: MovePresentation): void {
    const pressure = move.pendingPressure;
    if (!pressure) return;
    this.drawPressure(pressure.movesLeft, pressure.limit);
    move.pendingPressure = undefined;
  }

  startMatch(match: MatchPlayback): void {
    const target = this.stacks[match.to];
    const { donutWidth, donutHeight, step } = this.layout;
    let effect = this.matchPool.find(effect => !effect.active);
    if (!effect) {
      effect = new MatchEffect();
      this.matchPool.push(effect);
    }
    this.matchEffects.addChild(effect.root);
    this.currentMatch = effect;
    effect.start(match, {
      start: this.topPosition(match.from),
      landing: { x: target.slot.x, y: target.slot.base - target.pieces.length * step },
      width: donutWidth,
      height: donutHeight,
      step,
      viewHeight: this.fit.height,
    }, this.texture(match.color));
    this.matchedDestination = target.pieces.slice(-(match.runLength - 1));
    this.stacks[match.from].top!.visible = false;
    this.updateVacancies();
    this.hideMoveGuides();
    this.flight.visible = false;
    this.status.text = '';
  }

  showMatch(frame: MatchFrame): void {
    this.currentMatch?.showPieces(frame);
    if (frame.phase === 'clear') {
      for (const piece of this.matchedDestination) piece.visible = false;
      this.updateVacancies();
    }
    if (frame.phase === 'resolved') {
      this.matchedDestination = [];
      this.currentMatch = null;
    }
  }

  showMatchTail(now: number): void {
    const target = this.scoreBar.creditTarget;
    for (const effect of this.matchPool) effect.showTail(now, target);
  }

  cancelMatch(): void {
    this.matchedDestination = [];
    this.currentMatch = null;
    for (const effect of this.matchPool) effect.cancel();
  }

  showInteraction(gestures: StackGestures, preview: MovePreview | null, feedback: Feedback | null, now: number, reduced: boolean): void {
    if (this.gameOver) {
      this.hideMoveGuides();
      this.status.text = '';
      return;
    }

    const { source, pressedStack } = gestures;
    if (source !== this.liftedStack) {
      this.liftedStack = source;
      this.liftStarted = source === null || reduced ? null : now;
    }
    if (reduced) this.liftStarted = null;
    else if (source !== null && this.liftStarted === null) this.liftStarted = now;
    const age = this.liftStarted === null ? 0 : Math.max(0, now - this.liftStarted);
    const rise = 1 - (1 - Math.min(1, age / SELECTION_LIFT_MS)) ** 3;
    const phase = age / SELECTION_WIGGLE_MS;
    const wiggle = Math.sin(phase * Math.PI * 2) * 0.085;
    this.stacks.forEach((view, index) => {
      const pressed = index === pressedStack;
      if (view.top && !this.movePresentation) {
        const lifted = !reduced && !pressed && index === source;
        const squash = !reduced && pressed;
        view.top.y = view.topY - (lifted ? STACK_LIFT * rise : 0);
        view.top.rotation = lifted ? wiggle : 0;
        view.top.scale.set(squash ? 1.055 : 1, squash ? 0.89 : 1);
        if (view.topShadow) view.topShadow.visible = !lifted;
      }
    });

    if (source !== null && preview && source !== preview.destination) {
      const { point, destination, blocked } = preview;
      const end = destination === null ? point : this.guidePoint(destination);
      this.arrow.show(this.guidePoint(source), end, blocked ? 'blocked' : destination === null ? 'gap' : 'move');
    } else this.arrow.hide();

    this.selectionCue.visible = reduced && source !== null && !this.arrow.root.visible;
    if (source !== null && this.selectionCue.visible) {
      const anchor = this.guidePoint(source);
      this.selectionCue.position.set(anchor.x, anchor.y - this.layout.donutHeight * 0.43);
    }

    this.feedbackCue.visible = !!feedback;
    if (feedback) {
      const anchor = this.guidePoint(feedback.target);
      this.feedbackCue.position.set(anchor.x, anchor.y - this.layout.donutHeight * 0.43);
      this.feedbackCue.tint = feedback.color ? MINT : RED;
      this.feedbackCue.alpha = reduced ? 1 : 1 - 0.7 * (now - feedback.started) / feedback.duration;
    }

    this.status.text = feedback && !feedback.color ? 'That stack is full' : '';
    this.status.style.fill = feedback && !feedback.color ? RED : INK;
  }
}
