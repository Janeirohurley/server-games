import {
  clearFullLines,
  collides,
  createEmptyBoard,
  dropDistance,
  getShape,
  lockPiece,
} from "./board.js";
import {
  BOARD_WIDTH,
  CLEAR_POINTS,
  KICK_OFFSETS,
  LINES_PER_LEVEL,
  MAX_LEVEL,
  MAX_SCORE,
  QUEUE_MIN,
} from "./constants.js";
import { drawBag } from "./rng.js";
import type { ActivePiece, PieceType, TetrisInput, TetrisState } from "./types.js";

/** Pièce à son apparition : centrée, un cran au-dessus du plateau. */
function spawn(type: PieceType): ActivePiece {
  const size = getShape(type, 0).length;
  return { type, rotation: 0, x: Math.floor((BOARD_WIDTH - size) / 2), y: -1 };
}

/** Complète la file avec des sacs tant qu'il manque de pièces visibles. */
function refillQueue(queue: PieceType[], rngState: number) {
  let q = queue;
  let rng = rngState;
  while (q.length < QUEUE_MIN + 1) {
    const [bag, next] = drawBag(rng);
    q = [...q, ...bag];
    rng = next;
  }
  return { queue: q, rngState: rng };
}

/**
 * Crée une partie. `seed` fixe toute la suite de pièces : même graine,
 * même partie — c'est ce qui rendra le Tetris en ligne équitable.
 */
export function createGame(seed: number, startLevel = 1): TetrisState {
  const level = Math.min(Math.max(Math.trunc(startLevel), 1), MAX_LEVEL);
  const { queue, rngState } = refillQueue([], seed >>> 0);
  const [first, ...rest] = queue;
  return {
    board: createEmptyBoard(),
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

function tryRotate(state: TetrisState): TetrisState {
  const rotation = (state.current.rotation + 1) % 4;
  for (const [dx, dy] of KICK_OFFSETS) {
    const candidate = {
      ...state.current,
      rotation,
      x: state.current.x + dx,
      y: state.current.y + dy,
    };
    if (!collides(state.board, candidate)) return { ...state, current: candidate };
  }
  return state;
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

  return {
    ...state,
    board,
    current,
    queue: rest,
    rngState,
    score,
    lines,
    level,
    // Si la nouvelle pièce ne tient pas à son apparition, la pile a atteint le haut.
    status: collides(board, current) ? "over" : "playing",
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
