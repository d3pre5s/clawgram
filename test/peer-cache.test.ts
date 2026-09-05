import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { GramJsClientManager } from "../src/gramjs-client";

/**
 * `resolvePeer` is the entry of every call that touches Telegram — send,
 * media, history, participants, reactions, read marks, typing — and a target
 * the session had not seen fell through to a scan of the 200 most recent
 * dialogs. Writing to a person by id, the standard flow, paid that scan on
 * the send and again on the read mark and the typing indicator, over a SOCKS
 * proxy (finding A6-14).
 */
describe("peer cache", () => {
  function managerWith(entity: unknown) {
    const calls = { getInputEntity: 0, getDialogs: 0 };
    const manager = Object.create(GramJsClientManager.prototype) as any;
    manager.client = {
      getInputEntity: async () => {
        calls.getInputEntity += 1;
        if (!entity) throw new Error("unknown peer");
        return entity;
      },
      getDialogs: async () => {
        calls.getDialogs += 1;
        return [];
      },
    };
    return { manager, calls };
  }

  test("a resolved peer is resolved once, not once per call", async () => {
    const { manager, calls } = managerWith({ className: "InputPeerUser", userId: 42 });

    const first = await manager.resolvePeer("42");
    const second = await manager.resolvePeer("42");

    assert.deepEqual(second.peer, first.peer);
    assert.equal(calls.getInputEntity, 1, "the second call was served from the cache");
    assert.equal(calls.getDialogs, 0, "and never reached the dialog scan");
  });

  test("the thread comes from the address of each call, not from the cache", async () => {
    const { manager } = managerWith({ className: "InputPeerChannel", channelId: 7 });

    await manager.resolvePeer("-1001:topic:12");
    const other = await manager.resolvePeer("-1001:topic:99");

    assert.equal(other.messageThreadId, 99, "a cached peer must not carry a stale topic");
  });

  test("a different kind is a different question", async () => {
    const { manager, calls } = managerWith({ className: "InputPeerUser", userId: 42 });

    await manager.resolvePeer("42", { kind: "user" });
    await manager.resolvePeer("42", { kind: "group" });

    assert.equal(calls.getInputEntity, 2, "the kind is part of the cache key");
  });

  test("`me` is not cached — it costs nothing and would sit there forever", async () => {
    const { manager, calls } = managerWith({ className: "InputPeerUser", userId: 1 });

    const resolved = await manager.resolvePeer("me");

    assert.equal(resolved.peer, "me");
    assert.equal(calls.getInputEntity, 0);
  });
});
