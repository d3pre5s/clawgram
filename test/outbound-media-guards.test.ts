import assert from "node:assert/strict";
import test, { describe, beforeEach } from "node:test";

import { createChannelPlugin } from "../src/channel";
import { rememberGroupReplyAddress, resetGroupReplyAddresses } from "../src/group-reply-address";
import { rememberSendScope, forgetSendScope } from "../src/send-scope";
import type { RuntimeMap } from "../src/types";

/**
 * `outbound.sendMedia` was written beside `outbound.sendText` and got none of
 * its guards: the silent token went out as a caption, a group reply greeted
 * nobody, and the send scope was not consulted at all (finding A6-18).
 */
describe("outbound sendMedia guards", () => {
  const ACCOUNT = "media-acc";

  function pluginWithRuntime() {
    const sent: any[] = [];
    const runtimes = new Map([ [ ACCOUNT, {
      sendMedia: async (args: any) => { sent.push(args); return { id: 1 }; },
      replyParseMode: undefined,
    } ] ]) as unknown as RuntimeMap;
    const plugin = createChannelPlugin(runtimes) as any;
    return { plugin, sent };
  }

  beforeEach(() => {
    resetGroupReplyAddresses();
    forgetSendScope(ACCOUNT);
  });

  test("a caption carrying the silent token sends nothing", async () => {
    const { plugin, sent } = pluginWithRuntime();

    const result = await plugin.outbound.sendMedia({
      accountId: ACCOUNT, to: "-1001", filePath: "/tmp/x.png", caption: "NO_REPLY",
    });

    assert.deepEqual(result, { skipped: "silent" });
    assert.equal(sent.length, 0);
  });

  test("a chat outside the send scope is refused, not delivered", async () => {
    const { plugin, sent } = pluginWithRuntime();
    rememberSendScope(ACCOUNT, [ "-1001" ]);

    const result = await plugin.outbound.sendMedia({
      accountId: ACCOUNT, to: "-1009999", filePath: "/tmp/x.png", caption: "привет",
    });

    assert.deepEqual(result, { skipped: "not-allowed" });
    assert.equal(sent.length, 0);
  });

  test("a listed chat still goes through, prefix and all", async () => {
    const { plugin, sent } = pluginWithRuntime();
    rememberSendScope(ACCOUNT, [ "-1001" ]);

    await plugin.outbound.sendMedia({
      accountId: ACCOUNT, to: "clawgram:-1001", filePath: "/tmp/x.png", caption: "привет",
    });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].target, "-1001");
  });

  test("the caption greets whoever the reply is addressed to", async () => {
    const { plugin, sent } = pluginWithRuntime();
    rememberGroupReplyAddress({
      accountId: ACCOUNT, chatId: "-1001", replyToId: "55", address: "@colleague",
    });

    await plugin.outbound.sendMedia({
      accountId: ACCOUNT, to: "-1001", replyToId: "55", filePath: "/tmp/x.png", caption: "готово",
    });

    assert.equal(sent.length, 1);
    assert.ok(String(sent[0].caption).startsWith("@colleague"),
      `caption should greet the addressee, got ${JSON.stringify(sent[0].caption)}`);
  });

  test("a file with no caption is still delivered", async () => {
    const { plugin, sent } = pluginWithRuntime();

    await plugin.outbound.sendMedia({ accountId: ACCOUNT, to: "-1001", filePath: "/tmp/x.png" });

    assert.equal(sent.length, 1);
    assert.equal(sent[0].caption, undefined);
  });
});
