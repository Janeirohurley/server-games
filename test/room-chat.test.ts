import assert from "assert";

import {
  MAX_CHAT_MESSAGES,
  MAX_CONTENT_LENGTH,
  RATE_LIMIT_MESSAGES,
  RATE_LIMIT_WINDOW_MS,
  RoomChat,
  type ChatResult,
} from "../src/rooms/room-chat.js";

const ALICE = { userId: "user-a", username: "Alice" };
const BOB = { userId: "user-b", username: "Bob" };

function accepted(result: ChatResult) {
  assert.strictEqual(
    result.status,
    "accepted",
    `expected the message to be accepted, got ${JSON.stringify(result)}`,
  );
  if (result.status !== "accepted") throw new Error("unreachable");
  return result.message;
}

function rejected(result: ChatResult): string {
  assert.strictEqual(result.status, "rejected");
  if (result.status !== "rejected") throw new Error("unreachable");
  return result.reason;
}

describe("RoomChat", () => {
  describe("validation", () => {
    it("rejects an empty message", () => {
      const chat = new RoomChat();
      assert.strictEqual(rejected(chat.submit(ALICE, { content: "" })), "empty");
      assert.strictEqual(chat.size, 0);
    });

    it("rejects a whitespace-only message", () => {
      const chat = new RoomChat();
      assert.strictEqual(
        rejected(chat.submit(ALICE, { content: "   \n\t  " })),
        "empty",
      );
    });

    it("trims surrounding whitespace", () => {
      const chat = new RoomChat();
      const message = accepted(chat.submit(ALICE, { content: "  salut  " }));
      assert.strictEqual(message.content, "salut");
    });

    it("collapses newlines and drops control characters", () => {
      const chat = new RoomChat();
      // BEL is stripped outright; the newlines and the tab are
      // whitespace, so each run collapses to a single space.
      const message = accepted(
        chat.submit(ALICE, { content: "a\n\nb\u0007\tc" }),
      );
      assert.strictEqual(message.content, "a b c");
    });

    it("rejects an oversized message", () => {
      const chat = new RoomChat();
      const tooLong = "x".repeat(MAX_CONTENT_LENGTH + 1);
      assert.strictEqual(
        rejected(chat.submit(ALICE, { content: tooLong })),
        "too-long",
      );
      assert.strictEqual(chat.size, 0);
    });

    it("accepts a message of exactly the maximum length", () => {
      const chat = new RoomChat();
      const exact = "x".repeat(MAX_CONTENT_LENGTH);
      assert.strictEqual(accepted(chat.submit(ALICE, { content: exact })).content, exact);
    });

    it("rejects invalid payloads", () => {
      const chat = new RoomChat();
      for (const payload of [
        {},
        { content: 42 },
        { content: null },
        { content: ["hi"] },
        { content: { text: "hi" } },
      ]) {
        assert.strictEqual(
          rejected(chat.submit(ALICE, payload as { content?: unknown })),
          "invalid",
        );
      }
      assert.strictEqual(chat.size, 0);
    });
  });

  describe("authoritative metadata", () => {
    it("takes the identity from the caller, never the payload", () => {
      const chat = new RoomChat();
      const message = accepted(
        chat.submit(ALICE, {
          content: "hello",
          // A client trying to impersonate Bob and forge metadata.
          userId: "user-b",
          username: "Bob",
          id: "forged-id",
          sequence: 999,
          createdAt: 1,
        } as { content?: unknown }),
      );

      assert.strictEqual(message.userId, "user-a");
      assert.strictEqual(message.username, "Alice");
      assert.notStrictEqual(message.id, "forged-id");
      assert.notStrictEqual(message.sequence, 999);
      assert.notStrictEqual(message.createdAt, 1);
    });

    it("generates a unique id per message", () => {
      const chat = new RoomChat();
      const ids = new Set<string>();
      for (let i = 0; i < 20; i++) {
        ids.add(accepted(chat.submit(ALICE, { content: `m${i}` }, i * 10_000)).id);
      }
      assert.strictEqual(ids.size, 20);
    });

    it("assigns a monotonically increasing sequence across senders", () => {
      const chat = new RoomChat();
      const a = accepted(chat.submit(ALICE, { content: "un" }, 0));
      const b = accepted(chat.submit(BOB, { content: "deux" }, 10_000));
      const c = accepted(chat.submit(ALICE, { content: "trois" }, 20_000));

      assert.deepStrictEqual(
        [a.sequence, b.sequence, c.sequence],
        [1, 2, 3],
      );
    });

    it("stamps the server clock", () => {
      const chat = new RoomChat();
      const message = accepted(chat.submit(ALICE, { content: "hi" }, 1_700_000));
      assert.strictEqual(message.createdAt, 1_700_000);
    });
  });

  describe("rate limiting", () => {
    it("blocks a burst beyond the limit", () => {
      const chat = new RoomChat();
      for (let i = 0; i < RATE_LIMIT_MESSAGES; i++) {
        accepted(chat.submit(ALICE, { content: `m${i}` }, 1_000));
      }
      assert.strictEqual(
        rejected(chat.submit(ALICE, { content: "un de trop" }, 1_000)),
        "rate-limited",
      );
      assert.strictEqual(chat.size, RATE_LIMIT_MESSAGES);
    });

    it("limits each user separately", () => {
      const chat = new RoomChat();
      for (let i = 0; i < RATE_LIMIT_MESSAGES; i++) {
        accepted(chat.submit(ALICE, { content: `m${i}` }, 1_000));
      }
      // Alice is throttled; Bob is not.
      assert.strictEqual(
        rejected(chat.submit(ALICE, { content: "encore" }, 1_000)),
        "rate-limited",
      );
      accepted(chat.submit(BOB, { content: "bonjour" }, 1_000));
    });

    it("lets the window slide", () => {
      const chat = new RoomChat();
      for (let i = 0; i < RATE_LIMIT_MESSAGES; i++) {
        accepted(chat.submit(ALICE, { content: `m${i}` }, 1_000));
      }
      assert.strictEqual(
        rejected(chat.submit(ALICE, { content: "trop tot" }, 1_000)),
        "rate-limited",
      );
      accepted(
        chat.submit(ALICE, { content: "plus tard" }, 1_000 + RATE_LIMIT_WINDOW_MS),
      );
    });
  });

  describe("bounded buffer", () => {
    it("keeps insertion order", () => {
      const chat = new RoomChat();
      for (let i = 0; i < 3; i++) {
        chat.submit(ALICE, { content: `m${i}` }, i * 10_000);
      }
      assert.deepStrictEqual(
        chat.snapshot().map((m) => m.content),
        ["m0", "m1", "m2"],
      );
    });

    it("never grows past the maximum, dropping the oldest", () => {
      const chat = new RoomChat();
      const total = MAX_CHAT_MESSAGES + 25;
      for (let i = 0; i < total; i++) {
        // Space the timestamps out so the rate limit never trips.
        chat.submit(ALICE, { content: `m${i}` }, i * 10_000);
      }

      const snapshot = chat.snapshot();
      assert.strictEqual(snapshot.length, MAX_CHAT_MESSAGES);
      assert.strictEqual(snapshot[0].content, `m${total - MAX_CHAT_MESSAGES}`);
      assert.strictEqual(snapshot[snapshot.length - 1].content, `m${total - 1}`);
    });

    it("hands out copies, so a caller cannot mutate the buffer", () => {
      const chat = new RoomChat();
      chat.submit(ALICE, { content: "original" });
      const snapshot = chat.snapshot();
      snapshot[0].content = "tampered";
      assert.strictEqual(chat.snapshot()[0].content, "original");
    });
  });

  describe("disposal", () => {
    it("drops every message and the rate-limit state", () => {
      const chat = new RoomChat();
      for (let i = 0; i < RATE_LIMIT_MESSAGES; i++) {
        chat.submit(ALICE, { content: `m${i}` }, 1_000);
      }
      assert.strictEqual(chat.size, RATE_LIMIT_MESSAGES);

      chat.dispose();

      assert.strictEqual(chat.size, 0);
      assert.deepStrictEqual(chat.snapshot(), []);
      // The throttle is gone too — this is a fresh, empty chat.
      accepted(chat.submit(ALICE, { content: "apres" }, 1_000));
    });

    it("holds nothing that outlives the instance", () => {
      // A fresh chat never inherits anything from a previous one: this is
      // what makes a server restart lose every message.
      const first = new RoomChat();
      first.submit(ALICE, { content: "avant redemarrage" });
      const second = new RoomChat();
      assert.deepStrictEqual(second.snapshot(), []);
      assert.strictEqual(second.size, 0);
    });
  });
});
