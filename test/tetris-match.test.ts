import assert from "node:assert/strict";

import {
  INPUT_WINDOW_MS,
  MAX_INPUTS_PER_WINDOW,
  TetrisMatch,
} from "../src/games/tetris/tetris-match.js";

const SEED = 20260412;

/** Un match avec les joueurs donnés, sur une horloge qui démarre à 0. */
function startMatch(userIds: string[], seed = SEED) {
  return new TetrisMatch({ userIds, seed, now: 0 });
}

/**
 * Largue des pièces pour `userId` jusqu'à ce que sa pile atteigne le haut.
 * Chaque intention est espacée d'une fenêtre entière : le quota anti-saturation
 * ne doit pas fausser ce test. Renvoie l'instant suivant.
 */
function topOut(match: TetrisMatch, userId: string, from: number): number {
  let now = from;
  for (let i = 0; i < 60 && match.view(userId)?.status === "playing"; i++) {
    now += INPUT_WINDOW_MS;
    match.handleInput(userId, "hardDrop", now);
  }
  assert.equal(match.view(userId)?.status, "over", "la pile doit finir par monter");
  return now;
}

describe("TetrisMatch — départ", () => {
  it("donne à chaque joueur la même suite de pièces et un plateau vide", () => {
    const match = startMatch(["a", "b", "c"]);
    const a = match.view("a")!;

    for (const id of ["b", "c"]) {
      assert.deepEqual(match.view(id), a, `${id} doit commencer comme a`);
    }
    assert.equal(a.board, "0".repeat(200));
    assert.equal(a.status, "playing");
    assert.equal(a.next.length, 3);
    assert.equal(match.aliveCount, 3);
    assert.equal(match.finished, false);
  });

  it("n'expose aucune vue pour un joueur inconnu", () => {
    assert.equal(startMatch(["a", "b"]).view("zoe"), undefined);
  });

  it("annonce tous les joueurs comme à synchroniser au départ", () => {
    const match = startMatch(["a", "b"]);
    assert.deepEqual(match.takeDirty().sort(), ["a", "b"]);
    assert.deepEqual(match.takeDirty(), [], "la liste se vide après lecture");
  });
});

describe("TetrisMatch — intentions", () => {
  it("ne déplace que la pièce de l'expéditeur", () => {
    const match = startMatch(["a", "b"]);
    match.takeDirty();
    const before = match.view("a")!;

    assert.equal(match.handleInput("a", "left", 10), true);

    assert.equal(match.view("a")!.pieceX, before.pieceX - 1);
    assert.equal(match.view("b")!.pieceX, before.pieceX, "b ne bouge pas");
    assert.deepEqual(match.takeDirty(), ["a"]);
  });

  it("ignore tout ce qui n'est pas une intention de client", () => {
    const match = startMatch(["a", "b"]);
    const before = match.view("a");

    // « tick » est la gravité : un client ne peut pas la forcer.
    for (const junk of ["tick", "LEFT", "", 42, null, undefined, {}, ["left"]]) {
      assert.equal(match.handleInput("a", junk, 10), false, String(junk));
    }
    assert.deepEqual(match.view("a"), before);
  });

  it("ignore un joueur qui n'est pas dans le match", () => {
    const match = startMatch(["a", "b"]);
    assert.equal(match.handleInput("intrus", "left", 10), false);
  });

  it("ignore une intention illégale (contre le mur)", () => {
    const match = startMatch(["a", "b"]);
    let moved = 0;
    for (let i = 0; i < 15; i++) {
      if (match.handleInput("a", "left", 10 + i * INPUT_WINDOW_MS)) moved++;
    }
    assert.ok(moved > 0 && moved < 15, `la pièce s'arrête au mur, ${moved} pas`);
    assert.equal(match.view("a")!.pieceX >= -1, true);
  });

  it("limite le nombre d'intentions par fenêtre, puis repart", () => {
    const match = startMatch(["a", "b"]);
    let accepted = 0;
    for (let i = 0; i < MAX_INPUTS_PER_WINDOW + 10; i++) {
      // Gauche / droite en alternance : toujours légal, donc seul le quota freine.
      if (match.handleInput("a", i % 2 === 0 ? "left" : "right", 5)) accepted++;
    }
    assert.equal(accepted, MAX_INPUTS_PER_WINDOW);

    assert.equal(
      match.handleInput("a", "left", 5 + INPUT_WINDOW_MS),
      true,
      "une nouvelle fenêtre rouvre le quota",
    );
  });

  it("fige la pièce au largage et marque les points de pose", () => {
    const match = startMatch(["a", "b"]);
    assert.equal(match.handleInput("a", "hardDrop", 10), true);

    const view = match.view("a")!;
    assert.equal(view.board.length, 200);
    assert.notEqual(view.board, "0".repeat(200), "la pièce est posée sur le plateau");
    assert.equal(view.score, 10, "+10 par pièce posée au niveau 1");
    assert.equal(match.view("b")!.score, 0);
  });
});

