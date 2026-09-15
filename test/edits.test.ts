import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { parseResult } from "./helpers";

import { canonicalAction, createChannelPlugin } from "../src/channel";
import { parseEditParams } from "../src/edits";
import type { RuntimeMap } from "../src/types";

describe("parseEditParams", () => {
  it("reads the chat, the message and the replacement text", () => {
    const parsed = parseEditParams({ chatId: "-100123", messageId: 42, text: "новый текст" }, undefined);

    assert.equal(parsed.target, "-100123");
    assert.equal(parsed.messageId, 42);
    assert.equal(parsed.text, "новый текст");
  });

  // The same spellings `send` and `react` accept, for the same reason: a
  // caller that guessed the other obvious name should not be refused.
  it("accepts the usual aliases for chat, message and text", () => {
    const byTarget = parseEditParams({ target: "@team", msgId: "7", message: "правка" }, undefined);
    assert.equal(byTarget.target, "@team");
    assert.equal(byTarget.messageId, 7);
    assert.equal(byTarget.text, "правка");

    const byTo = parseEditParams({ to: "@team", message_id: 8, text: "правка" }, undefined);
    assert.equal(byTo.messageId, 8);
  });

  // The chat may come from context — it is the chat the turn is already in.
  it("falls back to the current chat from tool context", () => {
    const parsed = parseEditParams({ messageId: 5, text: "правка" }, { currentChannelId: "-100999" });

    assert.equal(parsed.target, "-100999");
  });

  /**
   * The difference from `react`, and the point of this test.
   *
   * `currentMessageId` is the message being answered — someone else's. React
   * to it, yes; rewrite it, never. Falling back would turn a caller's omission
   * into an attempt to edit another person's message, refused by Telegram as
   * MESSAGE_AUTHOR_REQUIRED on a call nobody meant to make.
   */
  it("never takes the message id from tool context", () => {
    assert.throws(
      () => parseEditParams({ text: "правка" }, { currentChannelId: "-100999", currentMessageId: 11 }),
      /requires a messageId/,
    );
  });

  // An empty edit is not a deletion: Telegram refuses it server-side, and a
  // caller who wanted the message gone asked for the wrong action.
  it("refuses an empty replacement text", () => {
    assert.throws(() => parseEditParams({ chatId: "-100123", messageId: 42, text: "   " }, undefined),
      /not a deletion/);
    assert.throws(() => parseEditParams({ chatId: "-100123", messageId: 42 }, undefined),
      /not a deletion/);
  });

  it("refuses a call that names no chat", () => {
    assert.throws(() => parseEditParams({ messageId: 42, text: "правка" }, undefined), /requires a chatId/);
  });
});

describe("edit action names", () => {
  // Core's own spelling is `edit`; the rest are what a caller may reach for.
  it("resolves every accepted spelling to the canonical action", () => {
    for (const spelling of [ "edit", "editMessage", "edit-message", "update" ]) {
      assert.equal(canonicalAction(spelling), "edit", spelling);
    }
  });
});

/**
 * With no runtime registered, anything that reaches Telegram fails with
 * "runtime not found" — the same signal `silent-send.test.ts` uses for "would
 * have gone out". A refusal that arrives *instead* of that proves the gate in
 * front of the network held.
 */
describe("message.action edit", () => {
  const channel = createChannelPlugin(new Map() as RuntimeMap) as any;
  const cfg = { channels: { clawgram: { accounts: { default: {} } } } };

  const edit = (params: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
    channel.actions.handleAction({
      action: "edit",
      params: { to: "-100123", messageId: 42, text: "новый текст", ...params },
      cfg,
      accountId: "default",
      ...extra,
    });

  it("a dry run reports the target and touches no runtime", async () => {
    const payload = parseResult(await edit({}, { dryRun: true }));

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.chatId, "-100123");
    assert.equal(payload.messageId, 42);
    // Not "edited": a rehearsal must not claim the message changed.
    assert.equal(payload.edited, undefined);
  });

  /**
   * `NO_REPLY` is OpenClaw's "say nothing" sentinel, and an explicit tool call
   * is not a path that strips it. Worse here than in a send: the original text
   * is gone, so a good answer would be replaced by what reads as a
   * malfunction.
   */
  it("refuses the silent sentinel as the new text", async () => {
    await assert.rejects(() => edit({ text: "NO_REPLY" }), /silent-reply sentinel/);
    await assert.rejects(() => edit({ text: "  no_reply \n" }), /silent-reply sentinel/);
  });

  it("reaches the runtime for a well-formed call", async () => {
    // Past the parser, past the sentinel, past the scope gate — the only thing
    // left is the network, which is absent in this harness.
    await assert.rejects(() => edit({}), /runtime/i);
  });

  it("refuses a message id it was not given", async () => {
    await assert.rejects(() => edit({ messageId: undefined }), /requires a messageId/);
  });
});
