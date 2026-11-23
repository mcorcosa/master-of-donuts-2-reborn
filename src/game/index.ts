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
const SCORING_SEARCH_LIMIT = 1024;
const MIN_PRESSURE_INTERVAL = 6;
const UNKNOWN_DOUGH = '\uffff';
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
  return MIN_PRESSURE_INTERVAL + Math.floor(rng() * 3);
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
  const proof = proveBoardScore(state);
  return proof.kind === 'verified-route' ? proof.first : null;
}

type SetupTransfer = { from: number; to: number };
type ScoreProof = { kind: 'verified-route'; first: SetupTransfer } | { kind: 'proven-dead' } | { kind: 'inconclusive' };
type ProofPosition = { stacks: string[]; beforePressure: number; guaranteedMoves: number; first?: SetupTransfer };

function couldScoreWithUnknown(triple: string, joker: string): boolean {
  const known = [...triple].filter(piece => piece !== UNKNOWN_DOUGH);
  const natural = known.filter(piece => piece !== joker);
  return known.length - natural.length <= 1 && natural.every(piece => piece === natural[0]);
}

function proveBoardScore(state: GameState, space = totalSpace(state.stacks, state.capacity)): ScoreProof {
  const { capacity, movesLeft, level } = state;
  const refillCount = pressureRefillCount(level);
  if (space === 0) return { kind: 'proven-dead' };
  // Restrict the dense proof to at most two vacancies after the first refill.
  if (space > refillCount + 2) return { kind: 'inconclusive' };

  const colors = [...new Set(state.stacks.flat())];
  const tokens = new Map(colors.map((color, i) => [color, String.fromCharCode(i + 1)]));
  const initial = state.stacks.map(stack => stack.map(color => tokens.get(color)).join(''));
  const joker = tokens.get(JOKER) ?? JOKER;
  const queue: ProofPosition[] = [];
  const seen = new Set<string>();
  let capped = false;
  let inconclusive = false;

  function enqueue(position: ProofPosition): void {
    const { stacks, beforePressure, guaranteedMoves } = position;
    // A surviving refill depends on index order and the exact countdown. After
    // it, later inserts can be omitted for loss proofs: they take space and
    // can be skipped as move sources, but cannot supply a scoring ingredient.
    const key = beforePressure > 0 && refillCount < space ? `${beforePressure}:${stacks.join('\0')}` :
      `${guaranteedMoves > 0 ? 'safe' : 'open'}:${stacks.slice().sort().join('\0')}`;
    if (seen.has(key)) return;
    if (queue.length === SCORING_SEARCH_LIMIT) { capped = true; return; }
    seen.add(key);
    queue.push(position);
  }
  enqueue({ stacks: initial, beforePressure: movesLeft, guaranteedMoves: movesLeft });

  for (let i = 0; i < queue.length; i++) {
    const { stacks, beforePressure, guaranteedMoves, first } = queue[i];
    if (guaranteedMoves === 0 && (inconclusive || capped)) continue;
    const open = stacks.flatMap((stack, index) => stack.length < capacity ? [index] : []);
    for (let from = 0; from < stacks.length; from++) {
      const incoming = stacks[from].at(-1);
      if (incoming === undefined) continue;
      for (const to of open) {
        if (from === to) continue;
        const triple = stacks[to].slice(-2) + incoming;
        const candidate = first ?? { from, to };
        const hasUnknown = triple.includes(UNKNOWN_DOUGH);
        if (!hasUnknown && resolveMatch(stacks[to], incoming, joker)) {
          if (guaranteedMoves > 0) return { kind: 'verified-route', first: candidate };
          inconclusive = true;
          continue;
        }
        // A batch that fills the board can only stop early on a dead one-slot board.
        if (capped || (beforePressure === 1 && refillCount >= space)) continue;

        const after = stacks.slice();
        after[to] += incoming;
        after[from] = stacks[from].slice(0, -1);
        let witness = Math.max(0, guaranteedMoves - 1);
        if (beforePressure === 1) {
          for (let insert = 0; insert < refillCount; insert++) {
            let shortest = 0;
            for (let stack = 1; stack < after.length; stack++) {
              if (after[stack].length < after[shortest].length) shortest = stack;
            }
            after[shortest] = UNKNOWN_DOUGH + after[shortest];
          }
          // A witness must score no later than the earliest possible next refill.
          witness = MIN_PRESSURE_INTERVAL;
        } else if (witness > 0 && hasUnknown && triple.length === 3 && couldScoreWithUnknown(triple, joker)) {
          // A real roll could score instead of making this setup transfer.
          witness = 0;
        }
        enqueue({ stacks: after, beforePressure: Math.max(0, beforePressure - 1), guaranteedMoves: witness, first: candidate });
      }
    }
  }
  return { kind: inconclusive || capped ? 'inconclusive' : 'proven-dead' };
}

