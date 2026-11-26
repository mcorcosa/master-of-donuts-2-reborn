import { Assets, Container, DOMAdapter, FillGradient, Graphics, type GraphicsContext, type Renderer, Sprite, Text, Texture } from 'pixi.js';
import { type DoughInsert, type DoughSwap, type GameState, getBoardRepair, JOKER } from '../game';
import { BoosterControls, BoosterCue, type BoosterFooterView } from './boosters';
import { FirstMatchHand, type FirstMatchHandMotion } from './firstMatchHand';
import { FreeBoosterCelebration } from './freeBoosterCelebration';
import { GAME_FONT_FAMILY, gameText } from './gameFont';
import type { BoosterButton, Point, StackGestures, Target } from './gestures';
import { IcingVial } from './icingVial';
import { JokerArt } from './jokerArt';
import {
  BOARD_FOOTER_SPACE, BOARD_TOP, contains, footerCenterY, type HitMode, layoutStacks, type Rect, stackHit, STACK_LIFT, type StackLayout, type StackSlot,
  stackTarget, VIEW_WIDTH, viewport,
} from './layout';
import { LevelCelebration, type LevelCelebrationDetails } from './levelCelebration';
import { MatchEffect } from './matchEffect';
import type { MatchFrame, MatchPlayback } from './matchPlayback';
import { MoveCost, type MoveRecovery } from './moveCost';
import { FLIGHT_MS, flightPosition, LAND_MS, landingSquash, refillDuration, refillFrame, refillPlan, unit } from './movePlayback';
import { ResultsPanel } from './resultsPanel';
import type { ResultsView } from './resultsSession';
import { ScoreBar, type ScoreDisplay } from './scoreBar';
import { type MovePreview, SelectionArrow } from './selectionArrow';
import { STACK_UNLOCK_MS, stackUnlockFrame } from './stackUnlock';
import { SceneTextResolution } from './textResolution';
import { VacancyArt } from './vacancyArt';

const DONUT_ART = ['gold', 'red', 'yellow', 'choco', 'gray', 'purple', 'blue', 'green'];
const CREAM = '#fff2dc';
const INK = '#672e20';
const GOLD = 0xab591a;
const RED = 0xaa3339;
const CENTER = VIEW_WIDTH / 2;
const FOOTER_STATUS_X = 63;
const FOOTER_STATUS_WIDTH = 94;
const HINT_WIDTH = 108;
const HINT_HEIGHT = 60;
const REDUCED_TRANSFER_REFILL_DELAY_MS = 110;
const DOUGH_REPAIR_MS = 320;
const REDUCED_DOUGH_REPAIR_MS = 240;
const SELECTION_LIFT_MS = 105;
const SELECTION_WIGGLE_MS = 540;

