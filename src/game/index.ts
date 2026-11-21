export interface GameState {
  stacks: string[][];
  score: number;
  combo?: number;
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
export const JOKER = 'joker';
const FIRST_JOKER_LEVEL = 7;
const JOKER_REFILL_INTERVAL = 45;
const RANKS = [
  'Dough Enthusiast', 'Pastry Pupil', 'Fryer Fighter', 'Batter Boss',
  'Glaze Guru', 'Sprinkle Sage', 'Yeast Yoda', 'Doughnut Dynamo',
  'Fryer Freak', 'Pastry Prodigy', 'Glaze Gourmet', 'Sprinkle Sensei',
  'Master Mixer', 'Fryer Phenom', 'Donut Demigod', 'Master of Donuts',
];
const SCORE_TARGETS = [
  500, 1500, 2600, 3700, 4800, 7000, 9200, 11400,
  13700, 16000, 19400, 22800, 26200, 29600, 33000, 38300,
];
const FALLBACK_SCORE_GAP = 3200;
const FIRST_SHUFFLED_LEVEL = 2;
const STARTING_CAPACITY = 5;
const STARTING_COLOR_COUNT = 3;
const PRESSURE_SEARCH_LIMIT = 512;
const SETUP_HINT_SEARCH_LIMIT = 512;
// Height, stack and color, in the same order as the full-shuffle experiment.
const UPGRADE_ORDERS = ['HSC', 'HCS', 'SHC', 'SCH', 'CHS', 'CSH'] as const;
const paletteKey = Symbol('palette');
const upgradePlanKey = Symbol('upgradePlan');
const jokerRefillsKey = Symbol('jokerRefills');
type RunState = GameState & {
  [paletteKey]?: string[];
  [upgradePlanKey]?: readonly (typeof UPGRADE_ORDERS)[number][];
  [jokerRefillsKey]?: number;
};

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

function rollPressureInterval(rng: () => number): number {
  return 6 + Math.floor(rng() * 3);
}

function topPair(stack: readonly string[] | string): string | undefined {
  return stack.at(-1) === stack.at(-2) ? stack.at(-1) : undefined;
}

export function resolveMatch(destinationBefore: readonly string[] | string, incoming: string, joker = JOKER) {
  let color = incoming === joker ? undefined : incoming;
  let jokerDepth = incoming === joker ? destinationBefore.length : undefined;
  let depth = destinationBefore.length - 1;
  for (; depth >= 0; depth--) {
    const piece = destinationBefore[depth];
    if (piece === joker) {
      if (jokerDepth !== undefined) break;
      jokerDepth = depth;
    } else {
      if (color !== undefined && piece !== color) break;
      color = piece;
    }
  }
  const runLength = destinationBefore.length - depth;
  if (color === undefined || runLength < 3) return null;
  const jokerIndex = jokerDepth === undefined ? undefined : jokerDepth - depth - 1;
  return { color, runLength, jokerIndex };
}

export function matchedRunLength(destinationBefore: readonly string[], incoming: string): number {
  return resolveMatch(destinationBefore, incoming)?.runLength ?? 0;
}

function totalSpace(stacks: string[][], capacity: number): number {
  return stacks.reduce((free, stack) => free + capacity - stack.length, 0);
}

function shortestStacks(stacks: string[][], capacity: number): string[][] {
  return stacks.filter((stack) => stack.length < capacity).sort((a, b) => a.length - b.length);
}

function pressureRefillCount(level: number): number {
  return Math.floor(level / 5) + 1;
}

function canScoreWithOneVacancy(
  stacks: readonly (readonly string[] | string)[], capacity: number, movesLeft: number, joker = JOKER,
): boolean {
  const movableTops = new Set(stacks.filter((stack) => stack.length === capacity).map((stack) => stack[capacity - 1]));
  // Until the first score, transfers can only move the vacancy and the donuts
  // above each stack's fixed prefix. Opening another prefix costs one miss.
  return stacks.some((stack) => {
    if (movesLeft === 1 && stack.length === capacity) return false;
    const prefixTop = stack.slice(capacity - 3, capacity - 1);
    for (const incoming of movableTops) {
      if (resolveMatch(prefixTop, incoming, joker) !== null) return true;
    }
    return false;
  });
}

function insertDough(state: GameState, inserts: DoughInsert[], stack: string[], depth: number, color: string): void {
  stack.splice(depth, 0, color);
  inserts.push({ stack: state.stacks.indexOf(stack), depth, color });
}

function refill(state: RunState, inserts: DoughInsert[], colors: string[], rng: () => number,
  match?: string, allowJoker = false): void {
  const { stacks, capacity } = state;

  if (match !== undefined) {
    // Moving opens a slot in the source, and clearing opens slots in the target.
    const targets = shortestStacks(stacks, capacity).slice(0, 2);
    const otherColors = colors.filter((color) => color !== match);
    for (const stack of targets) {
      // Legacy protects the top pair even though refill enters at the bottom.
      insertDough(state, inserts, stack, 0, topPair(stack) === match ? randomColor(otherColors, rng) : match);
    }
    if (totalSpace(stacks, capacity) <= 2) return;
  }

  const count = match === undefined ? Math.min(pressureRefillCount(state.level), totalSpace(stacks, capacity)) : 1;
  for (let i = 0; i < count; i++) {
    const [stack] = shortestStacks(stacks, capacity);
    const pair = topPair(stack);
    const choices = colors.filter((color) => color !== match && color !== pair);
    let color = randomColor(choices, rng);
    if (allowJoker && state.level >= FIRST_JOKER_LEVEL && !stacks.some(stack => stack.includes(JOKER))) {
      const eligible = (state[jokerRefillsKey] ?? 0) + 1;
      state[jokerRefillsKey] = eligible % JOKER_REFILL_INTERVAL;
      if (eligible === JOKER_REFILL_INTERVAL) color = JOKER;
    }
    insertDough(state, inserts, stack, 0, color);
    // Keep the historical early stop only if the last slot is structurally dead.
    if (i + 1 < count && totalSpace(stacks, capacity) === 1 && !canScoreWithOneVacancy(stacks, capacity, 2)) break;
  }
}

function hasScoringMove(stacks: readonly (readonly string[] | string)[], capacity: number, joker = JOKER): boolean {
  return stacks.some((target, to) => {
    if (target.length < 2 || target.length >= capacity) return false;
    return stacks.some((source, from) => {
      const incoming = source.at(-1);
      return from !== to && incoming !== undefined && resolveMatch(target, incoming, joker) !== null;
    });
  });
}

export function canRequestSetupHint(state: GameState): boolean {
  if (state.gameOver || state.movesLeft < 2) return false;
  const space = totalSpace(state.stacks, state.capacity);
  return space >= 1 && space <= 3 && !hasScoringMove(state.stacks, state.capacity);
}

export function findSetupHint(state: GameState): { from: number; to: number } | null {
  if (!canRequestSetupHint(state)) return null;

  const { capacity, movesLeft } = state;
  const colors = [...new Set(state.stacks.flat())];
  const tokens = new Map(colors.map((color, i) => [color, String.fromCharCode(i + 1)]));
  const initial = state.stacks.map((stack) => stack.map((color) => tokens.get(color)).join(''));
  const joker = tokens.get(JOKER);
  const queue: { stacks: string[]; misses: number; first: { from: number; to: number } | null }[] = [
    { stacks: initial, misses: 0, first: null },
  ];
  // Without pressure, stack labels do not affect whether a position can score.
  const key = (stacks: string[]) => stacks.slice().sort().join('\0');
  const seen = new Set([key(initial)]);

  for (let i = 0; i < queue.length; i++) {
    const { stacks, misses, first } = queue[i];
    if (first && hasScoringMove(stacks, capacity, joker)) return first;
    if (misses + 1 >= movesLeft) continue;

    // Breadth first, then source/destination index order. A final scoring move
    // does not spend pressure, so at most movesLeft - 1 setup misses can precede it.
    for (let from = 0; from < stacks.length && queue.length < SETUP_HINT_SEARCH_LIMIT; from++) {
      for (let to = 0; to < stacks.length && queue.length < SETUP_HINT_SEARCH_LIMIT; to++) {
        if (!canTransfer(stacks, capacity, from, to)) continue;
        const after = stacks.slice();
        after[to] += stacks[from].at(-1);
        after[from] = stacks[from].slice(0, -1);
        const position = key(after);
        if (seen.has(position)) continue;
        seen.add(position);
        queue.push({ stacks: after, misses: misses + 1, first: first ?? { from, to } });
      }
    }
  }
  return null;
}

function canScoreAfterPressure(
  board: string[], capacity: number, count: number, colors: string[], joker: string | undefined,
  claimNode: () => boolean,
): boolean {
  const filled = board.slice();
  function insert(remaining: number): boolean {
    // Any roll of 6–8 permits the single setup miss a one-vacancy board may need.
    if (remaining === 0) return canScoreWithOneVacancy(filled, capacity, 2, joker);

    let shortest = 0;
    for (let i = 1; i < filled.length; i++) {
      if (filled[i].length < filled[shortest].length) shortest = i;
    }
    const stack = filled[shortest];
    // With fewer than three donuts, a bottom insert can affect a fixed pair or
    // a movable top. Deeper inserts only change the height used by refill selection.
    const visible = stack.length < 3;
    const choices = visible ? colors : ['\uffff'];
    const pair = topPair(stack);
    for (const color of choices) {
      if (color === pair) continue;
      if (visible && !claimNode()) return true;
      filled[shortest] = color + stack;
      const canScore = insert(remaining - 1);
      filled[shortest] = stack;
      if (canScore) return true;
    }
    return false;
  }
  return insert(count);
}

function canEscapePressure(state: RunState, space: number, refillCount: number): boolean {
  // With one vacancy only the cap-height donuts can move. To score, either
  // use the existing opening or move it once to a stack whose fixed top pair can score.
  if (space === 1) return canScoreWithOneVacancy(state.stacks, state.capacity, state.movesLeft);

  const { stacks, capacity, movesLeft } = state;
  const leavesVacancy = space === refillCount + 1;
  if (hasScoringMove(stacks, capacity)) return true;
  if (movesLeft <= 1 && !leavesVacancy) return false;

  const inventory = new Map<string, { code: string; count: number }>();
  function colorEntry(color: string): { code: string; count: number } {
    let entry = inventory.get(color);
    if (!entry) {
      entry = { code: String.fromCharCode(inventory.size + 1), count: 0 };
      inventory.set(color, entry);
    }
    return entry;
  }
  const board = stacks.map((stack) => stack.map((color) => {
    const entry = colorEntry(color);
    entry.count++;
    return entry.code;
  }).join(''));
  const joker = inventory.get(JOKER)?.code;
  if (!leavesVacancy && ![...inventory].some(([color, { count }]) =>
    color !== JOKER && count + Number(joker !== undefined) >= 3)) return false;

  let refillColors: string[] = [];
  if (leavesVacancy) {
    // A real run's palette is fixed. Plain snapshots can rebuild it from the
    // board before the pressure move, so include every possible normal color.
    const palette = state[paletteKey]?.slice(0, activeColorCount(state)) ?? [...new Set([...inventory.keys(), ...COLORS])];
    refillColors = palette.filter((color) => color !== JOKER).map((color) => colorEntry(color).code);
  }

  const visited = new Map<string, number>();
  let nodes = 0;
  function claimNode(): boolean {
    if (nodes === PRESSURE_SEARCH_LIMIT) return false;
    nodes++;
    return true;
  }
  function visit(remaining: number): boolean {
    // Refill ties depend on stack order and the batch fires at exactly zero.
    const key = leavesVacancy ? `${remaining}\0${board.join('\0')}` : board.slice().sort().join('\0');
    if ((visited.get(key) ?? -1) >= remaining) return false;
    if (!claimNode()) return true; // Inconclusive is still playable.
    visited.set(key, remaining);
    if (remaining === 0) return canScoreAfterPressure(board, capacity, refillCount, refillColors, joker, claimNode);
    if (hasScoringMove(board, capacity, joker)) return true;
    if (remaining === 1 && !leavesVacancy) return false;

    // No transfer here can score, so each legal transfer uses one setup miss.
    for (let from = 0; from < board.length; from++) {
      const source = board[from];
      if (!source) continue;
      for (let to = 0; to < board.length; to++) {
        const target = board[to];
        if (from === to || target.length >= capacity) continue;
        board[from] = source.slice(0, -1);
        board[to] = target + source.at(-1);
        const playable = visit(remaining - 1);
        board[from] = source;
        board[to] = target;
        if (playable) return true;
      }
    }
    return false;
  }
  return visit(movesLeft);
}

function isGameOver(state: RunState): boolean {
  const space = totalSpace(state.stacks, state.capacity);
  if (space === 0) return true;
  const count = pressureRefillCount(state.level);
  return space <= count + 1 && !canEscapePressure(state, space, count);
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

function refillWithContinuation(
  state: RunState, inserts: DoughInsert[], colors: string[], rng: () => number, match: string,
  from: number, to: number, runLength: number,
): void {
  const jokerTriple = runLength === 3;
  const cleared = state.stacks;
  const trial: RunState = { ...state, stacks: cleared.map((stack) => stack.slice()) };
  const trialInserts: DoughInsert[] = [];
  refill(trial, trialInserts, colors, rng, match, jokerTriple);
  if (hasQuickScore(trial)) {
    state.stacks = trial.stacks;
    if (trial[jokerRefillsKey] !== undefined) state[jokerRefillsKey] = trial[jokerRefillsKey];
    inserts.push(...trialInserts);
    return;
  }

  if (jokerTriple) {
    const source = cleared[from];
    const target = cleared[to];
    const needsDonor = trialInserts.length === 3;
    // With only two inserts, the cleared target has three vacancies and the
    // source has the only other vacancy, so its exposed donut can be the donor.
    const donor = source.at(-1);
    const color = needsDonor || donor === JOKER ? match : donor!;
    insertDough(state, inserts, target, target.length, color);
    insertDough(state, inserts, target, target.length, color);
    if (needsDonor) insertDough(state, inserts, source, source.length, color);
    return;
  }

  const empty = cleared.find((stack) => stack.length === 0);
  const donor = cleared.find((stack) => stack.length > 0);
  if (empty && donor) {
    const top = donor.at(-1)!;
    const color = top === JOKER ? match : top;
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

function advanceLevel(state: RunState, colors: string[], rng: () => number): void {
  state.level++;
  const { level } = state;
  state.rank = RANKS[Math.min(level, RANKS.length) - 1];
  state.nextLevelScore = SCORE_TARGETS[level - 1] ?? state.nextLevelScore + FALLBACK_SCORE_GAP;

  if (level > RANKS.length) return;
  const offset = level - FIRST_SHUFFLED_LEVEL;
  const block = Math.floor(offset / 3);
  const step = offset % 3;
  const plan = state[upgradePlanKey];
  if (plan && offset >= 0 && step === 0) {
    // Draw the block's order after the threshold move's refill has resolved.
    const nextPlan = plan.slice();
    nextPlan[block] = UPGRADE_ORDERS[Math.floor(rng() * UPGRADE_ORDERS.length)];
    state[upgradePlanKey] = nextPlan;
  }
  const order = state[upgradePlanKey]?.[block];
  const upgrade = order?.[step] ?? 'CHS'[(level - 1) % 3];
  if (upgrade === 'H') {
    state.capacity++;
  } else if (upgrade === 'S') {
    // Use the block's final capacity so stack-first orders add the same number of donuts.
    const finalCapacity = STARTING_CAPACITY + 1 + block;
    const count = Math.floor((order ? finalCapacity : state.capacity) / 2);
    const stack: string[] = [];
    for (let i = 0; i < count; i++) {
      const excluded = i === count - 1 ? stack.at(-1) : topPair(stack);
      stack.push(randomColor(colors.filter((color) => color !== excluded), rng));
    }
    state.stacks.push(stack);
  }
}

function activeColorCount(state: RunState): number {
  const offset = state.level - FIRST_SHUFFLED_LEVEL;
  const block = Math.floor(offset / 3);
  const order = state[upgradePlanKey]?.[block];
  if (!order) return Math.min(COLORS.length, STARTING_COLOR_COUNT + Math.floor((state.level - 1) / 3));
  return STARTING_COLOR_COUNT + block + Number(order.indexOf('C') <= offset % 3);
}

export function createGame(rng: () => number = Math.random): GameState {
  const palette = shuffled(COLORS, rng);
  const startingColors = palette.slice(0, STARTING_COLOR_COUNT);
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
    combo: 0,
    level: 1,
    rank: RANKS[0],
    capacity: STARTING_CAPACITY,
    nextLevelScore: SCORE_TARGETS[0],
    movesLeft: rollPressureInterval(rng),
    gameOver: false,
    [paletteKey]: palette,
    [upgradePlanKey]: [],
  };
  return state;
}

function canTransfer(stacks: readonly (readonly string[] | string)[], capacity: number, from: number, to: number): boolean {
  const source = stacks[from];
  const target = stacks[to];
  return from !== to && source !== undefined && target !== undefined && source.length > 0 && target.length < capacity;
}

export function canMove(state: GameState, from: number, to: number): boolean {
  return !state.gameOver && Number.isInteger(from) && Number.isInteger(to) && canTransfer(state.stacks, state.capacity, from, to);
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
  const matched = resolveMatch(target, color);
  target.push(color);
  if (!matched) {
    next.combo = 0;
    next.movesLeft--;
    if (next.movesLeft > 0) {
      next.gameOver = isGameOver(next);
      return next;
    }
  }

  // Keep the original shuffle so future colors unlock in the same run order,
  // including colors that have unlocked but have yet to enter a stack.
  const palette = next[paletteKey] ?? [...new Set([...state.stacks.flat(), ...COLORS])].filter(color => color !== JOKER);
  const colors = palette.slice(0, activeColorCount(state));
  const inserts: DoughInsert[] = [];
  if (matched) {
    const { runLength, color: match } = matched;
    target.splice(-runLength);
    const priorCombo = state.combo ?? 0;
    const baseAward = 100 + (runLength - 3) * 50;
    const adjustedAward = baseAward * (10 + state.level - 1) / 10;
    next.combo = priorCombo + 1;
    next.score += adjustedAward + Math.floor(adjustedAward * Math.min(priorCombo, 5) / 10);
    if (runLength === 3 && matched.jokerIndex === undefined) refill(next, inserts, colors, rng, match, true);
    else refillWithContinuation(next, inserts, colors, rng, match, from, to, runLength);
    if (next.score >= next.nextLevelScore) advanceLevel(next, colors, rng);
  } else {
    refill(next, inserts, colors, rng);
    next.movesLeft = rollPressureInterval(rng);
  }
  next.gameOver = isGameOver(next);
  onDough?.(inserts);
  return next;
}
