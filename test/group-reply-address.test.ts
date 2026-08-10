import { strict as assert } from "node:assert";
import { describe, it, beforeEach } from "node:test";

import {
  buildGroupReplyAddress,
  consumeGroupReplyAddress,
  rememberGroupReplyAddress,
  resetGroupReplyAddresses,
} from "../src/group-reply-address";
import { rememberVisibleGroupReply, resetVisibleGroupReplies } from "../src/group-visible-reply-guard";
import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";

/**
 * Addressing a group reply.
 *
 * A busy work chat interleaves requests: one person asks at 15:33, another at
 * 15:35, and the answer to the first arrives at 15:39. Whom that answer greets
 * is not cosmetic — on 2026-08-10 the report for the owner's request went out
 * as "@second_person, готово", so the wrong person read someone else's result
 * and their own question looked ignored.
 */
describe("group reply addressing follows the message being answered", () => {
  beforeEach(() => { resetGroupReplyAddresses(); resetVisibleGroupReplies(); });

  it("returns the address remembered for that very message", () => {
    rememberGroupReplyAddress({ accountId: "default", chatId: "-100123", replyToId: "10", address: "@first" });

    assert.equal(consumeGroupReplyAddress({ accountId: "default", chatId: "-100123", replyToId: "10" }), "@first");
  });

  // The bug itself: two messages arrive, the answer to the older one carries no
  // replyToId, and the address must not silently become the newer sender's.
  it("does not hand out a newer sender's address when the reply targets an older message", () => {
    rememberGroupReplyAddress({ accountId: "default", chatId: "-100123", replyToId: "10", address: "@first" });
    rememberGroupReplyAddress({ accountId: "default", chatId: "-100123", replyToId: "11", address: "@second" });

    const address = consumeGroupReplyAddress({ accountId: "default", chatId: "-100123", replyToId: "10" });

    assert.equal(address, "@first");
  });

  // Without a message to answer there is no addressee. Greeting whoever spoke
  // last is a guess, and a wrong guess reads as an answer to them.
  it("returns nothing when the reply names no message", () => {
    rememberGroupReplyAddress({ accountId: "default", chatId: "-100123", replyToId: "11", address: "@second" });

    assert.equal(consumeGroupReplyAddress({ accountId: "default", chatId: "-100123" }), undefined);
  });

  it("keeps chats apart", () => {
    rememberGroupReplyAddress({ accountId: "default", chatId: "-100123", replyToId: "10", address: "@first" });

    assert.equal(consumeGroupReplyAddress({ accountId: "default", chatId: "-100999", replyToId: "10" }), undefined);
  });

  it("builds the address from what the sender actually has", () => {
    assert.equal(buildGroupReplyAddress({ senderUsername: "vasya" }), "@vasya");
    assert.equal(buildGroupReplyAddress({ senderDisplay: "Вася Ш." }), "Вася Ш.");
    assert.equal(buildGroupReplyAddress({ senderId: "42" }), "42");
  });
});

const parse = (result: unknown) => JSON.parse(
  typeof result === "string" ? result : (result as any).content?.[ 0 ]?.text ?? "{}",
);

/**
 * The tool path is where the mis-addressing actually happened: an agent
 * answering the owner called `send` without `replyToId`, and the channel filled
 * the greeting in from whoever spoke last. The turn always knows which message
 * it is answering — core passes it as `currentMessageId` — so that, not
 * recency, is what the address comes from.
 */
