import {
  clamp,
  LEVELS,
  PADDLE_RANGE,
  TABLE,
  TARGET_SCORE,
  WINNING_MARGIN,
} from "./constants.js";
import type {
  Ball,
  Difficulty,
  MatchState,
  Paddle,
  PointReason,
  RallyEvent,
  RallyOptions,
  RallySnapshot,
  Side,
} from "./types.js";

const other = (side: Side): Side => (side === 0 ? 1 : 0);

/**
 * A table tennis match.
 *
 * Owns the ball, both paddles, the score and the rules. It is stepped
 * at a fixed rate by whoever drives it and reports what happened
 * through `onEvent`, so sound and visuals can react without the engine
 * knowing they exist.
 *
 * The only input is `targetX` (where the player wants their paddle) and
 * `power` (whether they are holding the power shot). Everything else is
 * the engine's.
 */
export class RallyMatch {
  private readonly random: () => number;
  private readonly onEvent: (event: RallyEvent) => void;

  public level: Difficulty;
  public state: MatchState = "intro";

  public readonly player: Paddle = { x: 0, y: 1.52, z: TABLE.paddleZ, vx: 0 };
  public readonly cpu: Paddle = { x: 0, y: 1.52, z: -TABLE.paddleZ, vx: 0 };
  public readonly ball: Ball = {
    x: 0,
    y: 1.68,
    z: TABLE.paddleZ - 0.13,
    vx: 0,
    vy: 0,
    vz: 0,
  };

  /** Where the player is steering their paddle. */
  private targetX = 0;
  /** Whether the player is holding the power shot. */
  private power = false;

  /**
   * When true, side 1 is a second human rather than the computer: it
   * takes its aim from `opponentTarget` and returns the ball with the
   * same formula as side 0. One engine serves both modes.
   */
  private readonly opponentIsHuman: boolean;
  private opponentTarget = 0;
  private opponentPower = false;

  public scores: [number, number] = [0, 0];
  public rally = 0;
  public best = 0;
  public server: Side = 0;
  public winner: Side | null = null;

  private now = 0;
  private lastHitter: Side = 0;
  private bounces = 0;
  /** True between a serve and its own first bounce. */
  private serveOwn = false;
  private aiTarget = 0;
  private aiReady = 0;
  private nextServe = 0;
  private beforePause: MatchState = "ready";

  constructor(options: RallyOptions = {}) {
    this.random = options.random ?? Math.random;
    this.onEvent = options.onEvent ?? (() => {});
    this.level = options.level ?? "club";
    this.opponentIsHuman = options.opponentIsHuman ?? false;
  }

  private emit(event: RallyEvent) {
    this.onEvent(event);
  }

  // ------------------------------------------------------------------
  // Player input. Methods rather than public fields, so the UI drives
  // the match through a stated interface and never reaches inside it.
  // ------------------------------------------------------------------

  /** Steer the paddle to an absolute x, clamped to its range. */
  public setTarget(x: number) {
    this.targetX = clamp(x, -PADDLE_RANGE, PADDLE_RANGE);
  }

  /** Shift the aim by a step — used by the held movement keys. */
  public nudgeTarget(delta: number) {
    this.setTarget(this.targetX + delta);
  }

  public getTarget(): number {
    return this.targetX;
  }

  /** Hold for a power shot: faster, less controlled. */
  public setPower(on: boolean) {
    this.power = on;
  }

  /**
   * The player serves: the paddle snaps to where they are aiming first,
   * so the serve leaves from where they expect it to.
   */
  public playerServe() {
    if (this.state !== "ready" || this.server !== 0) return;
    this.player.x = this.targetX;
    this.serve();
  }

  // --- Side 1, when a second human is playing it ---

  public setOpponentTarget(x: number) {
    this.opponentTarget = clamp(x, -PADDLE_RANGE, PADDLE_RANGE);
  }

  public setOpponentPower(on: boolean) {
    this.opponentPower = on;
  }

  public opponentServe() {
    if (this.state !== "ready" || this.server !== 1) return;
    this.cpu.x = this.opponentTarget;
    this.serve();
  }

  /** Route an input to whichever side that player owns. */
  public setTargetFor(side: Side, x: number) {
    if (side === 0) this.setTarget(x);
    else this.setOpponentTarget(x);
  }

