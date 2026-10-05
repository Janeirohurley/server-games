import assert from "assert";

import {
  createTrack,
  FINISHED_POSITION,
  HOME_COLUMN_START,
  LUDO_PALETTE,
  MAX_PLAYER_COUNT,
  MIN_PLAYER_COUNT,
  RING_LENGTH,
  type LudoColor,
  type LudoTrack,
} from "../src/games/ludo/ludo-state.js";
import { resolveCaptures } from "../src/games/ludo/ludo-rules.js";

/*
 * Géométrie par taille de table.
 *
 * Le créateur choisit la taille : la piste doit donc se construire pour
 * N = 2..6. Ces tests verrouillent les invariants que le client doit
 * retrouver, et surtout l'exactitude du plateau 4 joueurs — celui qui a
 * été livré. Toute modification de la répartition des départs à N=4 est
 * une régression, pas un détail.
 */

const SIZES = [
  MIN_PLAYER_COUNT,
  3,
  4,
  5,
  MAX_PLAYER_COUNT,
] as const;

// Plateau classique (anneau de 52 cases) : 2 à 4 joueurs. Les tables de
// 5 et 6 joueurs jouent sur le plateau hexagonal (anneau de 78 cases),
// couvert par ludo-hex-board.test.ts.
const CLASSIC_SIZES = [MIN_PLAYER_COUNT, 3, 4] as const;

const offsetsOf = (track: LudoTrack): number[] =>
  track.colors.map((color) => track.offsets.get(color) as number);

describe("Ludo — construction de la piste", () => {
  it("refuse une taille hors du plateau au lieu de la tronquer", () => {
    // Tronquer masquerait le bug appelant derrière une table « presque
    // correcte » : mieux vaut une room qui ne démarre pas.
    for (const bad of [0, 1, 7, 12, 2.5, Number.NaN]) {
      assert.throws(
        () => createTrack(bad),
        `createTrack(${bad}) aurait dû lever`,
      );
    }
  });

  it("attribue les premières couleurs de la palette, dans l'ordre des sièges", () => {
    for (const size of SIZES) {
      const track = createTrack(size);
      assert.deepStrictEqual(
        [...track.colors],
        LUDO_PALETTE.slice(0, size),
        `couleurs inattendues pour ${size} joueurs`,
      );
    }
  });

  it("donne à chaque joueur un départ distinct sur l'anneau", () => {
    for (const size of SIZES) {
      const track = createTrack(size);
      const offsets = offsetsOf(track);
      assert.strictEqual(
        new Set(offsets).size,
        size,
        `départs dupliqués pour ${size} joueurs : ${offsets.join(",")}`,
      );
      for (const offset of offsets) {
        assert.ok(
          Number.isInteger(offset) && offset >= 0 && offset < track.ringLength,
          `départ ${offset} hors de l'anneau pour ${size} joueurs`,
        );
      }
    }
  });

  it("répartit les segments aussi également que 52 cases le permettent", () => {
    for (const size of CLASSIC_SIZES) {
      const offsets = offsetsOf(createTrack(size)).sort((a, b) => a - b);
      const segments: number[] = [];
      for (let i = 0; i < size; i += 1) {
        segments.push(
          (offsets[(i + 1) % size] - offsets[i] + RING_LENGTH) % RING_LENGTH,
        );
      }
      // 52 = 2 x 2 x 13 : seuls 2 et 4 divisent l'anneau. Sinon les
      // segments ont une case d'écart, pas davantage.
      assert.ok(
        Math.max(...segments) - Math.min(...segments) <= 1,
        `segments ${segments.join(",")} trop irréguliers pour ${size} joueurs`,
      );
    }
  });

  it("refuse de calculer une piste pour une couleur non assise", () => {
    const track = createTrack(3);
    // Sans ce garde-fou, une couleur absente se traduirait par un
    // décalage `undefined` -> NaN, et les captures deviendraient
    // silencieusement fausses au lieu d'échouer.
    assert.throws(() => track.ringIndexOf("purple", 3));
  });
});

describe("Ludo — le plateau 4 joueurs reste exactement celui qui a été livré", () => {
  // Ces valeurs sont une épingle de régression, pas un calcul : le
  // client 4 joueurs a ces cases codées en dur dans ses données de
  // plateau. Les changer casse la table déjà en jeu.
  it("conserve les départs 0 / 13 / 26 / 39", () => {
    const track = createTrack(4);
    assert.deepStrictEqual(
      track.colors.map((color) => track.offsets.get(color)),
      [0, 13, 26, 39],
    );
  });

  it("conserve les quatre couleurs historiques", () => {
    assert.deepStrictEqual([...createTrack(4).colors], [
      "yellow",
      "red",
      "blue",
      "green",
    ]);
  });

  it("conserve la longueur des paths et la colonne maison", () => {
    // L'anneau ne change pas de taille, donc la position de fin ne
    // bouge pas quel que soit le nombre de joueurs.
    assert.strictEqual(RING_LENGTH, 52);
    assert.strictEqual(HOME_COLUMN_START, 51);
    assert.strictEqual(FINISHED_POSITION, 57);
  });
});

