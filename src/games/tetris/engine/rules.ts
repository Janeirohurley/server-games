import {
  clearFullLines,
  collides,
  dropDistance,
  getStartMatrix,
  lockPiece,
} from "./board.js";
import {
  CLEAR_POINTS,
  LINES_PER_LEVEL,
  MAX_LEVEL,
  MAX_SCORE,
  PIECE_ORIGINS,
  PIECE_SPAWN,
  QUEUE_MIN,
} from "./constants.js";
import { drawPiece } from "./rng.js";
import type { ActivePiece, PieceType, TetrisInput, TetrisState } from "./types.js";

/** Pièce à son apparition : même position que `Block.xy` de l'original. */
function spawn(type: PieceType): ActivePiece {
  const { x, y } = PIECE_SPAWN[type];
  return { type, rotation: 0, x, y };
}

/** Complète la file avec des tirages tant qu'il manque de pièces visibles. */
function refillQueue(queue: PieceType[], rngState: number) {
  let q = queue;
  let rng = rngState;
  while (q.length < QUEUE_MIN + 1) {
    const [piece, next] = drawPiece(rng);
    q = [...q, piece];
    rng = next;
  }
  return { queue: q, rngState: rng };
}

/**
 * Crée une partie. `seed` fixe toute la suite de pièces : même graine,
 * même partie — c'est ce qui rendra le Tetris en ligne équitable.
 */
export function createGame(
  seed: number,
  startLevel = 1,
  startLines = 0,
): TetrisState {
  const level = Math.min(Math.max(Math.trunc(startLevel), 1), MAX_LEVEL);
  const { board, rngState: afterMatrix } = getStartMatrix(startLines, seed >>> 0);
  const { queue, rngState } = refillQueue([], afterMatrix);
  const [first, ...rest] = queue;
  return {
    board,
    current: spawn(first),
    queue: rest,
    rngState,
    score: 0,
    lines: 0,
    startLevel: level,
    level,
    status: "playing",
  };
}

function tryMove(state: TetrisState, dx: number, dy: number): TetrisState {
  const moved = { ...state.current, x: state.current.x + dx, y: state.current.y + dy };
  return collides(state.board, moved) ? state : { ...state, current: moved };
}

/**
 * Rotation fidèle à l'original : la pièce est tournée puis décalée du pivot
 * `PIECE_ORIGINS[type][rotation % n]`. Si le résultat entre en collision, la
 * rotation est REFUSÉE — aucun « wall kick » n'est tenté.
 */
function tryRotate(state: TetrisState): TetrisState {
  const { type, rotation } = state.current;
  const origins = PIECE_ORIGINS[type];
  const [dx, dy] = origins[rotation % origins.length];
  const candidate: ActivePiece = {
    ...state.current,
    rotation: (rotation + 1) % 4,
    x: state.current.x + dx,
    y: state.current.y + dy,
  };
  return collides(state.board, candidate) ? state : { ...state, current: candidate };
}

/**
 * Fige la pièce courante, retire les lignes, marque les points et fait
 * apparaître la suivante. Barème repris de l'original :
 *   - +10 points par pièce posée, +2 par niveau au-dessus du premier ;
 *   - +100 / 300 / 700 / 1500 pour 1 / 2 / 3 / 4 lignes d'un coup.
 */
function lockAndSpawn(state: TetrisState): TetrisState {
  const locked = lockPiece(state.board, state.current);
  const { board, cleared } = clearFullLines(locked);

  const lines = state.lines + cleared;
  const level = Math.min(
    state.startLevel + Math.floor(lines / LINES_PER_LEVEL),
    MAX_LEVEL,
  );
  const lockPoints = 10 + (state.level - 1) * 2;
  const clearPoints = cleared > 0 ? CLEAR_POINTS[cleared - 1] : 0;
  const score = Math.min(state.score + lockPoints + clearPoints, MAX_SCORE);

  const { queue, rngState } = refillQueue(state.queue, state.rngState);
  const [nextType, ...rest] = queue;
  const current = spawn(nextType);

  // Comme l'original : la partie se termine quand la ligne du HAUT est occupée.
  const over = board[0].some((cell) => cell !== 0);

  return {
    ...state,
    board,
    current,
    queue: rest,
    rngState,
    score,
    lines,
    level,
    status: over ? "over" : "playing",
  };
}

/** Un pas de gravité : descend d'une case, ou fige la pièce si elle est posée. */
function stepDown(state: TetrisState): TetrisState {
  const moved = tryMove(state, 0, 1);
  return moved === state ? lockAndSpawn(state) : moved;
}

/**
 * Point d'entrée unique du moteur : fonction pure `(état, intention) -> état`.
 * Une partie terminée ignore toute entrée. Une entrée illégale (mur, pile)
 * renvoie le MÊME objet d'état, ce qui permet à l'UI d'éviter un re-rendu.
 */
export function applyInput(state: TetrisState, input: TetrisInput): TetrisState {
  if (state.status !== "playing") return state;
  switch (input) {
    case "left":
      return tryMove(state, -1, 0);
    case "right":
      return tryMove(state, 1, 0);
    case "rotate":
      return tryRotate(state);
    case "softDrop":
    case "tick":
      return stepDown(state);
    case "hardDrop": {
      const distance = dropDistance(state.board, state.current);
      const dropped = {
        ...state,
        current: { ...state.current, y: state.current.y + distance },
      };
      return lockAndSpawn(dropped);
    }
    default:
      return state;
  }
}
