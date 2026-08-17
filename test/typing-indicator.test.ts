import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { GramJsClientManager } from "../src/gramjs-client";

/**
 * The typing indicator is a promise that words are coming, so it is owed only
 * to someone who addressed the agent.
 *
 * Under `groupPolicy: "open"` every message starts a turn and most of those
 * turns end in silence. On 2026-08-17 the owner's management chat watched
 * «Тина печатает…» for 20–26 seconds on four consecutive messages that were
 * never addressed to her, each followed by nothing — the indicator was the
 * only thing the room saw of a decision to stay quiet.
 *
 * The read receipt is a separate fact and survives: she did read it.
 */
describe("typing indicator", () => {
  function managerWithFakeClient() {
    const invoked: string[] = [];
    const manager = Object.create(GramJsClientManager.prototype) as any;
    manager.client = {
      invoke: async (request: any) => {
        const action = request?.action?.className ?? request?.action?.constructor?.name ?? "unknown";
        invoked.push(action);
      },
      markAsRead: async () => { read.push("markAsRead"); },
    };
    const read: string[] = [];
    manager.resolvePeer = async () => ({ peer: { id: 1 } });
    manager.markRead = async () => { read.push("markRead"); };
    return { manager, invoked, read };
  }

  test("typing: false runs the turn without ever announcing it", async () => {
    const { manager, invoked, read } = managerWithFakeClient();

    const result = await manager.withTyping("-100", async () => "done", {
      readMessageId: 42,
      typing: false,
    });

    assert.equal(result, "done");
    assert.deepEqual(invoked, []);
    // Read still happens: silence is not the same as not having looked.
    assert.deepEqual(read, [ "markRead" ]);
  });

  // `sendTyping` resolves the peer first, so a turn that returns instantly is
  // already over by the time the indicator would go out and only the cancel is
  // sent. A turn has to actually take a moment for the announcement to happen —
  // which is the real case, since turns take tens of seconds.
  const slowTurn = async () => {
    for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
    return "done";
  };

  test("the default still shows typing, so addressed turns are unchanged", async () => {
    const { manager, invoked } = managerWithFakeClient();

    assert.equal(await manager.withTyping("-100", slowTurn, { readMessageId: 42 }), "done");

    assert.deepEqual(invoked, [ "SendMessageTypingAction", "SendMessageCancelAction" ]);
  });

  test("typing: true is the same as omitting it", async () => {
    const { manager, invoked } = managerWithFakeClient();

    await manager.withTyping("-100", slowTurn, { readMessageId: 42, typing: true });

    assert.deepEqual(invoked, [ "SendMessageTypingAction", "SendMessageCancelAction" ]);
  });

  test("typing: false stays silent even on a turn that takes a while", async () => {
    const { manager, invoked } = managerWithFakeClient();

    await manager.withTyping("-100", slowTurn, { readMessageId: 42, typing: false });

    assert.deepEqual(invoked, []);
  });

  // The turn's result must survive the shortcut, and so must its failure:
  // swallowing a throw here would turn a broken turn into a silent one.
  test("typing: false propagates what the turn threw", async () => {
    const { manager } = managerWithFakeClient();

    await assert.rejects(
      manager.withTyping("-100", async () => { throw new Error("dispatch blew up"); }, { typing: false }),
      /dispatch blew up/,
    );
  });

  // A chat the account cannot resolve must not cost the turn: the indicator is
  // decoration, the dispatch is the work.
  test("typing: false still runs the turn when the peer cannot be resolved", async () => {
    const { manager, read } = managerWithFakeClient();
    manager.resolvePeer = async () => { throw new Error("peer gone"); };

    assert.equal(await manager.withTyping("-100", async () => "done", { typing: false }), "done");
    assert.deepEqual(read, []);
  });
});
