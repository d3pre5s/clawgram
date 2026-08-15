import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { GramJsClientManager } from "../src/gramjs-client";

/**
 * GramJS runs its update loop as `while (!client._destroyed)`
 * (telegram/client/updates.js) and only `destroy()` sets that flag.
 * `disconnect()` drops the connection and leaves the loop spinning: it keeps
 * retrying and printing `Error: TIMEOUT` for the lifetime of the process.
 *
 * That cost nothing while a config write restarted the whole Gateway. 2.17.0
 * declared `channels.clawgram` hot-reloadable, so a write now restarts just
 * this channel — and every restart used to leak one more loop. Measured on a
 * live server 2026-08-15: ~3 timeouts/min before one channel restart, ~4.5/min
 * after it, with zero on the two preceding days.
 */
describe("client teardown", () => {
  function managerWithFakeClient() {
    const calls: string[] = [];
    const manager = Object.create(GramJsClientManager.prototype) as any;
    manager.started = true;
    manager.client = {
      destroy: async () => { calls.push("destroy"); },
      disconnect: async () => { calls.push("disconnect"); },
    };
    return { manager, calls };
  }

  test("stop() destroys the client so the update loop can exit", async () => {
    const { manager, calls } = managerWithFakeClient();

    await manager.stop();

    assert.deepEqual(calls, [ "destroy" ]);
    assert.equal(manager.started, false);
  });

  test("stop() on a client that never started touches nothing", async () => {
    const { manager, calls } = managerWithFakeClient();
    manager.started = false;

    await manager.stop();

    assert.deepEqual(calls, []);
  });

  test("stopping twice destroys once", async () => {
    const { manager, calls } = managerWithFakeClient();

    await manager.stop();
    await manager.stop();

    assert.deepEqual(calls, [ "destroy" ]);
  });
});
