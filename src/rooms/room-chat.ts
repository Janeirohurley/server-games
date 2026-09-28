/**
 * Ephemeral per-room chat.
 *
 * One instance per Colyseus room, owned by BaseGameRoom. Messages live
 * in this object and nowhere else: no database, no cache, no file. When
 * the room is disposed the buffer is dropped and the messages are gone,
 * which is the intended behaviour — a room chat is not a message
 * history.
 *
 * The class is deliberately free of Colyseus types so it can be unit
 * tested on its own and reused by any room that has participants.
 */

/** A message as the server created it. Clients never author these fields. */
export interface RoomChatMessage {
  id: string;
  /** Room-local, monotonically increasing. The client renders by this. */
  sequence: number;
  userId: string;
  username: string;
  content: string;
  createdAt: number;
}

/** The only thing a client is allowed to send. */
export interface RoomChatRequest {
  content?: unknown;
}

export type ChatRejectionReason =
  | "invalid"
  | "empty"
  | "too-long"
  | "rate-limited";

/**
 * A string discriminant rather than a boolean: this project compiles
 * with `strictNullChecks: false`, where narrowing on a boolean literal
 * is unreliable.
 */
export type ChatResult =
  | { status: "accepted"; message: RoomChatMessage }
  | { status: "rejected"; reason: ChatRejectionReason };

/** Sender identity, taken from the room's own participant record. */
export interface ChatSender {
  userId: string;
  username: string;
}

/** Messages a room keeps. Older ones fall off the front. */
export const MAX_CHAT_MESSAGES = 100;

export const MIN_CONTENT_LENGTH = 1;
export const MAX_CONTENT_LENGTH = 300;

/** Sliding window: at most this many messages per user per window. */
export const RATE_LIMIT_MESSAGES = 5;
export const RATE_LIMIT_WINDOW_MS = 3_000;

/**
 * Typing indicator: a participant who stops sending `chatTyping` for
 * this long is dropped from the set by the next prune. Clients refresh
 * well before the deadline (2s), so the state naturally flickers off.
 */
export const TYPING_TTL_MS = 6_000;

/** Someone currently typing, as broadcast to the room. */
export interface TypingParticipant {
  userId: string;
  name: string;
  /** Server timestamp of the last signal — clients may sort with it. */
  at: number;
}

const CONTROL_CHARACTERS = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g;
const WHITESPACE_RUNS = /\s+/g;

/**
 * Normalize raw client input into something safe to broadcast.
 *
 * Control characters are dropped and whitespace runs (newlines
 * included) collapse to single spaces, so a message cannot smuggle
 * layout or blow up the panel. Rendering stays the client's job — the
 * React side never injects HTML.
 */
function normalizeContent(raw: string): string {
  return raw.replace(CONTROL_CHARACTERS, "").replace(WHITESPACE_RUNS, " ").trim();
}

export class RoomChat {
  private buffer: RoomChatMessage[] = [];
  private sequence = 0;
  /** userId → timestamps of recent accepted messages, for the rate limit. */
  private recent = new Map<string, number[]>();
  /** userId → { name, last signal }, for the typing indicator. */
  private typing = new Map<string, { name: string; at: number }>();

  /**
   * Record (or refresh) a typing signal. The identity comes from the
   * room's participant record, never from the payload. Returns the
   * current typing set so the caller can broadcast a diff.
   */
  public setTyping(
    sender: ChatSender,
    isTyping: boolean,
    now: number = Date.now(),
  ): TypingParticipant[] {
    this.pruneTypingSet(now);
    if (isTyping) {
      this.typing.set(sender.userId, { name: sender.username, at: now });
    } else {
      this.typing.delete(sender.userId);
    }
    return this.typingUsers();
  }

  /**
   * Drop every typing entry older than the TTL, then return the set.
   * Pruning on read keeps the state fresh without any timer at all: a
   * room nobody types in costs nothing.
   */
  public pruneTyping(now: number = Date.now()): TypingParticipant[] {
    this.pruneTypingSet(now);
    return this.typingUsers();
  }

  /** A departed participant must never linger in the indicator. */
  public stopTyping(
    userId: string,
    now: number = Date.now(),
  ): TypingParticipant[] {
    this.pruneTypingSet(now);
    this.typing.delete(userId);
    return this.typingUsers();
  }

  /**
   * Validate a client request and, if it passes, create the
   * authoritative message and retain it.
   *
   * The caller supplies `sender` from the room's participant record —
   * never from the payload — so a client cannot claim another identity.
   */
  public submit(
    sender: ChatSender,
    request: RoomChatRequest,
    now: number = Date.now(),
  ): ChatResult {
    if (typeof request?.content !== "string") {
      return { status: "rejected", reason: "invalid" };
    }

    const content = normalizeContent(request.content);

    if (content.length < MIN_CONTENT_LENGTH) {
      return { status: "rejected", reason: "empty" };
    }
    if (content.length > MAX_CONTENT_LENGTH) {
      return { status: "rejected", reason: "too-long" };
    }
    if (this.isRateLimited(sender.userId, now)) {
      return { status: "rejected", reason: "rate-limited" };
    }

    this.remember(sender.userId, now);
    this.sequence += 1;

    // Sending ends the typing state — a signal the client would keep
    // refreshing otherwise.
    this.typing.delete(sender.userId);

    const message: RoomChatMessage = {
      id: createMessageId(),
      sequence: this.sequence,
      userId: sender.userId,
      username: sender.username,
      content,
      createdAt: now,
    };

    this.buffer.push(message);
    if (this.buffer.length > MAX_CHAT_MESSAGES) {
      this.buffer.splice(0, this.buffer.length - MAX_CHAT_MESSAGES);
    }

    return { status: "accepted", message };
  }

  /** The bounded buffer, handed to a client that just joined. */
  public snapshot(): RoomChatMessage[] {
    return this.buffer.map((message) => ({ ...message }));
  }

  public get size(): number {
    return this.buffer.length;
  }

  /** Drop everything so the messages can be collected. */
  public dispose(): void {
    this.buffer = [];
    this.recent.clear();
    this.typing.clear();
  }

  /** Pure projection of the typing map — callers prune before reading. */
  private typingUsers(): TypingParticipant[] {
    return [...this.typing.entries()]
      .map(([userId, entry]) => ({ userId, name: entry.name, at: entry.at }))
      .sort((a, b) => a.at - b.at);
  }

  private pruneTypingSet(now: number): void {
    for (const [userId, entry] of this.typing) {
      if (now - entry.at >= TYPING_TTL_MS) this.typing.delete(userId);
    }
  }

  private isRateLimited(userId: string, now: number): boolean {
    const window = this.recent.get(userId);
    if (!window) return false;
    const fresh = window.filter((at) => now - at < RATE_LIMIT_WINDOW_MS);
    if (fresh.length === 0) {
      this.recent.delete(userId);
      return false;
    }
    this.recent.set(userId, fresh);
    return fresh.length >= RATE_LIMIT_MESSAGES;
  }

  private remember(userId: string, now: number): void {
    const window = this.recent.get(userId) ?? [];
    window.push(now);
    this.recent.set(userId, window);
  }
}

function createMessageId(): string {
  const generator = globalThis.crypto;
  if (generator && typeof generator.randomUUID === "function") {
    return generator.randomUUID();
  }
  // Only reached on a runtime without WebCrypto; ids stay room-local.
  return `msg_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}