describe("message.action send addresses the message the turn is answering", () => {
  beforeEach(() => { resetGroupReplyAddresses(); resetVisibleGroupReplies(); });

  const cfg = { channels: { clawgram: { accounts: { default: {} } } } };

  function makeChannel() {
    const sent: Array<Record<string, unknown>> = [];
    const gram = {
      sendText: (args: Record<string, unknown>) => {
        sent.push(args);
        return Promise.resolve({ id: 500 });
      },
      get replyParseMode() { return undefined; },
    };
    const channel = createChannelPlugin(new Map([ [ "default", gram ] ]) as unknown as RuntimeMap) as any;
    return { sent, channel };
  }

  it("greets the author of the message being answered, not the latest speaker", async () => {
    rememberGroupReplyAddress({ accountId: "default", chatId: "-100123", replyToId: "10", address: "@owner" });
    rememberGroupReplyAddress({ accountId: "default", chatId: "-100123", replyToId: "11", address: "@colleague" });

    const { sent, channel } = makeChannel();
    await channel.actions.handleAction({
      action: "send",
      params: { to: "-100123", text: "готово" },
      cfg,
      accountId: "default",
      toolContext: { currentChannelId: "-100123", currentMessageId: "10" },
    });

    assert.equal(sent.length, 1);
    assert.match(String(sent[ 0 ].text), /^@owner,/);
  });

  it("still prefers an explicit replyToId over the turn's own message", async () => {
    rememberGroupReplyAddress({ accountId: "default", chatId: "-100123", replyToId: "10", address: "@owner" });
    rememberGroupReplyAddress({ accountId: "default", chatId: "-100123", replyToId: "11", address: "@colleague" });

    const { sent, channel } = makeChannel();
    await channel.actions.handleAction({
      action: "send",
      params: { to: "-100123", text: "готово", replyToId: "11" },
      cfg,
      accountId: "default",
      toolContext: { currentChannelId: "-100123", currentMessageId: "10" },
    });

    assert.match(String(sent[ 0 ].text), /^@colleague,/);
  });

  it("sends without a greeting when nothing says whom it answers", async () => {
    rememberGroupReplyAddress({ accountId: "default", chatId: "-100123", replyToId: "11", address: "@colleague" });

    const { sent, channel } = makeChannel();
    await channel.actions.handleAction({
      action: "send",
      params: { to: "-100123", text: "готово" },
      cfg,
      accountId: "default",
    });

    assert.equal(String(sent[ 0 ].text), "готово");
  });
});

/**
 * The second half of the same incident: every request was answered twice —
 * once by the agent calling `send`, then again when core delivered the turn's
 * final text. Two messages, one event, and the reader has to work out that
 * they are the same. Core's own convention is that an agent which already sent
 * a message answers NO_REPLY; when it forgets, the channel must not repeat it.
 */
describe("a turn that already spoke does not speak again", () => {
  beforeEach(() => { resetGroupReplyAddresses(); resetVisibleGroupReplies(); });

  const cfg = { channels: { clawgram: { accounts: { default: {} } } } };

  function makeChannel() {
    const sent: Array<Record<string, unknown>> = [];
    const gram = {
      sendText: (args: Record<string, unknown>) => {
        sent.push(args);
        return Promise.resolve({ id: 500 });
      },
      get replyParseMode() { return undefined; },
    };
    const channel = createChannelPlugin(new Map([ [ "default", gram ] ]) as unknown as RuntimeMap) as any;
    return { sent, channel };
  }

  it("drops the final text when the agent already sent it to the same chat", async () => {
    const { sent, channel } = makeChannel();

    await channel.actions.handleAction({
      action: "send",
      params: { to: "-100123", text: "заблокировала троих" },
      cfg,
      accountId: "default",
      toolContext: { currentChannelId: "-100123", currentMessageId: "10" },
    });
    assert.equal(sent.length, 1);

    const result = await channel.outbound.sendText({
      accountId: "default",
      to: "-100123",
      text: "заблокировала троих, таблицу обновила",
      replyToId: "10",
    });

    assert.equal(sent.length, 1, "the final text must not become a second message");
    assert.equal((result as any)?.skipped, "duplicate");
  });

  it("delivers the final text when the turn sent nothing itself", async () => {
    const { sent, channel } = makeChannel();

    await channel.outbound.sendText({
      accountId: "default",
      to: "-100123",
      text: "заблокировала троих",
      replyToId: "10",
    });

    assert.equal(sent.length, 1);
  });

  it("delivers a later message about a different incoming message", async () => {
    const { sent, channel } = makeChannel();

    await channel.actions.handleAction({
      action: "send",
      params: { to: "-100123", text: "по первой заявке готово" },
      cfg,
      accountId: "default",
      toolContext: { currentChannelId: "-100123", currentMessageId: "10" },
    });

    await channel.outbound.sendText({
      accountId: "default",
      to: "-100123",
      text: "по второй заявке готово",
      replyToId: "11",
    });

    assert.equal(sent.length, 2, "another request is another answer");
  });

  // Work that takes minutes is not core echoing the turn — it is the assistant
  // coming back with something new, and dropping it would lose the result.
  // The send is dated into the past directly, because what is under test is the
  // width of the window, not the clock.
  it("delivers a result that arrives long after the turn spoke", async () => {
    const { sent, channel } = makeChannel();

    rememberVisibleGroupReply({
      accountId: "default",
      chatId: "-100123",
      currentMessageId: "10",
    }, Date.now() - 60_000);

    await channel.outbound.sendText({
      accountId: "default",
      to: "-100123",
      text: "готово, вот результат",
      replyToId: "10",
    });

    assert.equal(sent.length, 1, "a late result is the assistant speaking, not an echo");
  });
});
