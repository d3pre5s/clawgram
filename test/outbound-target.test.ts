import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createChannelPlugin } from "../src/channel";

/**
 * `outbound.resolveTarget` is called by core's agent-delivery path — the one
 * behind `openclaw agent --deliver` and subagent completion announces. Three
 * facts about that caller, all learned the hard way on 2026-08-06:
 *
 * 1. It passes `to: undefined` when a delivery has no explicit target and the
 *    session route yielded none, and it does not catch a rejection: a throw
 *    here is an unhandled rejection that killed the whole gateway process
 *    (18:27 UTC, systemd status=1, a research subagent died with it).
 *
 * 2. `resolveAgentDeliveryPlanWithSessionRoute` calls the hook WITHOUT await.
 *    An async hook hands it a Promise: `promise.ok` is undefined, the error
 *    branch runs, `promise.error` is undefined, and core's
 *    `isReservedTargetLiteralError` crashes on `error.message` — which is why
 *    every subagent announce into the management chat gave up with
 *    "Cannot read properties of undefined (reading 'message')". The hook must
 *    return a plain value. (Await of a plain value still works, so the sites
 *    that do await are unaffected.)
 *
 * 3. That same core helper reads `error.message.includes(...)`: the error in
 *    a not-ok result must be Error-like, not a bare string.
 */

function plugin() {
  return createChannelPlugin(new Map()) as any;
}

describe("outbound.resolveTarget contract with core", () => {
  test("returns a plain value, not a Promise — core reads it without await", () => {
    const r = plugin().outbound.resolveTarget({ accountId: "default", to: "123456" });
    assert.ok(!(r instanceof Promise), "resolveTarget must be synchronous");
    assert.equal(r.ok, true);
  });

  test("undefined target answers ok:false — the gateway-killer case", () => {
    const r = plugin().outbound.resolveTarget({ accountId: "default", to: undefined });
    assert.equal(r.ok, false);
    assert.equal(typeof r.error?.message, "string", "error must be Error-like: core reads error.message");
    assert.match(r.error.message, /target/i);
  });

  test("blank target answers ok:false with an Error-like error", () => {
    const r = plugin().outbound.resolveTarget({ accountId: "default", to: "   " });
    assert.equal(r.ok, false);
    assert.equal(typeof r.error?.message, "string");
  });

  test("a session-route chat id passes through unchanged", () => {
    // The announce path feeds back the id the session key carries; changing it
    // would break the route match.
    const r = plugin().outbound.resolveTarget({ accountId: "default", to: "-1000000000001" });
    assert.equal(r.ok, true);
    assert.equal(r.to, "-1000000000001");
  });

  test("channel-prefixed targets are normalized", () => {
    const r = plugin().outbound.resolveTarget({ accountId: "default", to: "clawgram:123456" });
    assert.equal(r.ok, true);
    assert.equal(r.to, "123456");
  });

  test("never throws, whatever arrives", () => {
    for (const to of [ null, 42, {}, [] ] as any[]) {
      const r = plugin().outbound.resolveTarget({ accountId: "default", to });
      assert.equal(r.ok, false, `expected ok:false for ${JSON.stringify(to)}`);
      assert.equal(typeof r.error?.message, "string");
    }
  });
});
