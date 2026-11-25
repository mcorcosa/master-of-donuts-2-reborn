export interface GameState {
  stacks: string[][];
  score: number;
  combo?: number;
  level: number;
  rank: string;
  capacity: number;
  nextLevelScore: number;
  movesLeft: number;
  doughMeter?: number;
  gameOver: boolean;
  endReason?: 'dough-meter';
}

export interface DoughInsert {
  stack: number;
  /** Bottom-first index just before this donut is inserted. */
  depth: number;
  color: string;
}

type DoughSlot = { stack: number; depth: number };
/** Two unchanged donuts exchange their bottom-first seats on the resolved board. */
export type DoughSwap = readonly [DoughSlot, DoughSlot];

const COLORS = ['gold', 'red', 'yellow', 'choco', 'gray', 'purple', 'blue', 'green'];
export const JOKER = 'joker';
export const DOUGH_METER_LIMIT = 28;
export const LEVEL_DOUGH_RELIEF = 7;
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

function pressureRefillCount(level: number, space: number): number {
  // Preserve one destination for ordinary play, even when the full batch is due.
  return Math.min(Math.floor(level / 5) + 1, Math.max(0, space - 1));
}

function canScoreWithOneVacancy(stacks: readonly string[], capacity: number, joker: string): boolean {
  const movableTops = new Set(stacks.filter((stack) => stack.length === capacity).map((stack) => stack[capacity - 1]));
  // Until the first score, transfers can only move the vacancy and the donuts
  // above each stack's fixed prefix.
  return stacks.some((stack) => {
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

  const count = match === undefined ? pressureRefillCount(state.level, totalSpace(stacks, capacity)) : 1;
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

function scoringBudget(state: GameState): number {
  return DOUGH_METER_LIMIT - (state.doughMeter ?? 0);
}

export function canRequestSetupHint(state: GameState): boolean {
  if (state.gameOver || state.movesLeft < 2 || scoringBudget(state) < 2) return false;
  const space = totalSpace(state.stacks, state.capacity);
  return space >= 1 && space <= 3 && !hasScoringMove(state.stacks, state.capacity);
}

export function findSetupHint(state: GameState): SetupTransfer | null {
  return canRequestSetupHint(state) ? findScoringRoute(state, scoringBudget(state)) : null;
}

type SetupTransfer = { from: number; to: number };
type RoutePosition = { stacks: string[]; untilRefill: number; afterRefill: boolean; remaining: number; first?: SetupTransfer };

function findScoringRoute(state: GameState, remaining = Infinity): SetupTransfer | null {
  const { capacity, movesLeft, level } = state;
  const space = totalSpace(state.stacks, capacity);
  if (space === 0 || remaining <= 0) return null;

  const colors = [...new Set(state.stacks.flat())];
  const tokens = new Map(colors.map((color, i) => [color, String.fromCharCode(i + 1)]));
  const initial = state.stacks.map(stack => stack.map(color => tokens.get(color)).join(''));
  const joker = tokens.get(JOKER) ?? JOKER;
  if (space === 1 && !canScoreWithOneVacancy(initial, capacity, joker)) return null;
  const refillCount = pressureRefillCount(level, space);
  const queue: RoutePosition[] = [];
  const seen = new Set<string>();

  function enqueue(position: RoutePosition): void {
    if (queue.length >= SCORING_SEARCH_LIMIT) return;
    const { stacks, untilRefill, afterRefill, remaining } = position;
    // Preserve stack indices while pressure can still choose a target. Otherwise
    // equivalent arrangements have the same future, regardless of stack order.
    const timed = !afterRefill && untilRefill < remaining;
    const key = timed ? untilRefill + ':' + stacks.join('\0') :
      Number(afterRefill) + ':' + stacks.slice().sort().join('\0');
    if (seen.has(key)) return;
    seen.add(key);
    queue.push(position);
  }
  enqueue({ stacks: initial, untilRefill: refillCount ? movesLeft : Infinity, afterRefill: false, remaining });

  for (const { stacks, untilRefill, afterRefill, remaining, first } of queue) {
    const open = stacks.flatMap((stack, index) => stack.length < capacity ? [index] : []);
    for (let from = 0; from < stacks.length; from++) {
      const incoming = stacks[from].at(-1);
      if (incoming === undefined) continue;
      for (const to of open) {
        if (from === to) continue;
        const target = stacks[to];
        const triple = target.slice(-2) + incoming;
        const candidate = first ?? { from, to };
        // If a setup transfer scores early with fresh dough, it already meets
        // the goal. The final scoring triple itself must use known donuts.
        if (triple.length === 3 && !triple.includes(UNKNOWN_DOUGH) && resolveMatch(target, incoming, joker)) {
          return candidate;
        }
        if (remaining <= 1 || queue.length >= SCORING_SEARCH_LIMIT) continue;

        const after = stacks.slice();
        after[to] += incoming;
        after[from] = stacks[from].slice(0, -1);
        if (untilRefill === 1) {
          for (let insert = 0; insert < refillCount; insert++) {
            let shortest = 0;
            for (let stack = 1; stack < after.length; stack++) {
              if (after[stack].length < after[shortest].length) shortest = stack;
            }
            after[shortest] = UNKNOWN_DOUGH + after[shortest];
          }
          // The upcoming roll can be as short as six misses. A route may cross
          // this refill, then must score before another one could trigger.
          const nextBudget = space - refillCount === 1 ? remaining - 1 : Math.min(remaining - 1, MIN_PRESSURE_INTERVAL);
          enqueue({ stacks: after, untilRefill: Infinity, afterRefill: true, remaining: nextBudget, first: candidate });
        } else {
          enqueue({ stacks: after, untilRefill: untilRefill - 1, afterRefill, remaining: remaining - 1, first: candidate });
        }
      }
    }
  }
  return null;
}
interface BoardRepair {
  swaps: readonly DoughSwap[];
  inserts: readonly DoughInsert[];
}

// Presentation reads the repair from the exact board that committed it.
const boardRepairs = new WeakMap<GameState, BoardRepair>();

export function getBoardRepair(state: GameState): BoardRepair | undefined {
  return boardRepairs.get(state);
}

function ensureScoringRoute(state: GameState, refills?: DoughInsert[], landingStack?: number,
  settledStackCount = state.stacks.length): boolean {
  const { stacks, capacity } = state;
  if (hasScoringMove(stacks, capacity) || findScoringRoute(state)) return true;

  const inserts = refills ?? [];
  function findInsert(stack: number, depth: number): DoughInsert | undefined {
    for (let index = inserts.length - 1; index >= 0; index--) {
      const insert = inserts[index];
      if (insert.stack !== stack) continue;
      if (insert.depth === depth) return insert;
      if (insert.depth < depth) depth--;
    }
  }

  const colorAt = ({ stack, depth }: DoughSlot): string | undefined => stacks[stack][depth];
  const isLanding = ({ stack, depth }: DoughSlot) => stack === landingStack && depth === stacks[stack].length - 1;
  const fresh = stacks.map((pile, stack) => pile.map((_, depth) => findInsert(stack, depth)));
  const donors = new Map<string, DoughSlot[]>();
  for (const [stack, pile] of stacks.entries()) {
    for (let depth = pile.length - 1; depth >= 0; depth--) {
      const seat = { stack, depth };
      const color = pile[depth];
      if (color === JOKER || stack >= settledStackCount || fresh[stack][depth] || isLanding(seat)) continue;
      const available = donors.get(color) ?? [];
      available.push(seat);
      donors.set(color, available);
    }
  }
  for (const available of donors.values()) {
    available.sort((a, b) => (stacks[a.stack].length - a.depth) - (stacks[b.stack].length - b.depth));
  }

  let best: { swaps: DoughSwap[]; freshColors: DoughSlot[]; additions: DoughSlot[]; color: string; cost: number } | undefined;
  for (const [to, target] of stacks.entries()) {
    for (let pairAdd = Math.max(0, 2 - target.length); pairAdd <= 2 && target.length + pairAdd < capacity; pairAdd++) {
      // If this stack received the player's transfer, keep that donut on top
      // through its landing animation. Any missing ingredient goes below it.
      if (to === landingStack && target.length >= 2 && pairAdd) break;
      const top = target.length - 1 + (to === landingStack ? 0 : pairAdd);
      const pair = [{ stack: to, depth: top - 1 }, { stack: to, depth: top }];
      for (const [from, source] of stacks.entries()) {
        if (from === to) continue;
        for (let donorAdd = Number(source.length === 0); donorAdd <= 1 && source.length + donorAdd <= capacity; donorAdd++) {
          if (from === landingStack && donorAdd) break;
          const additions = [
            ...Array.from({ length: pairAdd }, (_, i) => ({ stack: to, depth: to === landingStack ? 0 : target.length + i })),
            ...Array.from({ length: donorAdd }, () => ({ stack: from, depth: source.length })),
          ];
          const slots = [...pair, { stack: from, depth: source.length + donorAdd - 1 }];
          const contents = slots.map(colorAt);
          if (contents.filter(color => color === JOKER).length > 1) continue;
          const colors = new Set([...contents, ...donors.keys()].filter(color => color && color !== JOKER));
          if (colors.size === 0) colors.add(COLORS[0]);
          for (const color of colors) {
            if (!color) continue;
            let cost = additions.length * 32;
            const swaps: DoughSwap[] = [];
            const freshColors: DoughSlot[] = [];
            let possible = true;
            for (const [index, slot] of slots.entries()) {
              const current = contents[index];
              if (current === undefined || current === JOKER || current === color) continue;
              if (isLanding(slot)) { possible = false; break; }
              if (slot.stack >= settledStackCount || fresh[slot.stack][slot.depth]) {
                cost++;
                freshColors.push(slot);
                continue;
              }
              const donor = donors.get(color)?.find(candidate =>
                !slots.some(seat => seat.stack === candidate.stack && seat.depth === candidate.depth) &&
                !swaps.some(([, used]) => used === candidate));
              if (!donor) { possible = false; break; }
              swaps.push([slot, donor]);
              cost += 8 + (stacks[donor.stack].length - donor.depth) / 16;
            }
            if (possible && (!best || cost < best.cost)) best = { swaps, freshColors, additions, color, cost };
          }
        }
      }
    }
  }
  if (!best) return false;

  const { swaps, freshColors, additions, color } = best;
  for (const { stack, depth } of freshColors) {
    const insert = fresh[stack][depth];
    if (insert) insert.color = color;
    stacks[stack][depth] = color;
  }
  for (const [a, b] of swaps) {
    const original = stacks[a.stack][a.depth];
    stacks[a.stack][a.depth] = stacks[b.stack][b.depth];
    stacks[b.stack][b.depth] = original;
  }
  for (const { stack, depth } of additions) insertDough(state, inserts, stacks[stack], depth, color);
  if (swaps.length || (!refills && inserts.length)) {
    const below = additions.filter(({ stack, depth }) => stack === landingStack && depth === 0).length;
    const resolved = (seat: DoughSlot) => seat.stack === landingStack ? { ...seat, depth: seat.depth + below } : seat;
    boardRepairs.set(state, { swaps: swaps.map(([a, b]) => [resolved(a), resolved(b)]), inserts: refills ? [] : inserts });
  }
  return true;
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
  const { capacity } = state;
  const { movesLeft } = state;
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
  if (trialInserts.some(insert => insert.color === JOKER) ||
    hasQuickScore(trial.stacks, trial.capacity, trial.movesLeft, () => hasScoringMove(trial.stacks, trial.capacity))) {
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
    doughMeter: 0,
    gameOver: false,
    [paletteKey]: palette,
    [upgradePlanKey]: [],
  };
  ensureScoringRoute(state);
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
  ensureScoringRoute(next, undefined, stack);
  return next;
}

export function previewStackSweep(state: GameState): GameState | null {
  if (state.gameOver) return null;
  const next = { ...state, stacks: state.stacks.map(stack => stack.slice(0, -1)) };
  const hasTransfer = next.stacks.some((_, from) => next.stacks.some((_, to) => canMove(next, from, to)));
  return hasTransfer && ensureScoringRoute(next) ? next : null;
}

export function useStackSweep(state: GameState): GameState {
  return previewStackSweep(state) ?? state;
}

export function previewExtraChance(state: GameState): GameState | null {
  if (!state.gameOver) return null;
  const { endReason, ...run } = state;
  const next = {
    ...run, stacks: state.stacks.map(stack => stack.slice()), gameOver: false,
    doughMeter: DOUGH_METER_LIMIT - LEVEL_DOUGH_RELIEF,
  };
  if (totalSpace(next.stacks, next.capacity) === 0) {
    // Full boards can also come from older fixtures. Open one vacancy, taking
    // a natural donut and preferring a peel that needs no further board edit.
    const candidates = next.stacks.flatMap((stack, index) => stack.at(-1) === JOKER ? [] : [index]);
    const first = candidates[0];
    if (first === undefined) return null;
    const toOpen = candidates.find(index => {
      const stacks = next.stacks.map((stack, i) => i === index ? stack.slice(0, -1) : stack);
      return hasScoringMove(stacks, next.capacity) || findScoringRoute({ ...next, stacks });
    });
    next.stacks[toOpen ?? first].pop();
  }
  return ensureScoringRoute(next) ? next : null;
}

export function move(
  state: GameState, from: number, to: number, rng: () => number = Math.random,
  onDough?: (inserts: readonly DoughInsert[]) => void,
): GameState {
  if (!canMove(state, from, to)) return state;

  const next: RunState & { doughMeter: number } = {
    ...state, doughMeter: state.doughMeter ?? 0, stacks: state.stacks.map(stack => stack.slice()),
  };
  const source = next.stacks[from];
  const target = next.stacks[to];
  const color = source.pop()!;
  const matched = resolveMatch(target, color);
  target.push(color);
  if (!matched) {
    next.combo = 0;
    next.doughMeter++;
    if (next.doughMeter === DOUGH_METER_LIMIT) {
      next.gameOver = true;
      next.endReason = 'dough-meter';
      return next;
    }
    next.movesLeft--;
    if (next.movesLeft > 0) {
      const repairs: DoughInsert[] = [];
      ensureScoringRoute(next, repairs, to);
      if (repairs.length) onDough?.(repairs);
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
    const leveledUp = next.score >= next.nextLevelScore;
    const relief = Number(next.combo >= 5) + (leveledUp ? LEVEL_DOUGH_RELIEF : 0);
    next.doughMeter = Math.max(0, next.doughMeter - relief);
    if (runLength === 3 && matched.jokerIndex === undefined) refill(next, inserts, colors, rng, match, true);
    else refillWithContinuation(next, inserts, colors, rng, match, from, to, runLength);
    if (leveledUp) advanceLevel(next, colors, rng);
  } else {
    refill(next, inserts, colors, rng);
    next.movesLeft = rollPressureInterval(rng);
  }
  ensureScoringRoute(next, inserts, matched ? undefined : to, state.stacks.length);
  onDough?.(inserts);
  return next;
}
