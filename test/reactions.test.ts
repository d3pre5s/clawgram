import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { parseReactionParams } from "../src/reactions";

describe("parseReactionParams", () => {
  it("reads the emoji and the message it belongs to", () => {
    const parsed = parseReactionParams({ chatId: "-100123", messageId: 42, emoji: "👍" }, undefined);

    assert.equal(parsed.target, "-100123");
    assert.equal(parsed.messageId, 42);
    assert.equal(parsed.emoji, "👍");
    assert.equal(parsed.remove, false);
  });

  // The tool contract names the message `messageId`; callers reaching for the
  // other obvious spellings should not be silently refused.
  it("accepts the usual aliases for chat and message", () => {
    const byTarget = parseReactionParams({ target: "@team", messageId: "7", emoji: "🔥" }, undefined);
    assert.equal(byTarget.target, "@team");
    assert.equal(byTarget.messageId, 7);

    const byMsgId = parseReactionParams({ to: "@team", msgId: 8, emoji: "🔥" }, undefined);
    assert.equal(byMsgId.messageId, 8);
  });

  // Replying in place is the common case: the chat is known from context, so
  // requiring the caller to repeat it would be pointless friction.
  it("falls back to the current chat and message from tool context", () => {
    const parsed = parseReactionParams({ emoji: "👍" }, {
      currentChannelId: "-100999",
      currentMessageId: 11,
    });

    assert.equal(parsed.target, "-100999");
    assert.equal(parsed.messageId, 11);
  });

  it("prefers explicit params over tool context", () => {
    const parsed = parseReactionParams({ chatId: "-100123", messageId: 42, emoji: "👍" }, {
      currentChannelId: "-100999",
      currentMessageId: 11,
    });

    assert.equal(parsed.target, "-100123");
    assert.equal(parsed.messageId, 42);
  });

  // An empty emoji is the documented way to clear this account's reactions —
  // it must not be mistaken for a missing argument.
  it("treats an empty emoji as removal", () => {
    const parsed = parseReactionParams({ chatId: "-100123", messageId: 42, emoji: "" }, undefined);

    assert.equal(parsed.remove, true);
    assert.equal(parsed.emoji, "");
  });

  it("treats remove: true as removal and keeps the emoji for validation", () => {
    const parsed = parseReactionParams({ chatId: "-1", messageId: 1, emoji: "👍", remove: true }, undefined);

    assert.equal(parsed.remove, true);
    assert.equal(parsed.emoji, "👍");
  });

  it("accepts remove as the string a JSON-ish caller would send", () => {
    const parsed = parseReactionParams({ chatId: "-1", messageId: 1, emoji: "👍", remove: "true" }, undefined);

    assert.equal(parsed.remove, true);
  });

  it("refuses a reaction with no chat to send it to", () => {
    assert.throws(
      () => parseReactionParams({ messageId: 42, emoji: "👍" }, undefined),
      /requires a chatId/,
    );
  });

  it("refuses a reaction with no message to attach to", () => {
    assert.throws(
      () => parseReactionParams({ chatId: "-100123", emoji: "👍" }, undefined),
      /requires a messageId/,
    );
  });

  // A message id that is really a date is the bug the history parser exists to
  // prevent; the same confusion must not slip in through reactions.
  it("refuses a message id that is not a positive integer", () => {
    for (const messageId of [ 0, -3, 1.5, "not-a-number", "2026-08-03" ]) {
      assert.throws(
        () => parseReactionParams({ chatId: "-1", messageId, emoji: "👍" }, undefined),
        /messageId/,
        `expected ${JSON.stringify(messageId)} to be refused`,
      );
    }
  });

  // Adding a reaction needs something to add. Only removal may be emoji-less.
  it("refuses an add with no emoji at all", () => {
    assert.throws(
      () => parseReactionParams({ chatId: "-1", messageId: 1 }, undefined),
      /requires an emoji/,
    );
  });

  it("refuses remove: true without an emoji, matching the tool contract", () => {
    assert.throws(
      () => parseReactionParams({ chatId: "-1", messageId: 1, remove: true }, undefined),
      /requires an emoji/,
    );
  });

  it("rejects an emoji that is not a string", () => {
    assert.throws(
      () => parseReactionParams({ chatId: "-1", messageId: 1, emoji: 42 }, undefined),
      /emoji must be a string/,
    );
  });
});