  public setPowerFor(side: Side, on: boolean) {
    if (side === 0) this.setPower(on);
    else this.setOpponentPower(on);
  }

  public serveFor(side: Side) {
    if (side === 0) this.playerServe();
    else this.opponentServe();
  }

  public start(level: Difficulty = this.level) {
    this.level = LEVELS[level] ? level : "club";
    this.scores = [0, 0];
    this.best = 0;
    this.rally = 0;
    this.winner = null;
    this.server = 0;
    this.cpu.x = 0;
    this.prepare();
    this.emit({ type: "start" });
  }

  /** Between points: park the ball and wait for the serve. */
  private prepare() {
    this.state = "ready";
    this.rally = 0;
    this.bounces = 0;
    this.serveOwn = false;
    this.nextServe = this.now + 1.2;
    this.parkBall();
    this.emit({ type: "ready", server: this.server });
  }

  private parkBall() {
    const server = this.server === 0 ? this.player : this.cpu;
    this.ball.x = server.x;
    this.ball.y = 1.68;
    this.ball.z = server.z - Math.sign(server.z) * 0.13;
    this.ball.vx = 0;
    this.ball.vy = 0;
    this.ball.vz = 0;
  }

  public serve() {
    if (this.state !== "ready") return;

    const side = this.server;
    const direction = side === 0 ? 1 : -1;
    const ball = this.ball;

    this.parkBall();
    this.state = "playing";

    // Aim the serve to land just past the net on the far side.
    const flight = 0.28;
    const landingZ = direction * 2.5;
    ball.vz = (landingZ - ball.z) / flight;
    ball.vy =
      (TABLE.top + TABLE.ballRadius - ball.y + 0.5 * TABLE.gravity * flight ** 2) /
      flight;

    const aimX =
      side === 0
        ? clamp(-this.player.x * 0.72, -1.7, 1.7)
        : this.opponentIsHuman
          ? clamp(-this.cpu.x * 0.72, -1.7, 1.7)
          : (this.random() * 2 - 1) * 1.7;
    const travel = (TABLE.paddleZ * 2 - 0.13) / Math.abs(ball.vz);
    ball.vx = (aimX - ball.x) / travel;

    this.lastHitter = side;
    this.bounces = 0;
    this.serveOwn = true;
    this.aiTarget = aimX + (this.random() * 2 - 1) * LEVELS[this.level].error;
    this.aiReady = this.now + LEVELS[this.level].delay;
    this.emit({ type: "serve", side });
  }

  /** Where the ball will cross a given z, used by the computer. */
  public predictX(z: number): number {
    if (Math.abs(this.ball.vz) < 0.01) return this.ball.x;
    return (
      this.ball.x +
      this.ball.vx * Math.max(0, (z - this.ball.z) / this.ball.vz)
    );
  }

  /** Send the ball back from `side`, `offset` being the contact point. */
  private returnBall(side: Side, offset: number) {
    const ball = this.ball;
    const direction = side === 0 ? 1 : -1;
    const profile = LEVELS[this.level];
    const powered =
      side === 0 ? this.power : this.opponentIsHuman && this.opponentPower;

    // Long rallies get gradually quicker; a power shot cuts the flight.
    const flight = Math.max(
      0.72,
      profile.flight - Math.min(this.rally, 18) * 0.008 - (powered ? 0.14 : 0),
    );
    const landingZ = -direction * 2.65;

    ball.vz = (landingZ - ball.z) / flight;
    ball.vy =
      (TABLE.top + TABLE.ballRadius - ball.y + 0.5 * TABLE.gravity * flight ** 2) /
      flight;

    let aimX: number;
    if (side === 0 || this.opponentIsHuman) {
      // A human's aim follows the contact point and their paddle sweep.
      const paddle = side === 0 ? this.player : this.cpu;
      aimX = clamp(
        -paddle.x * 0.75 + offset * 3.6 + clamp(paddle.vx, -8, 8) * 0.12,
        -2.15,
        2.15,
      );
    } else {
      // The computer mostly plays away from where the player stands.
      const away = this.player.x >= 0 ? -1 : 1;
      const side_ = this.random() < 0.76 ? away : -away;
      aimX = clamp(side_ * (0.6 + this.random() * 1.5), -2.1, 2.1);
    }

    const travel = (TABLE.paddleZ * 2) / Math.abs(ball.vz);
    ball.vx = (aimX - ball.x) / travel;

    this.lastHitter = side;
    this.bounces = 0;
    this.serveOwn = false;
    this.rally += 1;
    this.best = Math.max(this.best, this.rally);
    this.aiTarget = aimX + (this.random() * 2 - 1) * profile.error;

    // Sometimes the computer reads the shot wrong and leans the wrong
    // way. Only the computer does — a human is never nudged.
    const misreadChance =
      profile.misread + (powered ? 0.065 : 0) + Math.abs(offset) * 0.07;
    if (side === 0 && !this.opponentIsHuman && this.random() < misreadChance) {
      const wrongWay = aimX > 0 ? -1 : 1;
      this.aiTarget += wrongWay * (0.82 + this.random() * 0.5);
    }

    this.aiReady = this.now + profile.delay;
    this.emit({
      type: "hit",
      side,
      powered,
      x: ball.x,
      y: ball.y,
      z: ball.z,
    });
  }

