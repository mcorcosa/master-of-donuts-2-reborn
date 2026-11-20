export interface GameState {
  stacks: string[][];
  score: number;
  level: number;
  rank: string;
  capacity: number;
  nextLevelScore: number;
  movesLeft: number;
  gameOver: boolean;
}

export interface DoughInsert {
  stack: number;
  /** Bottom-first index just before this donut is inserted. */
  depth: number;
  color: string;
}

const COLORS = ['gold', 'red', 'yellow', 'choco', 'gray', 'purple', 'blue', 'green'];
const RANKS = [
  'Dough Enthusiast', 'Pastry Pupil', 'Fryer Fighter', 'Batter Boss',
  'Glaze Guru', 'Sprinkle Sage', 'Yeast Yoda', 'Doughnut Dynamo',
  'Fryer Freak', 'Pastry Prodigy', 'Glaze Gourmet', 'Sprinkle Sensei',
  'Master Mixer', 'Fryer Phenom', 'Donut Demigod', 'Master of Donuts',
];
const SCORE_TARGETS = [
  500, 1500, 2500, 3500, 4500, 6500, 8500, 10500,
  12500, 14500, 17500, 20500, 23500, 26500, 29500, 34500,
];
const MOVE_LIMIT = 7;
const paletteKey = Symbol('palette');
type RunState = GameState & { [paletteKey]?: string[] };

