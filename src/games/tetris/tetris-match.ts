import {
  FALL_DELAYS_MS,
  applyInput,
  createGame,
  type PieceType,
  type TetrisInput,
  type TetrisState,
} from "./engine/index.js";

/**
 * Règles d'un match de Tetris à plusieurs — module PUR : aucun import
 * Colyseus, donc testable seul (comme `ludo-rules.ts` et `checkers/engine`).
 *
 * Le principe : chaque joueur a SON plateau, tous partent de la même graine
 * (donc de la même suite de pièces), la gravité est celle du serveur, et le
 * dernier joueur encore en vie gagne. La room Colyseus ne fait que relier
 * ce module au réseau : elle lui passe les intentions reçues et recopie ses
 * vues dans l'état synchronisé.
 */

/** Les seules intentions qu'un CLIENT peut envoyer. `tick` est réservé au serveur. */
export const CLIENT_INPUTS = [
  "left",
  "right",
  "rotate",
  "softDrop",
  "hardDrop",
] as const satisfies readonly TetrisInput[];

export type ClientInput = (typeof CLIENT_INPUTS)[number];

export function isClientInput(value: unknown): value is ClientInput {
  return (CLIENT_INPUTS as readonly unknown[]).includes(value);
}

/**
 * Anti-saturation : un doigt qui maintient une flèche envoie ~20 intentions
 * par seconde (la console répète toutes les 50 ms). Au-delà de ce quota par
 * fenêtre, le serveur ignore le surplus au lieu de calculer à l'infini.
 */
export const INPUT_WINDOW_MS = 500;
export const MAX_INPUTS_PER_WINDOW = 30;

/** Nombre de pièces à venir exposées aux clients. */
export const NEXT_PREVIEW = 3;

/** Ce que la room copie dans l'état synchronisé, pour un joueur. */
export interface PlayerView {
  /** 200 caractères « 0 »..« 7 », ligne du haut en premier. */
  board: string;
  pieceType: PieceType | "";
  pieceRotation: number;
  pieceX: number;
  pieceY: number;
  /** Les prochaines pièces, ex. « TLJ ». */
  next: string;
  score: number;
  lines: number;
  level: number;
  /** « playing » tant qu'il est en vie, « over » une fois éliminé. */
  status: "playing" | "over";
  /** 0 tant qu'il joue, puis son classement final (1 = vainqueur). */
  place: number;
}

export type MatchEvent =
  | { type: "eliminated"; userId: string; place: number }
  | { type: "finished"; winnerUserId: string };

interface PlayerSlot {
  userId: string;
  game: TetrisState;
  /** Instant (ms) où la gravité fera tomber la pièce d'une case. */
  nextFallAt: number;
  place: number;
  windowStart: number;
  windowCount: number;
}

export interface TetrisMatchOptions {
  /** Joueurs assis, DANS L'ORDRE des sièges. */
  userIds: readonly string[];
  /** Même graine pour tous : même suite de pièces, partie équitable. */
  seed: number;
  /** Horloge de départ, en ms. */
  now: number;
}

function fallDelay(level: number): number {
  const index = Math.min(Math.max(level, 1), FALL_DELAYS_MS.length) - 1;
  return FALL_DELAYS_MS[index];
}

export class TetrisMatch {
  private readonly slots = new Map<string, PlayerSlot>();
  private readonly dirty = new Set<string>();
  private events: MatchEvent[] = [];
  private winner = "";
  private over = false;

  constructor(options: TetrisMatchOptions) {
    for (const userId of options.userIds) {
      const game = createGame(options.seed, 1);
      this.slots.set(userId, {
        userId,
        game,
        nextFallAt: options.now + fallDelay(game.level),
        place: 0,
        windowStart: options.now,
        windowCount: 0,
      });
      this.dirty.add(userId);
    }
  }

  get finished(): boolean {
    return this.over;
  }

  /** « » en cas d'égalité parfaite ou tant que le match n'est pas terminé. */
  get winnerUserId(): string {
    return this.winner;
  }

  get aliveCount(): number {
    let alive = 0;
    for (const slot of this.slots.values()) {
      if (slot.game.status === "playing") alive++;
    }
    return alive;
  }

  has(userId: string): boolean {
    return this.slots.has(userId);
  }

  /**
   * Une intention d'un joueur. Tout ce qui n'est pas une intention connue,
   * ou qui dépasse le quota, est ignoré sans effet : le client ne peut ni
   * forcer la gravité, ni jouer pour un autre, ni saturer le serveur.
   */
  handleInput(userId: string, input: unknown, now: number): boolean {
    if (this.over) return false;
    const slot = this.slots.get(userId);
    if (!slot || slot.game.status !== "playing") return false;
    if (!isClientInput(input)) return false;
    if (!this.withinQuota(slot, now)) return false;

    const before = slot.game;
    const after = applyInput(before, input);
    // Le moteur renvoie le MÊME objet quand l'intention est illégale.
    if (after === before) return false;

    slot.game = after;
    // Une descente volontaire repart d'un délai complet ; sinon la gravité
    // ferait tomber la pièce une 2e fois juste après un « bas » ou un largage.
    if (input === "softDrop" || input === "hardDrop") {
      slot.nextFallAt = now + fallDelay(after.level);
    }
    this.dirty.add(userId);
    this.settle();
    return true;
  }

