import assert from "node:assert/strict";

import {
  createTrack,
  FINISHED_POSITION,
  HEX_ARM_LENGTH,
  HEX_FINISHED_POSITION,
  HEX_HOME_COLUMN_START,
  HEX_RING_LENGTH,
  HOME_COLUMN_START,
  PIECES_PER_PLAYER,
  RING_LENGTH,
  type LudoColor,
} from "../src/games/ludo/ludo-state.js";
import {
  destinationOf,
  grantsExtraTurn,
  hasWon,
  legalMoves,
  resolveCaptures,
  type RulePiece,
  type SeatedPlayer,
} from "../src/games/ludo/ludo-rules.js";

const piece = (index: number, position: number): RulePiece => ({ index, position });

// La croix classique a quatre bras FIXES. `playerCount` ne choisit plus que
// les bras occupés, donc les tables à 2 et 3 joueurs ne sont plus des anneaux
// re-espacés (0/17/35) mais la même croix que la table à 4, avec des bras
// vides. Ces valeurs sont le contrat canonique, et les 4 joueurs restent
// exactement ceux qui ont été livrés.
const CLASSIC_OFFSETS: Record<number, number[]> = {
  2: [0, 26],
  3: [0, 13, 26],
  4: [0, 13, 26, 39],
};
const CLASSIC_SAFE = [0, 8, 13, 21, 26, 34, 39, 47];

describe("tables 2 à 4 joueurs : la même croix à quatre bras", () => {
  for (const n of [2, 3, 4]) {
    it(`${n} joueurs : mêmes départs, mêmes cases sûres, anneau 52, arrivée 57`, () => {
      const track = createTrack(n);
      assert.equal(track.shape, "classic");
      assert.equal(track.ringLength, RING_LENGTH);
      assert.equal(track.homeColumnStart, HOME_COLUMN_START);
      assert.equal(track.finishedPosition, FINISHED_POSITION);
      assert.deepEqual([...track.offsets.values()], CLASSIC_OFFSETS[n]);
      // Les huit cases sûres ne dépendent pas de la taille : elles sont
      // imprimées sur le plateau, bras occupés ou non.
      assert.deepEqual([...track.safeCells].sort((a, b) => a - b), CLASSIC_SAFE);
      for (const color of track.colors) {
        const offset = track.offsets.get(color)!;
        for (let path = 0; path < FINISHED_POSITION; path++) {
          assert.equal(track.ringIndexOf(color, path), (offset + path) % 52);
        }
      }
    });
  }
});

describe("tables 5 et 6 joueurs : plateau hexagonal", () => {
  for (const n of [5, 6]) {
    it(`${n} joueurs : anneau 78, maison 77-82, arrivée 83`, () => {
      const track = createTrack(n);
      assert.equal(track.shape, "hex");
      assert.equal(track.ringLength, HEX_RING_LENGTH);
      assert.equal(track.ringLength, 78);
      assert.equal(track.homeColumnStart, HEX_HOME_COLUMN_START);
      assert.equal(track.homeColumnStart, 77);
      assert.equal(track.finishedPosition, HEX_FINISHED_POSITION);
      assert.equal(track.finishedPosition, 83);
    });

    it(`${n} joueurs : un bras par siège, départs espacés de 13 cases exactement`, () => {
      const track = createTrack(n);
      assert.equal(track.colors.length, n);
      assert.equal(new Set(track.colors).size, n);
      const offsets = track.colors.map((c) => track.offsets.get(c));
      assert.deepEqual(offsets, Array.from({ length: n }, (_, seat) => seat * HEX_ARM_LENGTH));
    });
  }

  it("5 et 6 joueurs dessinent le même plateau : mêmes 12 cases sûres", () => {
    const five = [...createTrack(5).safeCells].sort((a, b) => a - b);
    const six = [...createTrack(6).safeCells].sort((a, b) => a - b);
    assert.deepEqual(five, six);
    assert.equal(six.length, 12);
    assert.deepEqual(six, [0, 8, 13, 21, 26, 34, 39, 47, 52, 60, 65, 73]);
  });

  it("une étoile n'est jamais sur une case de départ", () => {
    const track = createTrack(6);
    const starts = new Set(track.offsets.values());
    const stars = [...track.safeCells].filter((cell) => !starts.has(cell));
    assert.equal(stars.length, 6);
  });

  it("le parcours fait 77 cases d'anneau distinctes et évite la case juste avant le départ", () => {
    const track = createTrack(6);
    for (const color of track.colors) {
      const offset = track.offsets.get(color)!;
      const cells = Array.from({ length: HEX_HOME_COLUMN_START }, (_, path) => track.ringIndexOf(color, path));
      assert.equal(new Set(cells).size, 77);
      assert.ok(!cells.includes((offset + 77) % 78), "la case offset-1 est le raccourci vers la maison");
      assert.equal(cells[0], offset);
    }
  });

  it("l'anneau se referme : le siège 5 passe de la case 77 à la case 0", () => {
    const track = createTrack(6);
    const purple = track.colors[5] as LudoColor;
    assert.equal(track.ringIndexOf(purple, 13), 0);
  });
});