export async function loadArt(): Promise<Map<string, Texture>> {
  const pastries = ['wordmark', 'score', 'level', 'mascot', 'hint'].map(part => `vanilla-bean-${part}`);
  const textures = await Promise.all([...pastries, 'clear', 'strawberry-glaze', ...DONUT_ART, JOKER].map(async name => {
    const extension = name === JOKER || pastries.includes(name) ? 'webp' : 'png';
    const file = name === 'clear' ? 'sugar-glass.webp' : `${name}.${extension}`;
    const src = `${import.meta.env.BASE_URL}art/${file}`;
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
}

interface Transfer {
  to: number;
  start: Point;
  color: string;
}

interface MovePresentation {
  started: number;
  reduced: boolean;
  refills: ReturnType<typeof refillPlan>;
  refillDelay: number;
  transfer?: Transfer & { landing: Point };
  swaps: readonly DoughSwap[];
}

interface StackView {
  group: Container;
  rail: Container;
  railHalf: number;
  railCount: number;
  slot: StackSlot;
  hit: Rect;
  vacancies: Sprite;
  alternateVacancies?: Sprite;
  vacancyCount: number;
  pieces: Container[];
  refillCue: Graphics;
  cueWidth: number;
  cueHeight: number;
  top?: Container;
  topShadow?: Sprite;
  topY: number;
}

interface StackUnlock {
  before: StackLayout;
  after: StackLayout;
  started: number;
  progress: number;
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
  const display = new Text({ text: gameText(value), style: {
    fontFamily: GAME_FONT_FAMILY, fontSize: size, fontWeight: '600', fill,
  } });
  display.anchor.set(0.5);
  display.position.set(x, y);
  return parent.addChild(display);
}

function setFooterStatus(display: Text, value: string): void {
  const text = gameText(value);
  if (display.text === text) return;
  display.text = text;
  display.scale.x = Math.min(1, FOOTER_STATUS_WIDTH / Math.max(1, display.getLocalBounds().width));
}

function capacityRail(width: number, capacity: number) {
  const half = Math.min(34, width / 2 + 3);
  return { half, first: 1.5 - half, pitch: (half * 2 - 3) / capacity };
}

function drawCapacity(rail: Container, count: number, capacity: number, width: number, textResolution: SceneTextResolution): number {
  for (const child of rail.removeChildren()) child.destroy();
  const { half, first, pitch } = capacityRail(width, capacity);
  const cue = rail.addChild(new Graphics());

  if (count === capacity) {
    cue.roundRect(-half + 0.5, 7, half * 2, 14, 7).fill({ color: 0x8d4a28, alpha: 0.22 })
      .roundRect(-half, 5, half * 2, 14, 7).fill(0x731328)
      .roundRect(1 - half, 5.75, half * 2 - 2, 6.6, 3.3).fill(0x901637);
    textResolution.track(label(rail, 'FULL', 10.5, 0, 11.5, CREAM));
    return half;
  }

  cue.roundRect(-half, 7, half * 2, 8, 4).fill(0x731328)
    .roundRect(1 - half, 8, half * 2 - 2, 6, 3).fill(0xa3544c);
  for (let index = 0; index < capacity; index++) {
    const left = first + index * pitch;
    const filled = index < count;
    cue.roundRect(left, 8.5, pitch - 0.8, 5, 1.6).fill(filled ? 0xfec40b : 0xf4d7a7)
      .roundRect(left + 0.5, 9, pitch - 1.8, 1.5, 0.75).fill(filled ? 0xffe374 : 0xffedcf);
  }
  return half;
}

export class GameScene {
  readonly root = new Container({ eventMode: 'none' });
  private readonly backdrop = new Graphics({ label: 'pale-pine backdrop' });
  private readonly backdropColor = new FillGradient({
    type: 'radial', center: { x: 0.47, y: 0.44 }, outerRadius: 0.68,
    colorStops: [{ offset: 0, color: 0xfff5e2 }, { offset: 0.77, color: 0xfdefd6 }, { offset: 1, color: 0xf9e8cc }],
  });
  private readonly content = new Container();
  private readonly hud = new Container();
  private readonly board = new Container();
  private readonly overlay = new Container({ visible: false });
  private readonly flight: Sprite;
  private readonly arrow = new SelectionArrow();
  private readonly hintArrow = new SelectionArrow();
  private readonly firstMatchHand = new FirstMatchHand();
  private readonly hintButton = new Container({ label: 'hint-button' });
  private readonly hintBounds = { x: 336.25 - HINT_WIDTH / 2, y: 0, width: HINT_WIDTH, height: HINT_HEIGHT };
  private readonly hintFace: Sprite;
  private readonly hintLabel: Text;
  private hintAvailable = false;
  private readonly hintStatus: Text;
  private readonly boosterControls: BoosterControls;
  private readonly boosterCue = new BoosterCue();
  private readonly freeBooster = new FreeBoosterCelebration();
  private readonly boosterPrompt: Text;
  private readonly selectionCue = new Graphics({ eventMode: 'none', visible: false })
    .poly([-9, -6, 0, -2, 9, -6, 0, 6]).fill(0xffdf86).stroke({ color: GOLD, width: 1.5, join: 'round' });
  private readonly feedbackCue = new Graphics({ eventMode: 'none', visible: false })
    .circle(0, 0, 5).stroke({ color: RED, width: 3 });
  private readonly contactTexture = createContactTexture();
  private readonly vacancyArt: VacancyArt;
  private readonly celebration: LevelCelebration;
  private readonly matchEffects = new Container();
  private readonly textResolution = new SceneTextResolution();
  private readonly moveCost = new MoveCost(this.textResolution);
  private readonly matchPool: MatchEffect[] = [];
  private readonly scoreBar: ScoreBar;
  private readonly icingVial = new IcingVial();
  private readonly doughRepairCue = new Graphics({ visible: false, eventMode: 'none', label: 'dough-repair-cue' });
  private boardSwaps: readonly DoughSwap[] = [];
  private endReason: GameState['endReason'];
  private readonly status: Text;
  private readonly results: ResultsPanel;
  private readonly preparedText = new Map<string, () => void>();
  private readonly scrim = new Graphics({ visible: false });
  private stacks: StackView[] = [];
  private fit = viewport(400, 600);
  private layout = layoutStacks(this.fit.height, 3);
  private matchedDestination: readonly Container[] = [];
  private currentMatch: MatchEffect | null = null;
  private movePresentation: MovePresentation | null = null;
  private stackUnlock: StackUnlock | null = null;
  private gameOver = false;
  private gameOverCueVisible = false;
  private capacity = 0;
  private liftedStack: number | null = null;
  private liftStarted: number | null = null;
  private joker?: JokerArt;

  get selectionAnimating(): boolean {
    return this.liftStarted !== null;
  }

  get moveAnimating(): boolean {
    return this.movePresentation !== null;
  }

  get moveCostAnimating(): boolean { return this.moveCost.animating; }

  get moveCostDeadline(): number { return this.moveCost.deadline; }

  get icingVialAnimating(): boolean { return this.icingVial.animating; }

  get icingVialDeadline(): number { return this.icingVial.deadline; }

  get stackUnlockAnimating(): boolean {
    return this.stackUnlock !== null;
  }

  get effectsAnimating(): boolean {
    return this.matchPool.some(effect => effect.active) || this.scoreBar.animating || this.celebration.animating;
  }

  get boosterCueDeadline(): number {
    return this.boosterCue.deadline;
  }

  get freeBoosterDeadline(): number {
    return this.freeBooster.deadline;
  }

  get freeBoosterAnimating(): boolean {
    return this.freeBooster.animating;
  }

  constructor(private readonly art: Map<string, Texture>) {
    const companion = this.texture('strawberry-glaze');
    this.boosterControls = new BoosterControls(this.art.get(JOKER)!, this.textResolution);
    const scoreBiscuit = this.texture('vanilla-bean-score');
    const jamCookie = this.texture('vanilla-bean-level');
    this.scoreBar = new ScoreBar(this.texture('vanilla-bean-mascot'), scoreBiscuit, jamCookie);
    this.celebration = new LevelCelebration(jamCookie, scoreBiscuit);
    this.results = new ResultsPanel(companion, this.textResolution);
    this.vacancyArt = new VacancyArt(this.texture('clear'));
    this.root.once('destroyed', () => {
      this.contactTexture.destroy(true);
      this.backdropColor.destroy();
      this.vacancyArt.destroy();
      this.joker?.destroy();
      this.releasePreparedText();
      for (const effect of this.matchPool) {
        if (!effect.root.destroyed) effect.root.destroy({ children: true });
      }
    });
    this.root.addChild(this.backdrop, this.content, this.scrim, this.overlay);
    this.content.addChild(this.icingVial.root, this.board);
    this.flight = sprite(this.content, Texture.EMPTY);
    this.flight.anchor.set(0.5, 1);
    this.flight.visible = false;
    this.content.addChild(this.doughRepairCue, this.selectionCue, this.feedbackCue, this.arrow.root, this.hintArrow.root,
      this.firstMatchHand.root,
      this.boosterCue.root, this.celebration.root, this.hud, this.moveCost.root, this.matchEffects, this.freeBooster.root);

    const logo = sprite(this.hud, this.texture('vanilla-bean-wordmark'), CENTER, 49, 282, 96);
    logo.anchor.set(0.5);
    this.hud.addChild(this.scoreBar.root);
    this.status = label(this.hud, '', 13, FOOTER_STATUS_X, 0);
    this.hintStatus = label(this.hud, '', 13, FOOTER_STATUS_X, 0);
    this.boosterPrompt = label(this.hud, '', 14, FOOTER_STATUS_X, 0, '#ffedb9');
    this.status.style.lineHeight = this.hintStatus.style.lineHeight = this.boosterPrompt.style.lineHeight = 13;
    this.status.style.align = this.hintStatus.style.align = this.boosterPrompt.style.align = 'center';
    this.boosterPrompt.style.stroke = { color: INK, width: 2.5, join: 'round' };
    this.boosterPrompt.visible = false;
    this.hud.addChild(this.boosterControls.root);
    const { width, height } = this.hintBounds;
    this.hintFace = sprite(this.hintButton, this.texture('vanilla-bean-hint'), 0, 0, width, height);
    this.hintLabel = label(this.hintButton, 'Hint', 25, width / 2, height * 0.45);
    this.hintLabel.style.fontWeight = '700';
    this.setHintAvailable(false);
    this.hud.addChild(this.hintButton);

    this.overlay.addChild(this.results.root);
    this.textResolution.trackTree(this.root);
  }

  syncTextResolution(rendererResolution: number): boolean {
    if (!this.textResolution.set(rendererResolution, this.fit.scale)) return false;
    this.releasePreparedText();
    return true;
  }

  *warmup(renderer: Renderer, reduced: boolean): Generator<void> {
    for (const item of this.warmResources(reduced)) {
      if (item instanceof Texture) renderer.texture.initSource(item.source);
      else if (item instanceof Text) {
        item.getLocalBounds();
        // Prepare's Text handler only makes a batchable. Acquire the same
        // managed texture the canvas text pipe uses on actual reveal.
        const system = renderer.canvasText;
        const key = item.styleKey;
        if (!this.preparedText.has(key)) {
          const texture = system.getManagedTexture(item);
          this.preparedText.set(key, () => system.decreaseReferenceCount(key));
          renderer.texture.initSource(texture.source);
        }
      } else if (item) {
        // Populate the batches used by the graphics pipe while the scene is idle.
        renderer.graphicsContext.updateGpuContext(item);
      }
      yield;
    }
  }

  private releasePreparedText(): void {
    for (const release of this.preparedText.values()) release();
    this.preparedText.clear();
  }

  private *warmResources(reduced: boolean): Generator<GraphicsContext | Text | Texture | undefined> {
    // Opening stacks hold three pieces with five slots. A transfer or clear can
    // expose three, four or five openings before the refill brings pieces back.
    for (const count of [3, 4, 5]) {
      if (count <= this.capacity) yield this.vacancyArt.texture(count, this.layout.step / this.layout.donutHeight);
    }
    let effect = this.matchPool[0];
    if (!effect) {
      effect = this.addMatchEffect();
      yield;
    }
    yield* effect.warmup(reduced);
    yield* this.results.warmup();
  }

  private addMatchEffect(): MatchEffect {
    const effect = new MatchEffect();
    this.textResolution.trackTree(effect.root);
    this.matchPool.push(effect);
    return effect;
  }

  private texture(name: string): Texture {
    if (name === JOKER) {
      this.joker ??= new JokerArt(this.art.get(JOKER)!);
      return this.joker.texture;
    }
    return this.art.get(name)!;
  }

  showJoker(now: number, reduced: boolean): void {
    this.joker?.update(now, reduced);
  }

  resize(width: number, height: number, safeAreaBottom = 0): void {
    this.hideMoveGuides();
    this.clearHint();
    this.fit = viewport(width, height, safeAreaBottom);
    for (const layer of [this.content, this.overlay]) {
      layer.position.set(this.fit.x, this.fit.y);
      layer.scale.set(this.fit.scale);
    }
    this.backdrop.clear().rect(0, 0, width, height).fill(this.backdropColor);
    this.icingVial.resize(this.fit.height);
    this.scrim.clear().rect(0, 0, width, height).fill({ color: 0x4e2019, alpha: 0.6 });
    const footerY = footerCenterY(this.fit.height);
    this.status.y = footerY - 14;
    this.hintStatus.y = this.status.y;
    this.boosterPrompt.y = footerY + 14;
    this.boosterControls.resize(this.fit.height);
    this.hintBounds.y = footerY - HINT_HEIGHT / 2;
    this.hintButton.position.set(this.hintBounds.x, this.hintBounds.y);
    this.results.resize(this.fit.height);
  }

  showResults(view: ResultsView | null): void {
    this.scrim.visible = this.overlay.visible = view !== null;
    if (view) {
      this.setHintAvailable(false);
      this.clearHint();
      this.results.show(view, this.fit.height, this.endReason);
    }
  }

  canScrollResults(point: Point): boolean {
    return this.overlay.visible && this.results.canScroll(point);
  }

  scrollResults(delta: number): boolean {
    return this.overlay.visible && this.results.scrollBy(delta);
  }

  showGameOverCue(progress: number | null, reduced: boolean): void {
    if (progress === null && !this.gameOverCueVisible) return;
    this.gameOverCueVisible = progress !== null;
    const strength = progress === null ? 0 : reduced ? 1 : Math.sin(Math.PI * progress);
    const rotation = progress === null || reduced ? 0 : 0.085 * strength * Math.sin(4 * Math.PI * progress);
    const green = Math.round(255 - 68 * strength);
    const blue = Math.round(255 - 90 * strength);
    const tint = 0xff0000 | (green << 8) | blue;
    for (const { top } of this.stacks) {
      if (!top) continue;
      // Only the exposed donut moves. The stack, its shadow, and the tray stay put.
      const donut = top.children[1] as Sprite;
      donut.tint = tint;
      donut.rotation = rotation;
    }
  }

  setHintAvailable(available: boolean): void {
    this.hintAvailable = available;
    this.hintFace.alpha = available ? 1 : 0.56;
    this.hintFace.tint = available ? 0xffffff : 0xe9ded1;
    this.hintLabel.style.fill = available ? '#731328' : '#755f54';
  }

  setBoosterControls(view: BoosterFooterView): void {
    this.boosterControls.show(view);
    this.boosterPrompt.visible = view.visible && (view.armed || view.adUnavailable);
    setFooterStatus(this.boosterPrompt, view.armed ? 'Pick a stack' : 'Ad\nunavailable');
  }

  startBoosterCue(kind: BoosterButton, targets: readonly { stack: number; color: string }[], now: number, reduced: boolean): void {
    const { donutWidth: width, donutHeight: height, step } = this.layout;
    const marks = targets.map(({ stack, color }) => {
      const { slot, pieces } = this.stacks[stack];
      return { x: slot.x, y: slot.base - (pieces.length - 1) * step - height / 2,
        width, height, texture: kind === 'sweep' ? this.texture(color) : undefined };
    });
    this.boosterCue.start(kind, marks, now, reduced);
  }

  showBoosterCue(now: number, reduced: boolean): void {
    this.boosterCue.show(now, reduced);
  }

  cancelBoosterCue(): void {
    this.boosterCue.cancel();
  }

  startFreeBoosterCelebration(kind: BoosterButton, now: number, reduced: boolean): void {
    this.freeBooster.start(kind, this.boosterControls.dropTarget(kind), now, reduced);
    this.showFreeBoosterCelebration(now);
  }

  showFreeBoosterCelebration(now: number): void {
    this.boosterControls.showDropLanding(this.freeBooster.show(now));
  }

  cancelFreeBoosterCelebration(kind?: BoosterButton): void {
    if (this.freeBooster.cancel(kind)) this.boosterControls.showDropLanding(null);
  }

  showHint(move: { from: number; to: number } | null): void {
    this.clearHint();
    if (!move) {
      setFooterStatus(this.hintStatus, 'No verified\nhint');
      return;
    }
    const { slot, pieces } = this.stacks[move.to];
    const landing = slot.base - pieces.length * this.layout.step - this.layout.donutHeight * 0.58;
    this.hintArrow.show(this.guidePoint(move.from), { x: slot.x, y: landing }, 'hint');
  }

  clearHint(): void {
    this.hintArrow.hide();
    this.hintStatus.text = '';
  }

  showFirstMatchGuide(move: { from: number; to: number } | null, now: number, motion: FirstMatchHandMotion): boolean {
    if (!move) {
      this.hideFirstMatchGuide();
      return false;
    }

    const offset = this.layout.donutHeight * 0.86;
    const source = this.topPosition(move.from);
    const destination = this.topPosition(move.to);
    return this.firstMatchHand.show(move, { x: source.x, y: source.y - offset },
      { x: destination.x, y: destination.y - offset }, now, motion);
  }

  pauseFirstMatchGuide(): void {
    this.firstMatchHand.pause();
  }

  hideFirstMatchGuide(): void {
    this.firstMatchHand.hide();
  }

  draw(state: GameState, refreshVial = true): void {
    this.finishMove();
    this.finishStackUnlock();
    this.hideMoveGuides();
    this.capacity = state.capacity;
    for (const child of this.board.removeChildren()) child.destroy({ children: true });
    this.layout = layoutStacks(this.fit.height, state.stacks.length, state.capacity);
    this.vacancyArt.keepStrides(this.layout.step / this.layout.donutHeight);
    this.stacks = state.stacks.map((colors, index) => this.createStack(colors, this.layout.slots[index], this.layout));
    this.updateVacancies();
    this.gameOver = state.gameOver;
    this.endReason = state.endReason;
    if (refreshVial) this.icingVial.sync(state);
    this.boardSwaps = getBoardRepair(state)?.swaps ?? [];
  }

  showIcingVial(now: number, still: boolean): void {
    if (this.icingVial.animating || this.icingVial.deadline) this.icingVial.show(now, still);
  }

  private createDonut(group: Container, color: string): Container {
    const layer = group.addChild(new Container());
    sprite(layer, this.contactTexture).anchor.set(0.5);
    sprite(layer, this.texture(color)).anchor.set(0.5, 1);
    return layer;
  }

  private createStack(colors: readonly string[], slot: StackSlot, layout: StackLayout): StackView {
    const { donutWidth, donutHeight } = layout;
    const group = this.board.addChild(new Container());
    const rail = group.addChild(new Container());
    const railHalf = drawCapacity(rail, colors.length, this.capacity, donutWidth, this.textResolution);
    const vacancies = sprite(group, Texture.EMPTY);
    vacancies.eventMode = 'none';
    vacancies.anchor.set(0.5, 1);
    vacancies.visible = false;
    const pieces = colors.map(color => this.createDonut(group, color));
    const top = pieces.at(-1);
    const refillCue = group.addChild(new Graphics({ visible: false }));
    const side = donutWidth * 0.44;
    const y = -donutHeight * 0.21;
    refillCue.moveTo(-side, y - 5).lineTo(-side - 3, y - 2).lineTo(-side, y + 2)
      .moveTo(side, y - 5).lineTo(side + 3, y - 2).lineTo(side, y + 2)
      .stroke({ color: 0xffdfa0, width: 2.6, cap: 'round', join: 'round' });
    const view: StackView = {
      group, rail, railHalf, railCount: colors.length, slot, hit: slot.hit,
      vacancies, vacancyCount: 0, pieces, refillCue, cueWidth: donutWidth, cueHeight: donutHeight,
      top, topShadow: top?.children[0] as Sprite | undefined, topY: slot.base,
    };
    this.placeStack(view, slot, layout);
    return view;
  }

  private placeStack(view: StackView, slot: StackSlot, { donutWidth, donutHeight, step }: StackLayout): void {
    view.slot = slot;
    view.hit = stackHit(slot, this.capacity, donutHeight, step);
    view.rail.position.set(slot.x, slot.base);
    view.rail.scale.x = capacityRail(donutWidth, this.capacity).half / view.railHalf;
    view.refillCue.scale.set(donutWidth / view.cueWidth, donutHeight / view.cueHeight);
    view.pieces.forEach((piece, depth) => {
      piece.position.set(slot.x, slot.base - depth * step);
      const [shadow, donut] = piece.children as Sprite[];
      shadow.y = -donutHeight * 0.02;
      shadow.width = donutWidth * (depth === 0 ? 1.04 : 0.82);
      shadow.height = donutHeight * 0.16;
      donut.width = donutWidth;
      donut.height = donutHeight;
    });
    view.topY = view.top?.y ?? slot.base;
  }

  startStackUnlock(state: GameState, inserts: readonly DoughInsert[], now: number, reduced: boolean): void {
    const before = this.layout;
    const after = layoutStacks(this.fit.height, state.stacks.length, state.capacity);
    const refills = refillPlan(state.stacks.map(stack => stack.length), inserts);
    this.hideMoveGuides();
    this.capacity = state.capacity;
    this.vacancyArt.keepStrides(before.step / before.donutHeight, after.step / after.donutHeight);
    this.layout = reduced ? after : before;
    this.stackUnlock = reduced ? null : { before, after, started: now, progress: 0 };
    this.stacks.forEach((view, index) => {
      // Refill positions identify new pieces independently of their colors.
      const remaining = view.pieces.filter(piece => piece.visible);
      for (const piece of view.pieces) if (!piece.visible) piece.destroy({ children: true });
      const motions = refills.stacks.get(index);
      let survivor = 0;
      view.pieces = state.stacks[index].map((color, depth) => {
        const piece = motions?.[depth].entry === undefined ? remaining[survivor++] : this.createDonut(view.group, color);
        (piece.children[1] as Sprite).texture = this.texture(color);
        return view.group.addChild(piece);
      });
      view.group.addChild(view.refillCue);
      view.top = view.pieces.at(-1);
      view.topShadow = view.top?.children[0] as Sprite | undefined;
      this.placeStack(view, this.layout.slots[index], this.layout);
      if (reduced) {
        view.vacancyCount = -1;
        view.railCount = view.pieces.length;
        view.railHalf = drawCapacity(view.rail, view.railCount, this.capacity, after.donutWidth, this.textResolution);
        view.rail.scale.x = 1;
      }
    });
    const firstNewStack = this.stacks.length;
    for (let index = firstNewStack; index < state.stacks.length; index++) {
      const added = this.createStack(state.stacks[index], after.slots[index], after);
      added.group.visible = reduced;
      this.stacks.push(added);
    }
    this.gameOver = state.gameOver;
    this.endReason = state.endReason;
    this.boardSwaps = getBoardRepair(state)?.swaps ?? [];
    if (inserts.length || this.boardSwaps.length) this.playMove(refills, now, reduced);
    else this.showMove(now);
    if (reduced) {
      this.updateVacancies();
      this.vacancyArt.keepStrides(after.step / after.donutHeight);
    }
  }

  private showStackUnlock(now: number): void {
    const unlock = this.stackUnlock;
    if (!unlock) return;
    const { before, after, started } = unlock;
    if (now - started >= STACK_UNLOCK_MS) {
      this.finishStackUnlock();
      return;
    }
    const frame = stackUnlockFrame(before, after, now - started);
    unlock.progress = frame.progress;
    this.layout = frame.layout;
    frame.layout.slots.forEach((slot, index) => this.placeStack(this.stacks[index], slot, frame.layout));
    for (const { group, slot } of this.stacks.slice(before.slots.length)) {
      group.visible = frame.entrance > 0;
      group.alpha = frame.entrance;
      group.pivot.set(slot.x, slot.base);
      group.position.set(slot.x, slot.base + frame.trayOffset);
      group.scale.set(frame.trayScale);
    }
  }

  finishStackUnlock(): void {
    const unlock = this.stackUnlock;
    if (!unlock) return;
    const { after } = unlock;
    this.stackUnlock = null;
    this.layout = after;
    this.stacks.forEach((view, index) => {
      view.group.visible = true;
      view.group.alpha = 1;
      view.group.pivot.set(0);
      view.group.position.set(0);
      view.group.scale.set(1);
      view.alternateVacancies?.destroy();
      view.alternateVacancies = undefined;
      view.vacancyCount = -1;
      const slot = after.slots[index];
      this.placeStack(view, slot, after);
      view.railCount = view.pieces.length;
      view.railHalf = drawCapacity(view.rail, view.railCount, this.capacity, after.donutWidth, this.textResolution);
      view.rail.scale.x = 1;
    });
    this.updateVacancies();
    this.vacancyArt.keepStrides(after.step / after.donutHeight);
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
      const stackHeight = donutHeight + (this.capacity - 1) * step;
      for (const { slot } of this.stacks.slice(upgrade.firstNewStack, upgrade.stackCount)) {
        markers.push({
          x: slot.x - donutWidth / 2 - 4, y: slot.base - stackHeight - 4,
          width: donutWidth + 8, height: stackHeight + 22,
        });
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
    const unlock = this.stackUnlock;
    for (const [index, stack] of this.stacks.entries()) {
      const { slot, vacancies, pieces } = stack;
      const moving = unlock && index < unlock.before.slots.length ? unlock : null;
      const geometry = unlock && !moving ? unlock.after : this.layout;
      const { donutWidth } = geometry;
      // Count the visible stack while a transfer, clear or refill is playing.
      let occupied = 0;
      for (const piece of pieces) {
        if (piece.visible && piece.alpha > 0) occupied++;
      }
      const count = this.capacity - occupied;
      if (unlock && occupied !== stack.railCount) {
        stack.railCount = occupied;
        stack.railHalf = drawCapacity(stack.rail, occupied, this.capacity, donutWidth, this.textResolution);
        stack.rail.scale.x = 1;
      }
      if (!moving && count === stack.vacancyCount) continue;
      stack.vacancyCount = count;
      vacancies.visible = count > 0;
      if (stack.alternateVacancies) stack.alternateVacancies.visible = false;
      if (!count) continue;
      const from = moving?.before ?? geometry;
      this.placeVacancies(vacancies, count, slot, occupied, geometry, from);
      const mix = moving && Math.abs(moving.after.step / moving.after.donutHeight - from.step / from.donutHeight) > 1e-6
        ? moving.progress : 0;
      vacancies.alpha = 1 - mix;
      if (moving && mix) {
        if (!stack.alternateVacancies) {
          const alternate = new Sprite({ texture: Texture.EMPTY, anchor: { x: 0.5, y: 1 }, eventMode: 'none' });
          stack.alternateVacancies = stack.group.addChildAt(alternate, stack.group.getChildIndex(vacancies) + 1);
        }
        this.placeVacancies(stack.alternateVacancies, count, slot, occupied, geometry, moving.after);
        stack.alternateVacancies.alpha = mix;
        stack.alternateVacancies.visible = true;
      }
    }
  }

  private placeVacancies(sprite: Sprite, count: number, slot: StackSlot, occupied: number, layout: StackLayout, art: StackLayout): void {
    const { donutWidth, donutHeight, step } = layout;
    sprite.texture = this.vacancyArt.texture(count, art.step / art.donutHeight);
    sprite.position.set(slot.x, slot.base - occupied * step);
    sprite.width = donutWidth;
    sprite.height = donutHeight + (count - 1) * step;
  }

  toLocal(point: Point): Point {
    return { x: (point.x - this.fit.x) / this.fit.scale, y: (point.y - this.fit.y) / this.fit.scale };
  }

  hit(point: Point, mode: HitMode = 'exact', duringUnlock = false): Target {
    if (this.stackUnlock) return duringUnlock ? this.hitMovingStack(point) : null;
    if (this.overlay.visible) return this.results.hit(point);
    if (this.gameOver) return null;
    if (this.hintAvailable && contains(this.hintBounds, point)) return 'hint';
    return this.boosterControls.hit(point) ?? stackTarget(this.stacks, point, this.fit.height, mode);
  }

  private hitMovingStack(point: Point): Target {
    const height = this.fit.height;
    if (stackTarget([], point, height, 'exact') === 'outside') return 'outside';
    const { donutWidth, donutHeight, step } = this.layout;
    let target: number | null = null;
    // The new tray is actionable once it lands. The old slots move with their racks.
    for (let index = 0; index < this.layout.slots.length; index++) {
      const { slot } = this.stacks[index];
      const hit = { x: slot.x - donutWidth / 2, y: BOARD_TOP,
        width: donutWidth, height: height - BOARD_TOP - BOARD_FOOTER_SPACE };
      if (!contains(stackHit({ ...slot, hit }, this.capacity, donutHeight, step), point)) continue;
      if (target !== null) return null;
      target = index;
    }
    return target;
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
    if (!inserts.length && !this.boardSwaps.length && (!transfer || reduced)) return;
    const refills = refillPlan(this.stacks.map(stack => stack.pieces.length), inserts);
    this.playMove(refills, started, reduced, transfer);
  }

  startMoveCost(to: number, started: number, reduced: boolean, remaining: number): void {
    const { x, y } = this.movePresentation?.transfer?.landing ?? this.topPosition(to);
    this.moveCost.enqueue({ x, y: y - this.layout.donutHeight * 0.62 }, started + (reduced ? 0 : FLIGHT_MS), reduced, remaining);
  }

  startMoveRecovery(recovery: MoveRecovery, now: number, reduced: boolean): void {
    this.moveCost.recover(recovery, now, reduced);
  }

  showMoveCosts(now: number): void {
    const boardLeft = Math.min(...this.layout.slots.map(slot => slot.hit.x));
    const cue = this.moveCost.show(now, this.fit.height, remaining => this.icingVial.spendTarget(remaining), boardLeft);
    if (!cue) return;
    if ('recovery' in cue) this.icingVial.apply(cue.recovery.remaining, now, cue.reduced, cue.recovery);
    else this.icingVial.apply(cue.remaining, now, cue.reduced);
  }

  clearMoveCosts(state: Pick<GameState, 'doughMeter'>): void {
    this.moveCost.clear();
    this.icingVial.sync(state);
  }

  private playMove(refills: MovePresentation['refills'], started: number, reduced: boolean, transfer?: Transfer): void {
    const transferDelay = reduced ? REDUCED_TRANSFER_REFILL_DELAY_MS : FLIGHT_MS + LAND_MS;
    const refillDelay = transfer ? transferDelay : 0;
    const swaps = this.boardSwaps;
    this.boardSwaps = [];
    this.movePresentation = { started, reduced, refills, refillDelay, swaps };
    if (transfer && !reduced) {
      const { slot, pieces } = this.stacks[transfer.to];
      const depth = refills.stacks.get(transfer.to)?.at(-1)?.depth ?? pieces.length - 1;
      this.movePresentation.transfer = { ...transfer, landing: { x: slot.x, y: slot.base - depth * this.layout.step } };
      this.flight.texture = this.texture(transfer.color);
      this.flight.width = this.layout.donutWidth;
      this.flight.height = this.layout.donutHeight;
    }
    this.showMove(started);
  }

  private showDoughRepairs(move: MovePresentation, age: number, duration: number): void {
    const progress = move.reduced ? 1 : unit(age / (duration * 0.78));
    const marks = this.doughRepairCue;
    marks.clear();
    const side = this.layout.donutWidth * 0.5;
    for (const [a, b] of move.swaps) {
      const first = this.stacks[a.stack].pieces[a.depth];
      const second = this.stacks[b.stack].pieces[b.depth];
      const firstPosition = flightPosition(second, first, progress, 18);
      const secondPosition = flightPosition(first, second, progress, -12);
      first.pivot.set(first.x - firstPosition.x, first.y - firstPosition.y);
      second.pivot.set(second.x - secondPosition.x, second.y - secondPosition.y);
      if (age >= duration) continue;
      for (const { x, y } of [firstPosition, secondPosition]) {
        const center = y - this.layout.donutHeight * 0.24;
        marks.moveTo(x - side + 2, center - 5).lineTo(x - side - 2, center).lineTo(x - side + 2, center + 5)
          .moveTo(x + side - 2, center - 5).lineTo(x + side + 2, center).lineTo(x + side - 2, center + 5);
      }
    }
    marks.visible = age < duration;
    if (!marks.visible) return;
    marks.stroke({ color: 0x702334, width: 4.5, cap: 'round', join: 'round' });
    marks.stroke({ color: 0xffe6a9, width: 2.3, cap: 'round', join: 'round' });
    marks.alpha = move.reduced ? 1 : 1 - unit((age / duration - 0.65) / 0.35);
  }

  showMove(now: number): void {
    this.showStackUnlock(now);
    const move = this.movePresentation;
    if (!move) {
      if (this.stackUnlock) this.updateVacancies();
      return;
    }
    const { started, reduced, refills, refillDelay, transfer } = move;
    const { donutHeight, step } = this.layout;
    const age = now - started;
    const refillAge = age - refillDelay;
    const repairDuration = move.swaps.length ? (reduced ? REDUCED_DOUGH_REPAIR_MS : DOUGH_REPAIR_MS) : 0;
    if (refillAge >= refillDuration(refills.duration, reduced) && age >= repairDuration) {
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
        if (this.stackUnlock) {
          (piece.children[0] as Sprite).width = this.layout.donutWidth * (1.04 - 0.22 * unit(frame.depth));
        }
        if (frame.accent > 0) {
          refillCue.visible = true;
          refillCue.alpha = frame.accent;
          refillCue.position.set(slot.x, piece.y);
        }
      });
    }
    if (repairDuration && (age < repairDuration || this.doughRepairCue.visible)) this.showDoughRepairs(move, age, repairDuration);
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
    for (const swap of move.swaps) {
      for (const { stack, depth } of swap) this.stacks[stack].pieces[depth].pivot.set(0);
    }
    this.doughRepairCue.visible = false;
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
    this.movePresentation = null;
    this.updateVacancies();
  }

  startMatch(match: MatchPlayback): void {
    const target = this.stacks[match.to];
    const { donutWidth, donutHeight, step } = this.layout;
    let effect = this.matchPool.find(effect => !effect.active);
    if (!effect) {
      effect = this.addMatchEffect();
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
    }, this.texture(match.color), match.jokerIndex === undefined ? undefined : this.joker);
    this.matchedDestination = target.pieces.slice(-(match.runLength - 1));
    this.stacks[match.from].top!.visible = false;
    this.updateVacancies();
    this.hideMoveGuides();
    this.flight.visible = false;
    this.status.text = '';
  }

  showMatch(frame: MatchFrame): void {
    this.currentMatch?.showPieces(frame);
    if (frame.phase !== 'arrival') {
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
      this.feedbackCue.alpha = reduced ? 1 : 1 - 0.7 * (now - feedback.started) / feedback.duration;
    }

    setFooterStatus(this.status, feedback ? 'That stack\nis full' : '');
    this.status.style.fill = feedback ? RED : INK;
  }
}