  /** Fait avancer la gravité de tous les joueurs encore en vie. */
  advance(now: number): void {
    if (this.over) return;
    for (const slot of this.slots.values()) {
      if (slot.game.status !== "playing" || now < slot.nextFallAt) continue;
      // Un seul pas par appel : après une longue pause on ne « rattrape » pas
      // des dizaines de chutes d'un coup.
      slot.game = applyInput(slot.game, "tick");
      slot.nextFallAt = now + fallDelay(slot.game.level);
      this.dirty.add(slot.userId);
    }
    this.settle();
  }

  /**
   * Un joueur quitte volontairement en cours de match : il est éliminé comme
   * s'il avait perdu, puis le match se résout normalement.
   */
  forfeit(userId: string): void {
    if (this.over) return;
    const slot = this.slots.get(userId);
    if (!slot || slot.game.status !== "playing") return;
    slot.game = { ...slot.game, status: "over" };
    this.dirty.add(userId);
    this.settle();
  }

  view(userId: string): PlayerView | undefined {
    const slot = this.slots.get(userId);
    if (!slot) return undefined;
    const { game } = slot;
    return {
      board: game.board.map((row) => row.join("")).join(""),
      pieceType: game.current.type,
      pieceRotation: game.current.rotation,
      pieceX: game.current.x,
      pieceY: game.current.y,
      next: game.queue.slice(0, NEXT_PREVIEW).join(""),
      score: game.score,
      lines: game.lines,
      level: game.level,
      status: game.status,
      place: slot.place,
    };
  }

  /** Joueurs dont la vue a changé depuis le dernier appel (puis vide la liste). */
  takeDirty(): string[] {
    const ids = [...this.dirty];
    this.dirty.clear();
    return ids;
  }

  /** Événements à diffuser (éliminations, fin de match), puis vide la liste. */
  takeEvents(): MatchEvent[] {
    const events = this.events;
    this.events = [];
    return events;
  }

  private withinQuota(slot: PlayerSlot, now: number): boolean {
    if (now - slot.windowStart >= INPUT_WINDOW_MS) {
      slot.windowStart = now;
      slot.windowCount = 0;
    }
    if (slot.windowCount >= MAX_INPUTS_PER_WINDOW) return false;
    slot.windowCount++;
    return true;
  }

  /**
   * Classe les joueurs qui viennent d'être éliminés et termine le match s'il
   * ne reste plus qu'un joueur (ou personne).
   *
   * Exemple à 4 joueurs : si deux piles atteignent le haut au même instant,
   * celui qui a le moins de points est classé 4e et l'autre 3e — le classement
   * ne dépend donc pas de l'ordre dans lequel la boucle les a rencontrés.
   */
  private settle(): void {
    const fresh: PlayerSlot[] = [];
    let alive = 0;
    for (const slot of this.slots.values()) {
      if (slot.game.status === "playing") alive++;
      else if (slot.place === 0) fresh.push(slot);
    }
    if (fresh.length === 0) return;

    // Du moins bon au meilleur ; à score égal, le siège le plus tardif sort en premier.
    const order = [...this.slots.keys()];
    fresh.sort(
      (a, b) =>
        a.game.score - b.game.score ||
        order.indexOf(b.userId) - order.indexOf(a.userId),
    );

    const remaining = alive + fresh.length;
    fresh.forEach((slot, index) => {
      slot.place = remaining - index;
      this.events.push({ type: "eliminated", userId: slot.userId, place: slot.place });
    });

    if (alive > 1) return;

    this.over = true;
    if (alive === 1) {
      const survivor = [...this.slots.values()].find(
        (slot) => slot.game.status === "playing",
      )!;
      survivor.place = 1;
      this.dirty.add(survivor.userId);
      this.winner = survivor.userId;
    } else {
      // Tout le monde est tombé en même temps : le meilleur score gagne,
      // et deux meilleurs scores identiques font match nul.
      const best = fresh[fresh.length - 1];
      const runnerUp = fresh[fresh.length - 2];
      const tie = runnerUp !== undefined && runnerUp.game.score === best.game.score;
      this.winner = tie ? "" : best.userId;
    }
    this.events.push({ type: "finished", winnerUserId: this.winner });
    for (const slot of fresh) this.dirty.add(slot.userId);
  }
}