describe("règles sur le plateau hexagonal", () => {
  it("destinationOf sans 3e argument garde la règle classique (57)", () => {
    assert.equal(destinationOf(piece(0, 55), 2), 57);
    assert.equal(destinationOf(piece(0, 55), 3), null);
  });

  it("l'arrivée à 83 exige un lancer exact", () => {
    assert.equal(destinationOf(piece(0, 80), 3, 83), 83);
    assert.equal(destinationOf(piece(0, 80), 4, 83), null);
    assert.equal(destinationOf(piece(0, 82), 1, 83), 83);
    assert.equal(destinationOf(piece(0, 83), 1, 83), null);
  });

  it("sortir de la base demande toujours un 6", () => {
    assert.equal(destinationOf(piece(0, -1), 5, 83), null);
    assert.equal(destinationOf(piece(0, -1), 6, 83), 0);
  });

  it("legalMoves : un pion à 80 finit avec un 3, pas avec un 4", () => {
    const track = createTrack(6);
    const yellow = track.colors[0];
    const with3 = legalMoves(track, yellow, [piece(0, 80)], 3);
    assert.equal(with3.length, 1);
    assert.equal(with3[0].finishes, true);
    assert.equal(with3[0].destinationRing, -1);
    assert.equal(legalMoves(track, yellow, [piece(0, 80)], 4).length, 0);
  });

  it("legalMoves : un pion en position 83 ne bouge plus", () => {
    const track = createTrack(5);
    assert.equal(legalMoves(track, track.colors[0], [piece(0, 83)], 1).length, 0);
  });

  it("hasWon : quatre pions à 83", () => {
    const four = [0, 1, 2, 3].map((i) => piece(i, 83));
    assert.equal(hasWon(four, 83), true);
    assert.equal(hasWon(four), false, "sans 2e argument, 83 n'est pas l'arrivée classique");
    assert.equal(hasWon([...four.slice(0, 3), piece(3, 82)], 83), false);
  });

  it("capture : le siège 1 atterrit sur une case ordinaire occupée par le siège 0", () => {
    const track = createTrack(6);
    // Case d'anneau 15 : ni départ ni étoile. Siège 1 (offset 13) -> chemin 2.
    // Siège 0 (offset 0) -> chemin 15.
    assert.equal(track.isSafeCell(15), false);
    const opponents: SeatedPlayer[] = [
      { color: track.colors[0], pieces: [piece(0, 15), piece(1, -1), piece(2, -1), piece(3, -1)] },
    ];
    const hit = resolveCaptures(track, track.colors[1], 2, opponents);
    assert.deepEqual(hit, [0]);
  });

  it("aucune capture sur une case sûre (départ et étoile)", () => {
    const track = createTrack(6);
    for (const safe of [0, 8, 13, 21, 73]) {
      const opponents: SeatedPlayer[] = [
        { color: track.colors[0], pieces: [piece(0, safe)] },
      ];
      // Le siège 3 (offset 39) atteint la case `safe` au chemin (safe - 39 + 78) % 78.
      const path = (safe - 39 + 78) % 78;
      if (path >= track.homeColumnStart) continue;
      assert.deepEqual(resolveCaptures(track, track.colors[3], path, opponents), [], `case ${safe}`);
    }
  });

  it("pas de capture dans la colonne maison (77 et plus), ni par elle", () => {
    const track = createTrack(6);
    const opponents: SeatedPlayer[] = [
      { color: track.colors[0], pieces: [piece(0, 77), piece(1, 80)] },
    ];
    assert.deepEqual(resolveCaptures(track, track.colors[1], 77, opponents), []);
    assert.deepEqual(resolveCaptures(track, track.colors[1], 83, opponents), []);
  });

  it("on ne se capture pas soi-même", () => {
    const track = createTrack(6);
    const own: SeatedPlayer[] = [{ color: track.colors[2], pieces: [piece(0, 10), piece(1, 12)] }];
    assert.deepEqual(resolveCaptures(track, track.colors[2], 12, own), []);
  });
});

