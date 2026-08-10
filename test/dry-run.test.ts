import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { createChannelPlugin } from "../src/channel";
import { resolveDryRun } from "../src/helpers";
import type { RuntimeMap } from "../src/types";

/**
 * `dryRun` arrives as a sibling of `params`, which is not where a caller
 * looks for it. Put it inside `params` — the obvious place, next to `to` and
 * `text` — and it was silently ignored while the send happened for real.
 *
 * That is the worst possible failure for a safety flag, and it has now cost
 * two real messages in a work chat: 2026-08-08 (note 0066) and again
 * 2026-08-10 at 02:49 UTC, when a probe posted a bare "ping" (id 2360). The
 * channel has no delete action, so neither could be taken back.
 *
 * Either position now means dry run. A flag that exists to prevent an
 * irreversible act must fail toward not acting.
 */
describe("resolveDryRun accepts the flag from either position", () => {
  test("the documented sibling position still works", () => {
    assert.equal(resolveDryRun(true, {}), true);
    assert.equal(resolveDryRun(false, {}), false);
    assert.equal(resolveDryRun(undefined, {}), false);
  });

  test("the flag inside params counts too — the position callers reach for", () => {
    assert.equal(resolveDryRun(undefined, { dryRun: true }), true);
    assert.equal(resolveDryRun(false, { dryRun: true }), true);
  });

  test("either side being true wins", () => {
    // Fail toward not sending: a disagreement between the two positions is a
    // caller who meant "do not send" in at least one of them.
    assert.equal(resolveDryRun(true, { dryRun: false }), true);
  });

  test("accepts the string a JSON-ish caller may send", () => {
    assert.equal(resolveDryRun(undefined, { dryRun: "true" }), true);
    assert.equal(resolveDryRun(undefined, { dryRun: "false" }), false);
  });

  test("absent everywhere means a real send", () => {
    assert.equal(resolveDryRun(undefined, undefined), false);
    assert.equal(resolveDryRun(undefined, { text: "привет" }), false);
  });
});

describe("send honours dryRun from inside params", () => {
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
      send: (params: Record<string, unknown>) =>
        channel.actions.handleAction({ action: "send", params, cfg, accountId: "default" }),
    };
  }

  test("the ping that could not be taken back", async () => {
    const h = harness();
    const result = await h.send({ to: "-100123", text: "ping", dryRun: true });

    assert.deepEqual(h.sends, [], "nothing may reach Telegram on a dry run");
    assert.match(JSON.stringify(result), /"dryRun":true/);
  });

  test("a real send still goes out", async () => {
    const h = harness();
    await h.send({ to: "-100123", text: "настоящее сообщение" });

    assert.equal(h.sends.length, 1);
  });
});
