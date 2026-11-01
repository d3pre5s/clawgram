import { strict as assert } from "node:assert";
import { test } from "node:test";
import { Api } from "telegram";
import { GramJsClientManager } from "../src/gramjs-client";

function harness(options: { premium?: boolean; error?: string; empty?: boolean; customError?: string } = {}) {
  const requests: any[] = [];
  const manager = Object.create(GramJsClientManager.prototype) as any;
  manager.resolvePeer = async () => ({ peer: "test-peer" });
  manager.client = {
    getMe: async () => ({ premium: options.premium ?? true }),
    invoke: async (request: any) => {
      requests.push(request);
      if (request instanceof Api.messages.SendReaction) {
        if (request.reaction[0] instanceof Api.ReactionEmoji && request.reaction[0].emoticon === "❌") {
          throw Object.assign(new Error(options.error ?? "REACTION_INVALID"), { errorMessage: options.error ?? "REACTION_INVALID" });
        }
        if (request.reaction[0] instanceof Api.ReactionCustomEmoji && options.customError) throw new Error(options.customError);
        return {};
      }
      if (request instanceof Api.messages.SearchCustomEmoji) {
        assert.equal(request.emoticon, "❌");
        return { documentId: options.empty ? [] : [ 123456789n ] };
      }
      throw new Error(`Unexpected request: ${request.className}`);
    },
  };
  return { manager: manager as GramJsClientManager, requests };
}

test("unsupported unicode reaction uses a matching custom emoji for a Premium account", async () => {
  const { manager, requests } = harness();
  await manager.sendReaction({ target: "-1", messageId: 42, emoji: "❌", remove: false });
  assert.equal(requests.length, 3);
  const sent = requests.at(-1);
  assert.equal(sent.peer, "test-peer");
  assert.equal(sent.msgId, 42);
  assert.ok(sent.reaction[0] instanceof Api.ReactionCustomEmoji);
  assert.equal(String(sent.reaction[0].documentId), "123456789");
});

test("standard reactions and removal keep one request without custom emoji lookup", async () => {
  for (const args of [ { emoji: "❤", remove: false }, { emoji: "❌", remove: true } ]) {
    const { manager, requests } = harness();
    await manager.sendReaction({ target: "-1", messageId: 42, ...args });
    assert.equal(requests.length, 1);
    assert.equal(requests[0].reaction.length, args.remove ? 0 : 1);
  }
});

test("custom fallback preserves permission, transport and account failures", async () => {
  for (const error of [ "CHAT_WRITE_FORBIDDEN", "FLOOD_WAIT_20", "timeout" ]) {
    const { manager, requests } = harness({ error });
    await assert.rejects(manager.sendReaction({ target: "-1", messageId: 42, emoji: "❌", remove: false }), new RegExp(error));
    assert.equal(requests.length, 1);
  }
  const free = harness({ premium: false });
  await assert.rejects(free.manager.sendReaction({ target: "-1", messageId: 42, emoji: "❌", remove: false }), /REACTION_INVALID/);
  assert.equal(free.requests.length, 1);
  const empty = harness({ empty: true });
  await assert.rejects(empty.manager.sendReaction({ target: "-1", messageId: 42, emoji: "❌", remove: false }), /REACTION_INVALID/);
  assert.equal(empty.requests.length, 2);
  const restricted = harness({ customError: "CUSTOM_REACTIONS_TOO_MANY" });
  await assert.rejects(restricted.manager.sendReaction({ target: "-1", messageId: 42, emoji: "❌", remove: false }), /CUSTOM_REACTIONS_TOO_MANY/);
  assert.equal(restricted.requests.length, 3);
});