describe("TetrisMatch — gravité", () => {
  it("ne fait rien avant le délai du niveau 1 (800 ms)", () => {
    const match = startMatch(["a", "b"]);
    const y = match.view("a")!.pieceY;
    match.takeDirty();

    match.advance(799);
    assert.equal(match.view("a")!.pieceY, y);
    assert.deepEqual(match.takeDirty(), []);
  });

  it("fait tomber la pièce de tout le monde d'une case à 800 ms", () => {
    const match = startMatch(["a", "b"]);
    const y = match.view("a")!.pieceY;

    match.advance(800);

    assert.equal(match.view("a")!.pieceY, y + 1);
    assert.equal(match.view("b")!.pieceY, y + 1);
  });

  it("ne rattrape pas une longue pause en plusieurs chutes d'un coup", () => {
    const match = startMatch(["a", "b"]);
    const y = match.view("a")!.pieceY;

    match.advance(60_000);

    assert.equal(match.view("a")!.pieceY, y + 1, "un seul pas par appel");
  });

  it("repart d'un délai complet après une descente volontaire", () => {
    const match = startMatch(["a", "b"]);
    const y = match.view("a")!.pieceY;

    match.handleInput("a", "softDrop", 700); // a descend à 700 ms
    match.advance(800); //                       la gravité de a ne doit PAS tomber

    assert.equal(match.view("a")!.pieceY, y + 1, "a n'est descendu qu'une fois");
    assert.equal(match.view("b")!.pieceY, y + 1, "b a eu sa gravité normale");

    match.advance(1_500); // 700 + 800 : maintenant oui
    assert.equal(match.view("a")!.pieceY, y + 2);
  });
});

describe("TetrisMatch — éliminations et vainqueur", () => {
  it("désigne le dernier joueur en vie à deux joueurs", () => {
    const match = startMatch(["a", "b"]);
    match.takeEvents();

    topOut(match, "b", 0);

    assert.equal(match.finished, true);
    assert.equal(match.winnerUserId, "a");
    assert.equal(match.view("b")!.place, 2);
    assert.equal(match.view("a")!.place, 1);
    assert.deepEqual(match.takeEvents(), [
      { type: "eliminated", userId: "b", place: 2 },
      { type: "finished", winnerUserId: "a" },
    ]);
  });

  it("classe 3e, 2e puis 1er à trois joueurs, et ne termine qu'au dernier", () => {
    const match = startMatch(["a", "b", "c"]);
    match.takeEvents();

    const t1 = topOut(match, "c", 0);
    assert.equal(match.finished, false, "il reste deux joueurs");
    assert.equal(match.aliveCount, 2);
    assert.deepEqual(match.takeEvents(), [
      { type: "eliminated", userId: "c", place: 3 },
    ]);

    topOut(match, "b", t1);
    assert.equal(match.finished, true);
    assert.equal(match.winnerUserId, "a");
    assert.equal(match.view("b")!.place, 2);
    assert.equal(match.view("c")!.place, 3);
    assert.equal(match.view("a")!.place, 1);
  });

  it("ignore toute intention une fois le match terminé", () => {
    const match = startMatch(["a", "b"]);
    topOut(match, "b", 0);
    const before = match.view("a");

    assert.equal(match.handleInput("a", "left", 99_999), false);
    match.advance(999_999);
    assert.deepEqual(match.view("a"), before);
  });

  it("ignore les intentions d'un joueur déjà éliminé", () => {
    const match = startMatch(["a", "b", "c"]);
    topOut(match, "c", 0);
    assert.equal(match.handleInput("c", "left", 99_999), false);
  });

  it("fait perdre un joueur qui abandonne, au profit de l'autre", () => {
    const match = startMatch(["a", "b"]);
    match.takeEvents();

    match.forfeit("b");

    assert.equal(match.finished, true);
    assert.equal(match.winnerUserId, "a");
    assert.equal(match.view("b")!.status, "over");
    assert.equal(match.view("b")!.place, 2);
  });

  it("ignore l'abandon d'un inconnu ou d'un joueur déjà éliminé", () => {
    const match = startMatch(["a", "b", "c"]);
    match.forfeit("zoe");
    topOut(match, "c", 0);
    match.takeEvents();
    match.forfeit("c");
    assert.deepEqual(match.takeEvents(), []);
    assert.equal(match.finished, false);
  });

  it("fait match nul quand deux joueurs tombent au même instant avec le même score", () => {
    // Même graine, mêmes gestes : les deux piles sont identiques à tout instant.
    // On compte d'abord combien de largages une pile seule supporte.
    const probe = startMatch(["solo", "ghost"]);
    let drops = 0;
    for (let i = 0; i < 60 && probe.view("solo")!.status === "playing"; i++) {
      probe.handleInput("solo", "hardDrop", (i + 1) * INPUT_WINDOW_MS);
      drops++;
    }
    assert.ok(drops > 2, `la pile tient plusieurs largages, ${drops}`);

    // On en fait un de moins aux deux : ils sont en vie, au bord du vide.
    const match = startMatch(["a", "b"]);
    for (let i = 0; i < drops - 1; i++) {
      const now = (i + 1) * INPUT_WINDOW_MS;
      match.handleInput("a", "hardDrop", now);
      match.handleInput("b", "hardDrop", now);
    }
    assert.equal(match.aliveCount, 2, "les deux sont encore en vie");
    match.takeEvents();

    // La gravité les fait tomber dans le MÊME appel.
    let now = drops * INPUT_WINDOW_MS;
    for (let i = 0; i < 40 && !match.finished; i++) {
      now += 1_000;
      match.advance(now);
    }

    assert.equal(match.finished, true);
    assert.equal(match.winnerUserId, "", "scores identiques : match nul");
    const events = match.takeEvents();
    assert.equal(events.filter((e) => e.type === "eliminated").length, 2);
    assert.deepEqual(events[events.length - 1], { type: "finished", winnerUserId: "" });
  });
});
