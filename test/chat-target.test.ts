import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { parseChatInfoParams } from "../src/chat-info";
import { createChannelPlugin } from "../src/channel";
import { readChatTargetParam } from "../src/helpers";
import { parseListParticipantsParams } from "../src/history";
import { parseTopicsParams } from "../src/topics";
import type { RuntimeMap } from "../src/types";

/**
 * Which chat a call means was spelled out five times, and none of the five read
 * `channelId` — the key core fills for its `channelId`-mode actions, which is
 * how `chatInfo` is reached under the name `channel-info`. A call naming
 * another chat that way fell through to the current chat and was answered
 * about the wrong one.
 *
 * `send` was worse: it read `to`/`target` only, so a send carrying `chatId`
 * went to the chat the turn came from — the plugin's own tool hints tell the
 * agent to name a chat with `chatId`.
 */
describe("readChatTargetParam accepts every spelling, in one place", () => {
  test("each accepted key names the chat", () => {
    assert.equal(readChatTargetParam({ chatId: "-1001" }), "-1001");
    assert.equal(readChatTargetParam({ channelId: "-1002" }), "-1002");
    assert.equal(readChatTargetParam({ target: "-1003" }), "-1003");
    assert.equal(readChatTargetParam({ to: "-1004" }), "-1004");
    assert.equal(readChatTargetParam({ chat: "-1005" }), "-1005");
  });

  test("a named chat beats the current one", () => {
    assert.equal(
      readChatTargetParam({ chatId: "-100999" }, { currentChannelId: "-100123" }),
      "-100999",
    );
  });

  test("the current chat is the fallback, not the answer", () => {
    assert.equal(readChatTargetParam({}, { currentChannelId: "-100123" }), "-100123");
    assert.equal(readChatTargetParam({}), "");
  });

  test("numbers are refused rather than coerced, as before", () => {
    assert.equal(readChatTargetParam({ chatId: -1001 }), "");
    assert.equal(readChatTargetParam({ chatId: "  " }), "");
  });
});

describe("read actions accept the key core actually sends", () => {
  test("chatInfo, participants and topics all read channelId", () => {
    assert.equal(parseChatInfoParams({ channelId: "-100777" }, undefined).target, "-100777");
    assert.equal(parseListParticipantsParams({ channelId: "-100777" }).target, "-100777");
    assert.equal(parseTopicsParams({ channelId: "-100777" }).target, "-100777");
  });

  test("chatInfo still prefers a named chat over the current one", () => {
    assert.equal(
      parseChatInfoParams({ channelId: "-100777" }, { currentChannelId: "-100123" }).target,
      "-100777",
    );
  });
});

describe("send delivers to the chat it was given", () => {
  function harness() {
    const sends: Array<Record<string, unknown>> = [];
    const runtimes = new Map([ [ "default", {
      sendText: async (args: Record<string, unknown>) => {
        sends.push(args);
        return { id: 1 };
      },
    } ] ]) as unknown as RuntimeMap;

    const channel = createChannelPlugin(runtimes) as any;
    const cfg = { channels: { clawgram: { accounts: { default: {} } } } };

    return {
      sends,
      send: (params: Record<string, unknown>, toolContext?: Record<string, unknown>) =>
        channel.actions.handleAction({ action: "send", params, cfg, accountId: "default", toolContext }),
    };
  }

  test("a send naming chatId does not land in the current chat", async () => {
    const h = harness();

    await h.send({ chatId: "-100999", text: "для другого чата" }, { currentChannelId: "-100123" });

    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[ 0 ].target, "-100999");
  });

  test("a send naming nothing still answers where it was asked", async () => {
    const h = harness();

    await h.send({ text: "ответ здесь" }, { currentChannelId: "-100123" });

    assert.equal(h.sends[ 0 ].target, "-100123");
  });

  test("two keys naming the same chat are fine", async () => {
    const h = harness();

    await h.send({ to: "-100555", chatId: "-100555", text: "x" });

    assert.equal(h.sends[ 0 ].target, "-100555");
  });

  test("two keys naming different chats refuse rather than guess", async () => {
    const h = harness();

    await assert.rejects(
      () => h.send({ to: "-100555", chatId: "-100999", text: "x" }),
      /conflicting chat targets/,
    );
    assert.deepEqual(h.sends, [], "nothing may go out while the target is ambiguous");
  });

  test("naming nothing anywhere is an error", async () => {
    const h = harness();

    await assert.rejects(() => h.send({ text: "x" }), /message target is required/);
  });
});