function shuffled<T>(items: T[], rng: () => number): T[] {
  const result = items.slice();
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function randomColor(colors: string[], rng: () => number): string {
  return colors[Math.floor(rng() * colors.length)];
}

function topPair(stack: string[]): string | undefined {
  return stack.at(-1) === stack.at(-2) ? stack.at(-1) : undefined;
}

export function matchedRunLength(destinationBefore: readonly string[], incoming: string): number {
  let count = 1;
  for (let i = destinationBefore.length - 1; i >= 0 && destinationBefore[i] === incoming; i--) count++;
  return count >= 3 ? count : 0;
}

function totalSpace(stacks: string[][], capacity: number): number {
  return stacks.reduce((free, stack) => free + capacity - stack.length, 0);
}

function shortestStacks(stacks: string[][], capacity: number): string[][] {
  return stacks.filter((stack) => stack.length < capacity).sort((a, b) => a.length - b.length);
}

function isGameOver(stacks: string[][], capacity: number): boolean {
  const space = totalSpace(stacks, capacity);
  if (space > 1) return false;
  if (space === 0) return true;

  // With one slot left, a full stack's top donut must be able to complete a pair,
  // either in the open stack or in the pair exposed by moving a full stack's top.
  const fullTops = new Set(stacks.filter((stack) => stack.length === capacity).map((stack) => stack.at(-1)));
  return !stacks.some((stack) => {
    const pair = stack[capacity - 2];
    return pair !== undefined && pair === stack[capacity - 3] && fullTops.has(pair);
  });
}

function insertDough(state: GameState, inserts: DoughInsert[], stack: string[], depth: number, color: string): void {
  stack.splice(depth, 0, color);
  inserts.push({ stack: state.stacks.indexOf(stack), depth, color });
}

function refill(state: GameState, inserts: DoughInsert[], colors: string[], rng: () => number, match?: string): void {
  const { stacks, capacity } = state;
  const insert = (stack: string[], color: string): void => {
    insertDough(state, inserts, stack, 0, color);
    state.gameOver = isGameOver(stacks, capacity);
  };

  if (match !== undefined) {
    // Moving opens a slot in the source, and clearing opens slots in the target.
    const targets = shortestStacks(stacks, capacity).slice(0, 2);
    const otherColors = colors.filter((color) => color !== match);
    for (const stack of targets) {
      // Legacy protects the top pair even though refill enters at the bottom.
      insert(stack, topPair(stack) === match ? randomColor(otherColors, rng) : match);
      if (state.gameOver) return;
    }
    if (totalSpace(stacks, capacity) <= 2) return;
  }

  const count = match === undefined ? Math.floor(state.level / 5) + 1 : 1;
  for (let i = 0; i < count; i++) {
    const [stack] = shortestStacks(stacks, capacity);
    const pair = topPair(stack);
    const choices = colors.filter((color) => color !== match && color !== pair);
    insert(stack, randomColor(choices, rng));
    if (state.gameOver) return;
  }
}

function hasScoringMove(stacks: string[][], capacity: number): boolean {
  return stacks.some((target) => {
    if (target.length >= capacity) return false;
    const pair = topPair(target);
    return pair !== undefined && stacks.some((source) => source !== target && source.at(-1) === pair);
  });
}

function hasQuickScore({ stacks, capacity, movesLeft }: GameState): boolean {
  if (hasScoringMove(stacks, capacity)) return true;
  if (movesLeft <= 1) return false;

  // Check one setup move while it is still safe to miss without a pressure refill.
  for (const source of stacks) {
    const incoming = source.at(-1);
    if (incoming === undefined) continue;
    for (const target of stacks) {
      if (source === target || target.length >= capacity) continue;
      source.pop();
      target.push(incoming);
      const canScore = hasScoringMove(stacks, capacity);
      target.pop();
      source.push(incoming);
      if (canScore) return true;
    }
  }
  return false;
}

function refillLargeMatch(
  state: GameState, inserts: DoughInsert[], colors: string[], rng: () => number, match: string, from: number, to: number,
): void {
  const cleared = state.stacks;
  state.stacks = cleared.map((stack) => stack.slice());
  const trial: DoughInsert[] = [];
  refill(state, trial, colors, rng, match);
  if (hasQuickScore(state)) {
    inserts.push(...trial);
    return;
  }

  state.stacks = cleared;
  const empty = cleared.find((stack) => stack.length === 0);
  const donor = cleared.find((stack) => stack.length > 0);
  if (empty && donor) {
    const color = donor.at(-1)!;
    insertDough(state, inserts, empty, 0, colors.find((other) => other !== color)!);
    insertDough(state, inserts, empty, 1, color);
    insertDough(state, inserts, empty, 2, color);
    return;
  }

  // Clearing four or more leaves at least four slots in the destination and
  // moving leaves at least one in the source. The pair and donor give a scoring
  // move even when the very next miss would trigger a fatal pressure refill.
  const retainedTop = cleared[to].at(-1);
  const rescueColor = donor ? colors.find((color) => color !== match && color !== retainedTop)! : match;
  insertDough(state, inserts, cleared[to], cleared[to].length, rescueColor);
  insertDough(state, inserts, cleared[to], cleared[to].length, rescueColor);
  insertDough(state, inserts, cleared[from], cleared[from].length, rescueColor);
}

function advanceLevel(state: RunState, inserts: DoughInsert[], colors: string[], rng: () => number): void {
  state.level++;
  const { level } = state;
  state.rank = RANKS[Math.min(level, RANKS.length) - 1];
  state.nextLevelScore = SCORE_TARGETS[level - 1] ?? state.nextLevelScore + 3000;

  if (level > RANKS.length) return;
  if (level % 3 === 2) {
    state.capacity++;
  } else if (level % 3 === 0) {
    const stack: string[] = [];
    state.stacks.push(stack);
    for (let i = 0; i < Math.floor(state.capacity * 0.75); i++) {
      const pair = topPair(stack);
      insertDough(state, inserts, stack, i, randomColor(colors.filter((color) => color !== pair), rng));
    }
  }
}

export function createGame(rng: () => number = Math.random): GameState {
  const palette = shuffled(COLORS, rng);
  const startingColors = palette.slice(0, 3);
  const pack = shuffled([...startingColors, ...startingColors, ...startingColors], rng);
  const stacks: string[][] = [[], [], []];
  pack.reverse().forEach((color, i) => stacks[i % stacks.length].push(color));

  // A monochrome stack holds all three copies of that color, so a top swap fixes
  // it without creating a monochrome neighbor or changing the opening inventory.
  stacks.forEach((stack, i) => {
    if (stack[0] === stack[1] && stack[0] === stack[2]) {
      const neighbor = stacks[(i + 1) % stacks.length];
      [stack[2], neighbor[2]] = [neighbor[2], stack[2]];
    }
  });

  const state: RunState = {
    stacks,
    score: 0,
    level: 1,
    rank: RANKS[0],
    capacity: 5,
    nextLevelScore: SCORE_TARGETS[0],
    movesLeft: MOVE_LIMIT,
    gameOver: false,
    [paletteKey]: palette,
  };
  return state;
}

export function canMove(state: GameState, from: number, to: number): boolean {
  if (state.gameOver || from === to || !Number.isInteger(from) || !Number.isInteger(to)) return false;
  const source = state.stacks[from];
  const target = state.stacks[to];
  return source !== undefined && target !== undefined && source.length > 0 && target.length < state.capacity;
}

export function move(
  state: GameState, from: number, to: number, rng: () => number = Math.random,
  onDough?: (inserts: readonly DoughInsert[]) => void,
): GameState {
  if (!canMove(state, from, to)) return state;

  const next: RunState = { ...state, stacks: state.stacks.map((stack) => stack.slice()) };
  const source = next.stacks[from];
  const target = next.stacks[to];
  const color = source.pop()!;
  const matched = matchedRunLength(target, color);
  target.push(color);
  if (!matched) {
    next.movesLeft--;
    if (next.movesLeft > 0) return next;
    next.movesLeft = MOVE_LIMIT;
  }

  // Keep the original shuffle so future colors unlock in the same run order,
  // including colors that have unlocked but have yet to enter a stack.
  const palette = next[paletteKey] ?? [...new Set([...state.stacks.flat(), ...COLORS])];
  const colorCount = Math.min(COLORS.length, 3 + Math.floor((state.level - 1) / 3));
  const colors = palette.slice(0, colorCount);
  const inserts: DoughInsert[] = [];
  if (matched) {
    target.splice(-matched);
    next.score += 100 + (state.level - 1) * 10;
    if (matched === 3) refill(next, inserts, colors, rng, color);
    else refillLargeMatch(next, inserts, colors, rng, color, from, to);
    if (next.score >= next.nextLevelScore) advanceLevel(next, inserts, colors, rng);
  } else {
    refill(next, inserts, colors, rng);
  }
  onDough?.(inserts);
  return next;
}