  /** Give the point to `side`. */
  private award(side: Side, reason: PointReason) {
    if (this.state !== "playing") return;

    this.scores[side] += 1;
    this.best = Math.max(this.best, this.rally);

    const matchOver =
      this.scores[side] >= TARGET_SCORE &&
      this.scores[side] - this.scores[other(side)] >= WINNING_MARGIN;

    this.state = matchOver ? "over" : "point";
    this.winner = matchOver ? side : null;
    this.nextServe = this.now + 1.45;
    this.ball.vx *= 0.25;
    this.ball.vz *= 0.25;

    // Service changes every two points, then every point past 20.
    const played = this.scores[0] + this.scores[1];
    this.server = (played >= 20 ? played % 2 : Math.floor(played / 2) % 2) as Side;

    this.emit({ type: "point", side, reason, matchOver });
  }

  public togglePause() {
    if (this.state === "intro" || this.state === "over") return;
    if (this.state === "paused") {
      this.state = this.beforePause;
      this.emit({ type: "resume" });
      return;
    }
    this.beforePause = this.state;
    this.state = "paused";
    this.emit({ type: "pause" });
  }

  /** Advance the world by `dt` seconds. */
  public step(dt: number) {
    if (this.state === "paused") return;
    this.now += dt;

    const { player, cpu, ball } = this;

    // Player paddle chases the pointer, at a capped speed.
    const previousPlayerX = player.x;
    player.x += clamp(this.targetX - player.x, -13 * dt, 13 * dt);
    player.vx = (player.x - previousPlayerX) / dt;

    const profile = LEVELS[this.level];
    const previousCpuX = cpu.x;

    if (this.opponentIsHuman) {
      // A second human: same responsiveness as side 0, no AI at all.
      cpu.x += clamp(this.opponentTarget - cpu.x, -13 * dt, 13 * dt);
    } else {
      // Computer paddle moves towards where it believes the ball will be.
      const cpuGoal =
        this.state === "playing" && ball.vz < 0 && this.now >= this.aiReady
          ? clamp(this.aiTarget, -2.7, 2.7)
          : this.state === "ready" && this.server === 1
            ? 0
            : cpu.x * 0.996;
      cpu.x += clamp(cpuGoal - cpu.x, -profile.speed * dt, profile.speed * dt);
    }
    cpu.vx = (cpu.x - previousCpuX) / dt;

    // Paddles rise to meet a ball coming at them.
    const ease = Math.min(dt * 16, 1);
    player.y +=
      ((ball.vz > 0 && ball.z > 2 ? clamp(ball.y, 1.13, 1.9) : 1.5) - player.y) *
      ease;
    cpu.y +=
      ((ball.vz < 0 && ball.z < -2 ? clamp(ball.y, 1.13, 1.9) : 1.5) - cpu.y) *
      ease;

    if (this.state === "intro" || this.state === "ready") {
      this.parkBall();
      // The computer serves itself once the pause is over; a human
      // opponent serves when they choose to.
      if (
        this.state === "ready" &&
        this.server === 1 &&
        !this.opponentIsHuman &&
        this.now >= this.nextServe
      ) {
        this.serve();
      }
      return;
    }

    if (this.state === "point") {
      if (this.now >= this.nextServe) this.prepare();
      return;
    }

    if (this.state !== "playing") return;

    const from = { x: ball.x, y: ball.y, z: ball.z };

    ball.x += ball.vx * dt;
    ball.z += ball.vz * dt;
    ball.y += ball.vy * dt - 0.5 * TABLE.gravity * dt * dt;
    ball.vy -= TABLE.gravity * dt;

    // Crossing the net plane: does it clear the net?
    if (from.z * ball.z <= 0 && Math.abs(from.z - ball.z) > 1e-5) {
      const t = Math.abs(from.z / (ball.z - from.z));
      const crossY = from.y + (ball.y - from.y) * t;
      const crossX = from.x + (ball.x - from.x) * t;
      if (
        Math.abs(crossX) <= TABLE.halfWidth + 0.13 &&
        crossY - TABLE.ballRadius <= TABLE.top + TABLE.netHeight
      ) {
        this.award(other(this.lastHitter), "Into the net");
        this.emit({ type: "net" });
        return;
      }
    }

    // Landing on the table.
    const surface = TABLE.top + TABLE.ballRadius;
    if (from.y >= surface && ball.y < surface && ball.vy < 0) {
      const t = (from.y - surface) / Math.max(from.y - ball.y, 1e-8);
      const hitX = from.x + (ball.x - from.x) * t;
      const hitZ = from.z + (ball.z - from.z) * t;

      if (Math.abs(hitX) <= TABLE.halfWidth && Math.abs(hitZ) <= TABLE.halfLength) {
        const half: Side = hitZ >= 0 ? 0 : 1;

        if (this.serveOwn) {
          // A serve must bounce on the server's own half first.
          if (half !== this.lastHitter) {
            this.award(other(this.lastHitter), "Service fault");
            return;
          }
          this.serveOwn = false;
        } else {
          if (half === this.lastHitter) {
            this.award(other(this.lastHitter), "Wrong-side bounce");
            return;
          }
          this.bounces += 1;
          if (this.bounces > 1) {
            this.award(this.lastHitter, "Double bounce");
            return;
          }
        }

        ball.y = surface + (surface - ball.y) * TABLE.restitution;
        ball.vy = Math.abs(ball.vy) * TABLE.restitution;
        this.emit({ type: "bounce", x: hitX, y: TABLE.top + 0.007, z: hitZ });
      } else {
        this.award(
          this.bounces > 0 ? this.lastHitter : other(this.lastHitter),
          "Out of play",
        );
        return;
      }
    }

    // Reaching a paddle.
    const receiver: Side = ball.vz > 0 ? 0 : 1;
    const paddle = receiver === 0 ? player : cpu;
    const crossedPaddle =
      ball.vz > 0
        ? from.z <= paddle.z && ball.z >= paddle.z
        : from.z >= paddle.z && ball.z <= paddle.z;

    if (crossedPaddle && receiver !== this.lastHitter) {
      const t = clamp((paddle.z - from.z) / (ball.z - from.z), 0, 1);
      const contactX = from.x + (ball.x - from.x) * t;
      const contactY = from.y + (ball.y - from.y) * t;
      const offset = contactX - paddle.x;
      // The player's paddle is forgiving by a few centimetres.
      const reach =
        TABLE.paddleRadius + TABLE.ballRadius + (receiver === 0 ? 0.07 : 0);

      if (this.bounces === 0) {
        this.award(receiver, "Shot went long");
        return;
      }

      if (Math.abs(offset) <= reach && Math.abs(contactY - paddle.y) <= 0.85) {
        ball.x = contactX;
        ball.y = clamp(contactY, 1.1, 2);
        ball.z = paddle.z;
        this.returnBall(receiver, offset);
      } else {
        this.award(this.lastHitter, "Clean winner");
      }
    }

    // Gone entirely.
    if (
      this.state === "playing" &&
      (Math.abs(ball.z) > 5.4 || ball.y < -0.5 || Math.abs(ball.x) > 4.5)
    ) {
      this.award(
        this.bounces > 0 ? this.lastHitter : other(this.lastHitter),
        "Out of play",
      );
    }
  }

  /** A plain copy of what the renderer needs. */
  public snapshot(): RallySnapshot {
    return {
      state: this.state,
      player: { ...this.player },
      cpu: { ...this.cpu },
      ball: { ...this.ball },
      scores: [this.scores[0], this.scores[1]],
      rally: this.rally,
      best: this.best,
      server: this.server,
      winner: this.winner,
    };
  }
}
