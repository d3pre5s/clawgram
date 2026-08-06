import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { createChannelPlugin } from "../src/channel";

/**
 * `outbound.resolveTarget` is called by core's agent-delivery path — the one
 * behind `openclaw agent --deliver` and subagent completion announces. Core
 * passes `to: undefined` whenever a delivery has no explicit target and the
 * session route yielded none, and it does NOT catch a rejection from this
 * hook: a throw here is an unhandled rejection that takes down the whole
 * gateway process.
 *
 * Not hypothetical. 2026-08-06 18:27:51: an agent turn in the management
 * chat session hit exactly this — `TypeError: Cannot read properties of
 * undefined (reading 'trim')` through inferOutboundTargetKind — and systemd
 * logged `Main process exited, status=1` with a stability bundle. A research
 * subagent died with the gateway, and its completion announce then failed
 * on the same path (note 0055 in the control repo).
 *
 * The contract, read from core (`resolveOutboundTargetWithPlugin`): answer
 * `{ ok: false, error }` for anything unresolvable. Never throw.
 */

function plugin() {
  return createChannelPlugin(new Map()) as any;
}

describe("outbound.resolveTarget never rejects", () => {
  test("undefined target answers ok:false — the gateway-killer case", async () => {
    const r = await plugin().outbound.resolveTarget({ accountId: "default", to: undefined });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /target/i);
  });

  test("blank target answers ok:false", async () => {
    const r = await plugin().outbound.resolveTarget({ accountId: "default", to: "   " });
    assert.equal(r.ok, false);
  });

  test("missing runtime answers ok:false instead of throwing", async () => {
    const r = await plugin().outbound.resolveTarget({ accountId: "ghost", to: "123456" });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /runtime/i);
  });

  test("a resolver failure downstream is contained, not propagated", async () => {
    const runtimes = new Map([ [ "default", {
      resolvePeer: async () => { throw new Error("FLOOD_WAIT_42"); },
    } ] ]);
    const p = createChannelPlugin(runtimes as any) as any;
    const r = await p.outbound.resolveTarget({ accountId: "default", to: "123456" });
    assert.equal(r.ok, false);
    assert.match(String(r.error), /FLOOD_WAIT_42/);
  });

  test("a valid target still resolves", async () => {
    const runtimes = new Map([ [ "default", {
      resolvePeer: async (target: string) => ({ chatId: `resolved:${target}` }),
    } ] ]);
    const p = createChannelPlugin(runtimes as any) as any;
    const r = await p.outbound.resolveTarget({ accountId: "default", to: "123456" });
    assert.equal(r.ok, true);
    assert.equal(r.to, "resolved:123456");
  });
});