function isGameOver(state: GameState): boolean {
  const space = totalSpace(state.stacks, state.capacity);
  return space <= pressureRefillCount(state.level) + 2 && !hasScoringMove(state.stacks, state.capacity) &&
    proveBoardScore(state, space).kind === 'proven-dead';
}

function hasQuickScore<T>(stacks: T[][], capacity: number, movesLeft: number, canScore: () => boolean): boolean {
  if (canScore()) return true;
  if (movesLeft <= 1) return false;

  // Check one setup move while it is still safe to miss without a pressure refill.
  for (const source of stacks) {
    const incoming = source.at(-1);
    if (incoming === undefined) continue;
    for (const target of stacks) {
      if (source === target || target.length >= capacity) continue;
      source.pop();
      target.push(incoming);
      const scoring = canScore();
      target.pop();
      source.push(incoming);
      if (scoring) return true;
    }
  }
  return false;
}

type FreshDough = { color: string; matchColor?: string };
type RefillPiece = string | FreshDough;

function completesScoringMove(stacks: RefillPiece[][], capacity: number, colors: string[], match: string): boolean {
  for (const target of stacks) {
    if (target.length < 2 || target.length >= capacity) continue;
    const lower = target[target.length - 2];
    const upper = target[target.length - 1];
    const lowerColor = typeof lower === 'string' && lower !== JOKER ? lower : undefined;
    const upperColor = typeof upper === 'string' && upper !== JOKER ? upper : undefined;
    if (lowerColor !== undefined && upperColor !== undefined && lowerColor !== upperColor) continue;
    for (const source of stacks) {
      const incoming = source.at(-1);
      if (source === target || incoming === undefined) continue;
      const donorColor = typeof incoming === 'string' && incoming !== JOKER ? incoming : undefined;
      const color = lowerColor ?? upperColor ?? donorColor ?? match;
      if (donorColor !== undefined && donorColor !== color) continue;
      const fresh = [lower, upper, incoming].filter(piece => typeof piece !== 'string');
      if (fresh.length && !colors.includes(color)) continue;
      const pair = [typeof lower === 'string' ? lower : color, typeof upper === 'string' ? upper : color];
      if (resolveMatch(pair, typeof incoming === 'string' ? incoming : color) === null) continue;
      for (const piece of fresh) piece.matchColor = color;
      return true;
    }
  }
  return false;
}

