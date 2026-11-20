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

function refill(state: RunState, colors: string[], rng: () => number, match?: string): void {
  const { stacks, capacity } = state;
  const insert = (stack: string[], color: string): void => {
    stack.unshift(color);
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

function advanceLevel(state: RunState, colors: string[], rng: () => number): void {
  state.level++;
  const { level } = state;
  state.rank = RANKS[Math.min(level, RANKS.length) - 1];
  state.nextLevelScore = SCORE_TARGETS[level - 1] ?? state.nextLevelScore + 3000;

  if (level > RANKS.length) return;
  if (level % 3 === 2) {
    state.capacity++;
  } else if (level % 3 === 0) {
    const stack: string[] = [];
    for (let i = 0; i < Math.floor(state.capacity * 0.75); i++) {
      const pair = topPair(stack);
      stack.push(randomColor(colors.filter((color) => color !== pair), rng));
    }
    state.stacks.push(stack);
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

export function move(state: GameState, from: number, to: number, rng: () => number = Math.random): GameState {
  if (!canMove(state, from, to)) return state;

  const next: RunState = { ...state, stacks: state.stacks.map((stack) => stack.slice()) };
  const source = next.stacks[from];
  const target = next.stacks[to];
  const color = source.pop()!;
  target.push(color);
  const matched = topPair(target) === color && target.at(-3) === color;
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
  if (matched) {
    target.splice(-3);
    next.score += 100 + (state.level - 1) * 10;
    refill(next, colors, rng, color);
    if (next.score >= next.nextLevelScore) advanceLevel(next, colors, rng);
  } else {
    refill(next, colors, rng);
  }
  return next;
}