describe("Ludo — cases sûres", () => {
  it("protège chaque départ et une étoile par segment", () => {
    for (const size of CLASSIC_SIZES) {
      const track = createTrack(size);
      assert.strictEqual(
        track.safeCells.size,
        size * 2,
        `attendu ${size * 2} cases sûres pour ${size} joueurs, obtenu ${track.safeCells.size}`,
      );
      for (const offset of offsetsOf(track)) {
        assert.ok(track.isSafeCell(offset), `départ ${offset} non protégé`);
      }
    }
  });

  it("place l'étoile au milieu du segment, jamais sur un départ", () => {
    for (const size of CLASSIC_SIZES) {
      const track = createTrack(size);
      const segment = RING_LENGTH / size;
      const offsets = offsetsOf(track);
      for (const offset of offsets) {
        const star = (offset + Math.round(segment / 2)) % RING_LENGTH;
        assert.ok(track.isSafeCell(star), `étoile ${star} absente`);
        // Une étoile sur un départ rendrait deux segments voisins
        // partiellement indiscernables.
        assert.ok(
          !offsets.includes(star),
          `l'étoile ${star} chevauche un départ (${size} joueurs)`,
        );
      }
    }
  });

  it("laisse les cases ordinaires attaquables", () => {
    const track = createTrack(3);
    for (const ring of [1, 2, 3, 5, 6, 7, 8]) {
      assert.ok(!track.isSafeCell(ring), `la case ${ring} ne doit pas être sûre`);
    }
    // Plateau hexagonal : sûres = départ (13k) et étoile (13k + 8).
    const hex = createTrack(6);
    for (const ring of [1, 2, 3, 4, 5, 6, 7, 9, 12]) {
      assert.ok(!hex.isSafeCell(ring), `la case ${ring} ne doit pas être sûre (hex)`);
    }
  });
});

describe("Ludo — conversion path ↔ anneau", () => {
  it("fait l'aller-retour sur toute la portion d'anneau du path", () => {
    for (const size of SIZES) {
      const track = createTrack(size);
      for (const color of track.colors) {
        const offset = track.offsets.get(color) as number;
        for (
          let pathIndex = 0;
          pathIndex < track.homeColumnStart;
          pathIndex += 1
        ) {
          const ring = track.ringIndexOf(color, pathIndex);
          assert.ok(ring >= 0 && ring < track.ringLength);
          assert.strictEqual(
            (ring - offset + track.ringLength) % track.ringLength,
            pathIndex,
            `aller-retour cassé pour ${color}@${pathIndex} (${size} joueurs)`,
          );
        }
      }
    }
  });

  it("pose la première case du path sur le départ du joueur", () => {
    for (const size of SIZES) {
      const track = createTrack(size);
      track.colors.forEach((color, seat) => {
        assert.strictEqual(
          track.ringIndexOf(color, 0),
          track.offsets.get(color),
        );
        assert.strictEqual(seat, track.colors.indexOf(color));
      });
    }
  });
});

describe("Ludo — captures sur une table de taille variable", () => {
  it("capture un adversaire dont le path croise la case d'arrivée", () => {
    const track = createTrack(6);
    /*
     * Plateau hexagonal, départs à 6 joueurs : yellow 0, red 13, blue 26,
     * green 39, orange 52, purple 65. Le path 10 de yellow est l'anneau
     * 10, et la case 36 d'orange est ce même anneau 10 (52 + 36 = 88,
     * soit 10 modulo 78) — les deux paths se croisent donc là, ce
     * qu'une capture doit détecter.
     */
    assert.strictEqual(track.offsets.get("orange"), 52);
    assert.strictEqual(track.ringIndexOf("yellow", 10), 10);
    assert.strictEqual(track.ringIndexOf("orange", 36), 10);
    const captured = resolveCaptures(track, "yellow", 10, [
      { color: "orange", pieces: [{ index: 0, position: 36 }] },
    ]);
    assert.deepStrictEqual(captured, [0]);
  });

  it("ne capture jamais sur une case sûre", () => {
    const track = createTrack(6);
    // L'anneau 52 est le départ d'orange : case sûre, donc intouchable.
    assert.ok(track.isSafeCell(52));
    const captured = resolveCaptures(track, "yellow", 52, [
      { color: "orange", pieces: [{ index: 0, position: 0 }] },
    ]);
    assert.deepStrictEqual(captured, []);
  });

  it("ne touche pas un adversaire déjà dans sa colonne maison", () => {
    const track = createTrack(6);
    // orange en path 36 serait sur l'anneau 10, mais sa colonne maison
    // (77+ sur le plateau hexagonal) est privée : hors de portée.
    const captured = resolveCaptures(track, "yellow", 10, [
      { color: "orange", pieces: [{ index: 0, position: track.homeColumnStart + 2 }] },
    ]);
    assert.deepStrictEqual(captured, []);
  });

  it("ne se capture pas soi-même", () => {
    const track = createTrack(4);
    const captured = resolveCaptures(track, "yellow", 10, [
      { color: "yellow", pieces: [{ index: 0, position: 5 }] },
    ]);
    assert.deepStrictEqual(captured, []);
  });

  it("ignore les pièces encore en base", () => {
    const track = createTrack(4);
    const captured = resolveCaptures(track, "yellow", 10, [
      { color: "green", pieces: [{ index: 0, position: -1 }] },
    ]);
    assert.deepStrictEqual(captured, []);
  });
});