function findBottomRefill(state: GameState, trial: DoughInsert[], colors: string[], match: string): DoughInsert[] | null {
  const { capacity, movesLeft } = state;
  const stacks: RefillPiece[][] = state.stacks.map(stack => stack.slice());
  const dough: FreshDough[] = trial.map(({ color }) => ({ color: color === JOKER ? match : color }));
  const placements = trial.map(({ stack }) => stack);

  // Each layout needs a single color decision for the fresh pieces in the scoring triple.
  // Search stack placements independently of the palette, then color only the pieces the route needs.
  const canScore = () => completesScoringMove(stacks, capacity, colors, match);
  for (const [index, stack] of placements.entries()) stacks[stack].unshift(dough[index]);
  const samePlacement = canScore();
  for (const stack of placements) stacks[stack].shift();

  const search = (depth: number, firstStack: number, budget: number): boolean => {
    if (depth === dough.length) return hasQuickScore(stacks, capacity, budget, canScore);
    for (let index = firstStack; index < stacks.length; index++) {
      const stack = stacks[index];
      if (stack.length === capacity) continue;
      placements[depth] = index;
      stack.unshift(dough[depth]);
      const found = search(depth + 1, index, budget);
      stack.shift();
      if (found) return true;
    }
    return false;
  };

  if (!samePlacement && !search(0, 0, 1) && (movesLeft <= 1 || !search(0, 0, movesLeft))) return null;
  for (const [index, stack] of placements.entries()) stacks[stack].unshift(dough[index]);
  // Vary any spare dough that would complete a resting triple in a rebuilt stack.
  for (const stack of stacks) {
    const top = stack.slice(-3);
    const spare = top.find(piece => typeof piece !== 'string' && piece.matchColor === undefined);
    if (!spare || typeof spare === 'string' || top.length < 3) continue;
    const [lower, upper, incoming] = top.map(piece => typeof piece === 'string' ? piece : piece.matchColor ?? piece.color);
    const match = resolveMatch([lower, upper], incoming);
    if (match) spare.color = colors.find(color => color !== match.color) ?? spare.color;
  }
  return dough.map(({ color, matchColor }, index) => ({ stack: placements[index], depth: 0, color: matchColor ?? color }));
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
  if (hasQuickScore(trial.stacks, trial.capacity, trial.movesLeft, () => hasScoringMove(trial.stacks, trial.capacity))) {
    state.stacks = trial.stacks;
    if (trial[jokerRefillsKey] !== undefined) state[jokerRefillsKey] = trial[jokerRefillsKey];
    inserts.push(...trialInserts);
    return;
  }

  const empty = cleared.find((stack) => stack.length === 0);
  const donor = cleared.find((stack) => stack.length > 0);
  if (!jokerTriple && empty) {
    if (donor) {
      const top = donor.at(-1)!;
      const color = top === JOKER ? match : top;
      insertDough(state, inserts, empty, 0, color);
      insertDough(state, inserts, empty, 0, color);
      insertDough(state, inserts, empty, 0, colors.find((other) => other !== color)!);
    } else {
      insertDough(state, inserts, cleared[to], 0, match);
      insertDough(state, inserts, cleared[to], 0, match);
      insertDough(state, inserts, cleared[from], 0, match);
    }
    return;
  }

  const bottom = findBottomRefill(state, trialInserts, colors, match);
  if (bottom) {
    for (const { stack, depth, color } of bottom) insertDough(state, inserts, cleared[stack], depth, color);
    return;
  }

  // Keep the emergency scoring move when bottom placement cannot provide a quick continuation.
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

  // Clearing four or more leaves at least four slots in the destination and
  // moving leaves at least one in the source. The pair and donor give a scoring
  // move even when the very next miss would trigger a fatal pressure refill.
  const retainedTop = cleared[to].at(-1);
  const rescueColor = colors.find((color) => color !== match && color !== retainedTop)!;
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

export function canUseJokerBooster(state: GameState): boolean {
  return !state.gameOver && state.stacks.some(stack => stack.length > 0)
    && !state.stacks.some(stack => stack.includes(JOKER));
}

export function useJokerBooster(state: GameState, stack: number): GameState {
  if (!Number.isInteger(stack) || !state.stacks[stack]?.length || !canUseJokerBooster(state)) return state;
  const next = { ...state, stacks: state.stacks.map(pile => pile.slice()) };
  const selected = next.stacks[stack];
  selected[selected.length - 1] = JOKER;
  return next;
}

export function previewStackSweep(state: GameState): GameState | null {
  if (state.gameOver) return null;
  const next = { ...state, stacks: state.stacks.map(stack => stack.slice(0, -1)) };
  const hasTransfer = next.stacks.some((_, from) => next.stacks.some((_, to) => canMove(next, from, to)));
  return hasTransfer && !isGameOver(next) ? next : null;
}

export function useStackSweep(state: GameState): GameState {
  return previewStackSweep(state) ?? state;
}

export function previewExtraChance(state: GameState): GameState | null {
  if (!state.gameOver) return null;
  const { stacks, capacity, movesLeft } = state;
  const test = (candidate: string[][]): GameState | null => {
    const next = { ...state, stacks: candidate, gameOver: false };
    return hasQuickScore(candidate, capacity, movesLeft, () => hasScoringMove(candidate, capacity)) &&
      !isGameOver(next) ? next : null;
  };

  // Try opening a single stack first. A broader rescue removes at most two
  // exposed layers and leaves any active Joker intact. Preflight spends no RNG.
  const peel = (stack: string[]): string[] => stack.at(-1) === JOKER ? stack.slice() : stack.slice(0, -1);
  const once = stacks.map(peel);
  const twice = once.map(peel);
  for (const [before, after] of [[stacks, once], [once, twice]]) {
    for (const [index, exposed] of after.entries()) {
      if (exposed.length === before[index].length) continue;
      const next = test(stacks.map((pile, i) => (i === index ? exposed : pile).slice()));
      if (next) return next;
    }
  }
  return test(once) ?? test(twice);
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
