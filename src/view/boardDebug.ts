import type { DoughInsert, GameState } from '../game';

type BoardAction =
  | { kind: 'transfer'; fromStackIndex: number; toStackIndex: number }
  | { kind: 'joker'; stackIndex: number }
  | { kind: 'sweep' | 'extra-chance' };

type AppliedAction = BoardAction & { refillInsertions: DoughInsert[] };
type BoardState = ReturnType<typeof captureBoard>;

interface TerminalBoard {
  runId: number;
  before: BoardState;
  after: BoardState;
  action: AppliedAction;
}

interface BoardSnapshot {
  current: BoardState & { runId: number; lastAction: AppliedAction | null };
  lastGameOver: TerminalBoard | null;
}

declare global {
  interface Window {
    readonly rebornBoardSnapshot?: () => BoardSnapshot;
  }
}

function captureBoard({ stacks, capacity, score, level, rank, nextLevelScore, movesLeft, combo, gameOver }: GameState) {
  return {
    stacks: stacks.map((colors, index) => ({ index, colorsBottomFirst: colors.slice() })),
    capacity, score, level, rank, nextLevelScore, movesLeft, combo: combo ?? 0, gameOver,
  };
}

export function installBoardDebug(target: Window, currentState: () => GameState) {
  let runId = 1;
  let lastAction: AppliedAction | null = null;
  let lastGameOver: TerminalBoard | null = null;

  function read(): BoardSnapshot {
    return {
      current: { ...captureBoard(currentState()), runId, lastAction: structuredClone(lastAction) },
      lastGameOver: structuredClone(lastGameOver),
    };
  }

  Object.defineProperty(target, 'rebornBoardSnapshot', { configurable: true, value: read });

  return {
    applied(before: GameState, after: GameState, action: BoardAction, inserts: readonly DoughInsert[] = []): void {
      if (before === after) return;
      // Stack indices and insertion depths are zero-based. Each depth is measured before that insertion.
      lastAction = { ...action, refillInsertions: inserts.map(insert => ({ ...insert })) };
      if (!before.gameOver && after.gameOver) {
        lastGameOver = { runId, before: captureBoard(before), after: captureBoard(after), action: lastAction };
      }
    },
    restart(): void {
      runId++;
      lastAction = null;
    },
    dispose(): void {
      if (target.rebornBoardSnapshot === read) Reflect.deleteProperty(target, 'rebornBoardSnapshot');
    },
  };
}
