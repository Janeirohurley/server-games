import assert from "node:assert/strict";

import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  applyInput,
  clearFullLines,
  collides,
  createEmptyBoard,
  createGame,
  drawBag,
  getCells,
  getShape,
  PIECE_TYPES,
  type Board,
  type Cell,
  type TetrisState,
} from "../src/games/tetris/engine/index.js";

/** Plateau où les `rows` dernières lignes sont pleines sauf les colonnes `gaps`. */
function boardWithRows(rows: number, gaps: number[] = []): Board {
  const board = createEmptyBoard();
  for (let r = 0; r < rows; r++) {
    for (let x = 0; x < BOARD_WIDTH; x++) {
      if (!gaps.includes(x)) board[BOARD_HEIGHT - 1 - r][x] = 1 as Cell;
    }
  }
  return board;
}

describe("sac de 7 pièces", () => {
  it("contient chaque pièce exactement une fois", () => {
    const [bag] = drawBag(42);
    assert.deepEqual([...bag].sort(), [...PIECE_TYPES].sort());
  });

  it("est déterministe pour une même graine", () => {
    assert.deepEqual(drawBag(7)[0], drawBag(7)[0]);
    assert.notDeepEqual(drawBag(7)[0], drawBag(8)[0]);
  });
});

describe("rotation", () => {
  it("revient à la forme de départ après 4 quarts de tour", () => {
    for (const type of PIECE_TYPES) {
      assert.deepEqual(getShape(type, 4), getShape(type, 0));
    }
  });

  it("garde 4 cases pour chaque pièce et chaque rotation", () => {
    for (const type of PIECE_TYPES) {
      for (let r = 0; r < 4; r++) {
        const cells = getCells({ type, rotation: r, x: 3, y: 3 });
        assert.equal(cells.length, 4, `${type} rotation ${r}`);
      }
    }
  });

  it("fait passer le I de l'horizontale à la verticale", () => {
    const flat = getCells({ type: "I", rotation: 0, x: 0, y: 0 });
    const upright = getCells({ type: "I", rotation: 1, x: 0, y: 0 });
    assert.equal(new Set(flat.map(([, y]) => y)).size, 1);
    assert.equal(new Set(upright.map(([x]) => x)).size, 1);
  });
});

describe("déplacements", () => {
  it("bouge à gauche puis s'arrête contre le mur", () => {
    let state = createGame(1);
    for (let i = 0; i < 20; i++) state = applyInput(state, "left");
    assert.ok(getCells(state.current).every(([x]) => x >= 0));
    const stuck = applyInput(state, "left");
    assert.equal(stuck, state, "une entrée illégale renvoie le même objet");
  });

  it("bouge à droite puis s'arrête contre le mur", () => {
    let state = createGame(1);
    for (let i = 0; i < 20; i++) state = applyInput(state, "right");
    assert.ok(getCells(state.current).every(([x]) => x < BOARD_WIDTH));
  });

  it("recule une rotation impossible contre le mur (kick) sans sortir", () => {
    let state = createGame(3);
    state = { ...state, current: { type: "I", rotation: 1, x: -1, y: 5 } };
    const rotated = applyInput(state, "rotate");
    assert.equal(collides(rotated.board, rotated.current), false);
  });
});

describe("chute et pose", () => {
  it("descend d'une case à chaque tick", () => {
    const state = createGame(5);
    const next = applyInput(state, "tick");
    assert.equal(next.current.y, state.current.y + 1);
  });

  it("fige la pièce au sol puis en fait apparaître une nouvelle", () => {
    const state = createGame(5);
    const after = applyInput(state, "hardDrop");
    const filled = after.board.flat().filter((c) => c !== 0).length;
    assert.equal(filled, 4);
    assert.equal(after.current.y, -1, "la pièce suivante repart du haut");
    assert.equal(after.status, "playing");
  });

  it("consomme la file sans jamais la laisser se vider", () => {
    let state = createGame(11);
    for (let i = 0; i < 60 && state.status === "playing"; i++) {
      state = applyInput(state, "hardDrop");
      assert.ok(state.queue.length >= 5);
    }
  });
});

describe("lignes et score", () => {
  it("retire une ligne pleine et fait descendre le reste", () => {
    const board = boardWithRows(1);
    board[BOARD_HEIGHT - 2][0] = 2;
    const { board: result, cleared } = clearFullLines(board);
    assert.equal(cleared, 1);
    assert.equal(result[BOARD_HEIGHT - 1][0], 2);
    assert.equal(result[BOARD_HEIGHT - 2][0], 0);
    assert.equal(result.length, BOARD_HEIGHT);
  });

  it("marque 1500 points pour un Tetris (4 lignes d'un coup)", () => {
    // 4 lignes pleines sauf la colonne 9 ; un I vertical la comble.
    const base = createGame(1);
    const state: TetrisState = {
      ...base,
      board: boardWithRows(4, [9]),
      current: { type: "I", rotation: 1, x: 7, y: BOARD_HEIGHT - 4 },
    };
    // I vertical : sa colonne pleine est la 3e de la matrice 4x4 (x + 2 = 9).
    const after = applyInput(state, "hardDrop");
    assert.equal(after.lines, 4);
    assert.equal(after.score, 10 + 1500);
    assert.equal(after.board.flat().filter((c) => c !== 0).length, 0);
  });

  it("monte de niveau toutes les 20 lignes, plafonné à 6", () => {
    const base = createGame(1);
    const state: TetrisState = {
      ...base,
      lines: 19,
      board: boardWithRows(1, [9]),
      current: { type: "I", rotation: 1, x: 7, y: BOARD_HEIGHT - 4 },
    };
    const after = applyInput(state, "hardDrop");
    assert.equal(after.lines, 20);
    assert.equal(after.level, 2);

    const capped = applyInput({ ...state, lines: 999 }, "hardDrop");
    assert.equal(capped.level, 6);
  });

  it("donne plus de points de pose aux niveaux élevés", () => {
    const low = applyInput(createGame(2, 1), "hardDrop");
    const high = applyInput(createGame(2, 6), "hardDrop");
    assert.equal(low.score, 10);
    assert.equal(high.score, 10 + 5 * 2);
  });
});

describe("fin de partie", () => {
  it("passe en `over` quand la pile bloque l'apparition", () => {
    const state: TetrisState = {
      ...createGame(9),
      board: boardWithRows(BOARD_HEIGHT, [0]),
    };
    // Plateau plein partout sauf la colonne 0 : la pièce ne peut plus apparaître.
    const after = applyInput(state, "hardDrop");
    assert.equal(after.status, "over");
  });

  it("ignore toute entrée une fois la partie terminée", () => {
    const over: TetrisState = { ...createGame(1), status: "over" };
    for (const input of ["left", "right", "rotate", "softDrop", "hardDrop", "tick"] as const) {
      assert.equal(applyInput(over, input), over);
    }
  });
});

describe("déterminisme", () => {
  it("rejoue exactement la même partie avec la même graine et les mêmes entrées", () => {
    const inputs = ["left", "rotate", "tick", "hardDrop", "right", "right", "hardDrop"] as const;
    const play = () => inputs.reduce(applyInput, createGame(1234));
    assert.deepEqual(play(), play());
  });
});
