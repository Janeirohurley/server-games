import assert from "node:assert/strict";

import {
  BOARD_HEIGHT,
  BOARD_WIDTH,
  PIECE_SPAWN,
  applyInput,
  clearFullLines,
  createEmptyBoard,
  createGame,
  drawPiece,
  getCells,
  getShape,
  getStartMatrix,
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

describe("tirage des pièces", () => {
  it("est déterministe pour une même graine", () => {
    assert.equal(drawPiece(7)[0], drawPiece(7)[0]);
    assert.equal(drawPiece(7)[1], drawPiece(7)[1]);
  });

  it("ne tire que des pièces connues et ne se bloque pas", () => {
    let rng = 123;
    for (let i = 0; i < 200; i++) {
      const [piece, next] = drawPiece(rng);
      assert.ok(PIECE_TYPES.includes(piece), `pièce inconnue : ${piece}`);
      rng = next;
    }
  });

  it("autorise deux fois la même pièce d'affilée (tirage uniforme, sans sac)", () => {
    // Sur un tirage uniforme, on finit forcément par voir un doublon.
    let rng = 1;
    let previous = "";
    let sawDouble = false;
    for (let i = 0; i < 500 && !sawDouble; i++) {
      const [piece, next] = drawPiece(rng);
      if (piece === previous) sawDouble = true;
      previous = piece;
      rng = next;
    }
    assert.ok(sawDouble, "aucun doublon en 500 tirages : ce n'est pas un tirage uniforme");
  });
});

describe("débris de départ", () => {
  it("laisse le plateau vide sans lignes de départ", () => {
    const { board } = getStartMatrix(0, 42);
    assert.equal(board.flat().filter((c) => c !== 0).length, 0);
  });

  it("empile les débris en bas, jamais plus haut que demandé", () => {
    for (const startLines of [3, 5, 10]) {
      const { board } = getStartMatrix(startLines, 42);
      const filledRows = board.filter((row) => row.some((c) => c !== 0)).length;
      assert.equal(filledRows, startLines, `${startLines} lignes de débris`);
      for (let y = 0; y < BOARD_HEIGHT - startLines; y++) {
        assert.ok(board[y].every((c) => c === 0), `ligne ${y} doit rester vide`);
      }
      for (let y = BOARD_HEIGHT - startLines; y < BOARD_HEIGHT; y++) {
        assert.ok(board[y].some((c) => c === 0), `ligne ${y} ne doit pas être pleine`);
      }
    }
  });

  it("donne le même plateau pour la même graine", () => {
    assert.deepEqual(getStartMatrix(7, 99).board, getStartMatrix(7, 99).board);
  });

  it("crée une partie jouable avec des lignes de départ et un niveau", () => {
    const game = createGame(1, 4, 6);
    assert.equal(game.level, 4);
    assert.equal(
      game.board.filter((row) => row.some((c) => c !== 0)).length,
      6,
    );
    assert.equal(game.status, "playing");
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

  it("refuse (sans kick) une rotation qui entre en collision", () => {
    // I vertical coincé entre le mur gauche et une colonne posée.
    const base = createGame(3);
    const blocked: TetrisState = {
      ...base,
      board: boardWithRows(1, [9]),
      current: { type: "I", rotation: 1, x: 9, y: BOARD_HEIGHT - 4 },
    };
    const rotated = applyInput(blocked, "rotate");
    assert.equal(rotated, blocked, "la rotation impossible renvoie le même état");
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
    assert.equal(after.current.y, PIECE_SPAWN[after.current.type].y, "la pièce suivante repart du haut");
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
      current: { type: "I", rotation: 1, x: 9, y: BOARD_HEIGHT - 4 },
    };
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
      current: { type: "I", rotation: 1, x: 9, y: BOARD_HEIGHT - 4 },
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
  it("passe en `over` quand la ligne du haut est occupée après la pose", () => {
    const state: TetrisState = {
      ...createGame(9),
      board: boardWithRows(BOARD_HEIGHT, [0]),
    };
    // Plateau plein partout sauf la colonne 0 : la pièce ne peut pas descendre
    // et, en se posant, laisse la ligne du haut occupée.
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