// ---------------------------------------------------------------------------
// Parties complètes avec les vraies règles
// ---------------------------------------------------------------------------

interface SimPlayer {
  color: LudoColor;
  finished: number;
  pieces: RulePiece[];
}

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Rejoue LudoRoom.handleRollDice / applyMove / endTurn avec les vraies règles. */
function playGame(playerCount: number, seed: number) {
  const random = mulberry32(seed);
  const track = createTrack(playerCount);
  const players: SimPlayer[] = Array.from({ length: playerCount }, (_, i) => ({
    color: track.colorAt(i),
    finished: 0,
    pieces: Array.from({ length: PIECES_PER_PLAYER }, (_, index) => ({ index, position: -1 })),
  }));

  let current = 0;
  let extraRolls = 0;
  let rolls = 0;
  let captures = 0;

  const endTurn = () => {
    extraRolls = 0;
    for (let step = 1; step <= players.length; step++) {
      const next = (current + step) % players.length;
      if (players[next].finished < PIECES_PER_PLAYER) {
        current = next;
        return;
      }
    }
  };

  while (rolls < 200_000) {
    rolls++;
    const me = players[current];
    const dice = 1 + Math.floor(random() * 6);
    const moves = legalMoves(track, me.color, me.pieces, dice);

    if (moves.length === 0) {
      if (dice === 6) continue;
      endTurn();
      continue;
    }

    const choice = moves[Math.floor(random() * moves.length)].pieceIndex;
    const mover = me.pieces[choice];
    const destination = destinationOf(mover, dice, track.finishedPosition);
    assert.notEqual(destination, null);

    const hit = resolveCaptures(track, me.color, destination!, players);
    mover.position = destination!;
    if (destination === track.finishedPosition) me.finished++;

    if (hit.length > 0) {
      const ring = track.ringIndexOf(me.color, destination!);
      for (const other of players) {
        if (other === me) continue;
        for (const p of other.pieces) {
          if (
            p.position >= 0 &&
            p.position < track.homeColumnStart &&
            track.ringIndexOf(other.color, p.position) === ring
          ) {
            p.position = -1;
            captures++;
          }
        }
      }
    }

    // Invariants à chaque coup.
    for (const p of players) {
      for (const q of p.pieces) {
        assert.ok(q.position >= -1 && q.position <= track.finishedPosition, `position ${q.position}`);
      }
    }
    // Hors cases sûres, deux couleurs ne partagent jamais une case d'anneau.
    const seen = new Map<number, LudoColor>();
    for (const p of players) {
      for (const q of p.pieces) {
        if (q.position < 0 || q.position >= track.homeColumnStart) continue;
        const ring = track.ringIndexOf(p.color, q.position);
        const owner = seen.get(ring);
        if (owner && owner !== p.color) {
          assert.ok(track.isSafeCell(ring), `deux couleurs sur la case ordinaire ${ring}`);
        }
        seen.set(ring, p.color);
      }
    }

    if (hasWon(me.pieces, track.finishedPosition)) return { winner: current, rolls, captures };

    if (grantsExtraTurn(dice, { captures: hit, finishes: destination === track.finishedPosition })) {
      extraRolls++;
      if (extraRolls >= 12) endTurn();
    } else {
      endTurn();
    }
  }
  throw new Error(`pas de fin de partie (${playerCount} joueurs, graine ${seed})`);
}

describe("parties complètes avec les vraies règles", () => {
  for (let n = 2; n <= 6; n++) {
    it(`${n} joueurs : 150 parties terminent, invariants respectés`, () => {
      let rolls = 0;
      let captures = 0;
      const wins = new Array(n).fill(0);
      for (let seed = 1; seed <= 150; seed++) {
        const r = playGame(n, seed * 104729 + n);
        wins[r.winner]++;
        rolls += r.rolls;
        captures += r.captures;
      }
      console.log(
        `      ${n} joueurs : ${Math.round(rolls / 150)} lancers/partie, ${Math.round(captures / 150)} captures/partie, victoires ${wins.join("/")}`,
      );
      assert.ok(captures > 0);
    });
  }
});
