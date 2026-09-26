import assert from "assert";
import { JWT } from "@colyseus/auth";

import { getTestServer, type TestServer } from "./test-server.js";
import type { CheckersRoom } from "../src/games/checkers/checkers-room.js";
import type { LudoRoom } from "../src/games/ludo/ludo-room.js";
import {
  MAX_CONTENT_LENGTH,
  RATE_LIMIT_MESSAGES,
  type RoomChatMessage,
} from "../src/rooms/room-chat.js";

process.env.REALTIME_TOKEN_SECRET =
  "test-secret-for-the-realtime-suite-0123456789";

const SECRET = process.env.REALTIME_TOKEN_SECRET;
const ISSUER = "game-platform";

async function mintToken(userId: string, name: string): Promise<string> {
  JWT.settings.secret = SECRET;
  return JWT.sign({ sub: userId, name, iss: ISSUER }, { expiresIn: "1h" });
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 60));

/** Collects everything a client receives on a given message type. */
function collect<T>(
  client: { onMessage: (type: string, handler: (payload: T) => void) => void },
  type: string,
): T[] {
  const received: T[] = [];
  client.onMessage(type, (payload) => received.push(payload));
  return received;
}

describe("room chat over Colyseus", () => {
  let colyseus: TestServer;

  before(async () => (colyseus = await getTestServer()));
  beforeEach(async () => {
    await colyseus.cleanup();
  });

  async function seatCheckers(roomLabel = "checkers") {
    const room = (await colyseus.createRoom(roomLabel, {
      targetPlayers: 2,
    })) as CheckersRoom;
    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });

    // Every seat beyond the creator's requires admin approval.
    alice.send("approveJoin", { userId: "user-b" });
    await tick();

    return { room, alice, bob };
  }

  it("delivers a message to every client in the room, sender included", async () => {
    const { alice, bob } = await seatCheckers();
    const toAlice = collect<RoomChatMessage>(alice, "chatMessage");
    const toBob = collect<RoomChatMessage>(bob, "chatMessage");

    alice.send("chatMessage", { content: "salut" });
    await tick();

    assert.strictEqual(toAlice.length, 1, "the sender receives it too");
    assert.strictEqual(toBob.length, 1);
    assert.strictEqual(toBob[0].content, "salut");
    // Both clients see the exact same authoritative message.
    assert.strictEqual(toAlice[0].id, toBob[0].id);
    assert.strictEqual(toAlice[0].sequence, toBob[0].sequence);
    assert.strictEqual(toAlice[0].createdAt, toBob[0].createdAt);
  });

  it("uses the room identity and ignores forged metadata", async () => {
    const { bob, alice } = await seatCheckers();
    const toBob = collect<RoomChatMessage>(bob, "chatMessage");

    alice.send("chatMessage", {
      content: "je suis Bob",
      userId: "user-b",
      username: "Bob",
      id: "forged",
      sequence: 999,
      createdAt: 1,
    });
    await tick();

    assert.strictEqual(toBob.length, 1);
    assert.strictEqual(toBob[0].userId, "user-a");
    assert.strictEqual(toBob[0].username, "Alice");
    assert.notStrictEqual(toBob[0].id, "forged");
    assert.notStrictEqual(toBob[0].sequence, 999);
    assert.notStrictEqual(toBob[0].createdAt, 1);
  });

  it("keeps rooms isolated", async () => {
    const roomA = (await colyseus.createRoom("checkers", {
      targetPlayers: 2,
    })) as CheckersRoom;
    const roomB = (await colyseus.createRoom("checkers", {
      targetPlayers: 2,
    })) as CheckersRoom;

    const alice = await colyseus.connectTo(roomA, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(roomA, {
      token: await mintToken("user-b", "Bob"),
    });
    const carol = await colyseus.connectTo(roomB, {
      token: await mintToken("user-c", "Carol"),
    });

    const toBob = collect<RoomChatMessage>(bob, "chatMessage");
    const toCarol = collect<RoomChatMessage>(carol, "chatMessage");

    alice.send("chatMessage", { content: "Hello" });
    await tick();

    assert.strictEqual(toBob.length, 1, "same room receives it");
    assert.strictEqual(toCarol.length, 0, "another room must never see it");
    assert.strictEqual(roomB.chatSize, 0);
  });

  it("rejects empty, oversized and malformed messages", async () => {
    const { alice, bob, room } = await seatCheckers();
    const rejections = collect<{ reason: string }>(alice, "chatRejected");
    const toBob = collect<RoomChatMessage>(bob, "chatMessage");

    alice.send("chatMessage", { content: "   " });
    alice.send("chatMessage", { content: "x".repeat(MAX_CONTENT_LENGTH + 1) });
    alice.send("chatMessage", { content: 42 });
    alice.send("chatMessage", {});
    await tick();

    assert.strictEqual(toBob.length, 0, "nothing reaches the room");
    assert.deepStrictEqual(
      rejections.map((r) => r.reason),
      ["empty", "too-long", "invalid", "invalid"],
    );
    assert.strictEqual(room.chatSize, 0);
  });

  it("rate-limits a flood and tells only the sender", async () => {
    const { alice, bob } = await seatCheckers();
    const rejections = collect<{ reason: string }>(alice, "chatRejected");
    const toBob = collect<RoomChatMessage>(bob, "chatMessage");
    const bobRejections = collect<{ reason: string }>(bob, "chatRejected");

    for (let i = 0; i < RATE_LIMIT_MESSAGES + 3; i++) {
      alice.send("chatMessage", { content: `flood ${i}` });
    }
    await tick();

    assert.strictEqual(toBob.length, RATE_LIMIT_MESSAGES);
    assert.strictEqual(rejections.length, 3);
    assert.ok(rejections.every((r) => r.reason === "rate-limited"));
    assert.strictEqual(bobRejections.length, 0, "the room is not told");
  });

  it("sends the recent buffer to a player who joins later", async () => {
    const room = (await colyseus.createRoom("checkers", {
      targetPlayers: 2,
    })) as CheckersRoom;

    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    alice.send("chatMessage", { content: "premier" });
    await tick();
    alice.send("chatMessage", { content: "second" });
    await tick();

    // Bob arrives after the fact and gets the buffer on join.
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    const snapshots = collect<{ messages: RoomChatMessage[] }>(
      bob,
      "chatSnapshot",
    );
    // Same sequence as the real client: register the handler, then ask.
    bob.send("chatSync", {});
    await tick();

    assert.ok(snapshots.length >= 1, "the joiner receives the buffer");
    const latest = snapshots[snapshots.length - 1].messages;
    assert.deepStrictEqual(
      latest.map((m) => m.content),
      ["premier", "second"],
    );
    assert.deepStrictEqual(
      latest.map((m) => m.sequence),
      [1, 2],
    );
  });

  it("does not replay the buffer to players already in the room", async () => {
    const { alice, bob } = await seatCheckers();
    const bobSnapshots = collect<{ messages: RoomChatMessage[] }>(
      bob,
      "chatSnapshot",
    );
    const toBob = collect<RoomChatMessage>(bob, "chatMessage");

    alice.send("chatMessage", { content: "un" });
    await tick();
    alice.send("chatMessage", { content: "deux" });
    await tick();

    assert.strictEqual(bobSnapshots.length, 0, "no snapshot after joining");
    assert.deepStrictEqual(
      toBob.map((m) => m.content),
      ["un", "deux"],
    );
  });

  it("stops delivering to a client that left", async () => {
    const { alice, bob, room } = await seatCheckers();
    const toBob = collect<RoomChatMessage>(bob, "chatMessage");

    bob.send("leave", {});
    await tick();

    alice.send("chatMessage", { content: "apres le depart" });
    await tick();

    assert.strictEqual(toBob.length, 0, "a departed client receives nothing");
    assert.strictEqual(room.chatSize, 1, "the room still holds the message");
  });

  it("refuses a message from a connection that is not a participant", async () => {
    const room = (await colyseus.createRoom("checkers", {
      targetPlayers: 2,
    })) as CheckersRoom;
    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const rejections = collect<{ reason: string }>(alice, "chatRejected");

    // Leaving drops the player record while the handler can still run.
    alice.send("leave", {});
    await tick();
    alice.send("chatMessage", { content: "fantome" });
    await tick();

    assert.strictEqual(room.chatSize, 0);
    assert.ok(
      rejections.every((r) => r.reason === "not-in-room"),
      "any rejection must be not-in-room",
    );
  });

  it("clears the chat when the room is disposed", async () => {
    const { alice, room } = await seatCheckers();
    alice.send("chatMessage", { content: "ephemere" });
    await tick();
    assert.strictEqual(room.chatSize, 1);

    await room.disconnect();
    await tick();

    assert.strictEqual(room.chatSize, 0, "disposal drops the buffer");
  });

  it("works the same for Ludo — the chat is room infrastructure", async () => {
    const room = (await colyseus.createRoom("ludo", {
      targetPlayers: 2,
    })) as LudoRoom;
    const alice = await colyseus.connectTo(room, {
      token: await mintToken("user-a", "Alice"),
    });
    const bob = await colyseus.connectTo(room, {
      token: await mintToken("user-b", "Bob"),
    });
    const toBob = collect<RoomChatMessage>(bob, "chatMessage");

    alice.send("chatMessage", { content: "on joue ?" });
    await tick();

    assert.strictEqual(toBob.length, 1);
    assert.strictEqual(toBob[0].username, "Alice");
    assert.strictEqual(toBob[0].content, "on joue ?");
  });
});
