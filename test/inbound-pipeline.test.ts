import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { handleInboundEvent } from "../src/inbound-pipeline";

/**
 * The inbound path had no test at all until this file.
 *
 * Every incoming message goes through it, and it lived as 856 lines inside a
 * closure in `gateway.startAccount`, which builds its own Telegram client —
 * so there was nothing to put a fake behind, and the 354-outcome action probe
 * never entered it (finding A6-11). Extracting it as a function is what made
 * a test possible; this is the net that was missing.
 *
 * The move itself was proved separately and more strongly than a test can:
 * the body is line-for-line identical to the block it came from, 803 lines,
 * zero differences. What a test still has to cover is the *wiring* — the
 * twelve values the function now receives explicitly, six of which are `any`
 * and therefore unchecked by the compiler.
 */

function fakeContext(over: Record<string, unknown> = {}) {
  const calls: string[] = [];
  const ctx = {
    accountId: "default",
    cfg: { channels: { clawgram: { accounts: { default: { allowFrom: [] } } } } },
    channelRuntime: {
      reply: () => { calls.push("reply"); },
      session: { get: () => undefined, set: () => {} },
      commands: { list: () => [] },
    },
    client: {},
    gram: {
      sendText: async () => { calls.push("sendText"); return { id: 1 }; },
      withTyping: async (_t: unknown, fn: () => unknown) => fn(),
      replyParseMode: undefined,
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
    pairing: { isPairingRequest: () => false, handle: async () => undefined },
    pluginRuntime: undefined,
    runtimes: new Map(),
    selfId: "777",
    selfLabel: "@agent",
    selfUsername: "agent",
    ...over,
  };
  return { ctx, calls };
}

describe("the inbound pipeline survives what the network hands it", () => {
  const shapes: Array<[ string, unknown ]> = [
    [ "nothing at all", undefined ],
    [ "an empty object", {} ],
    [ "a message that is not one", { message: 42 } ],
    [ "a message with no peer", { message: { id: 1, message: "привет" } } ],
    [ "a peer with no ids", { message: { id: 1, peerId: {}, message: "привет" } } ],
    [ "an outgoing message", { message: { id: 1, out: true, peerId: { userId: 5 }, message: "x" } } ],
  ];

  for (const [ what, event ] of shapes) {
    it(`does not throw on ${what}`, async () => {
      // A throw here reaches GramJS's event loop, not a caller: it would be an
      // unhandled rejection on the path of every incoming message.
      const { ctx } = fakeContext();
      await assert.doesNotReject(() => handleInboundEvent(event, ctx as never));
    });
  }

  it("a normalizable event reaches sender resolution; an unnormalizable one does not", async () => {
    // How far it gets, not what it decides. A message with a chat id, a
    // message id and a sender normalizes and the pipeline goes on to ask the
    // client who that sender is; one without a message id does not normalize
    // and nothing is touched.
    //
    // Deliberately not asserted here: whether a stranger is answered. The
    // allowlist gate sits past sender resolution, and reaching it needs a
    // faithful fake of the GramJS entity surface — a piece of work in its
    // own right. An assertion that looked like it covered the gate but
    // returned before reaching it would pass for the wrong reason, which is
    // the failure this whole audit kept finding.
    const touched: string[] = [];
    const client = new Proxy({}, {
      get: (_t, k) => {
        if (typeof k !== "string") return undefined;
        touched.push(k);
        return async () => undefined;
      },
    });

    const normalizable = { message: { id: 7, peerId: { userId: 500 }, senderId: 500, message: "статус?" } };
    await handleInboundEvent(normalizable, fakeContext({ client }).ctx as never);
    assert.ok(touched.includes("getEntity"),
      `pipeline stopped before sender resolution; touched: ${touched.join(", ") || "nothing"}`);

    touched.length = 0;
    await handleInboundEvent({ message: { peerId: { userId: 500 }, message: "нет id" } },
      fakeContext({ client }).ctx as never);
    assert.deepEqual(touched, [], "an unnormalizable event should touch nothing");
  });
});

describe("the context is wired, not merely typed", () => {
  it("every name the pipeline destructures is passed by the channel", () => {
    // Six of the twelve are `any`, so the compiler cannot catch a field the
    // caller forgot. Compare the two lists as text instead.
    const src = (f: string) => readFileSync(path.resolve(__dirname, "..", "..", "src", f), "utf8");

    const destructured = /const \{([\s\S]*?)\} = ctx;/.exec(src("inbound-pipeline.ts"));
    assert.ok(destructured, "the pipeline no longer destructures ctx — re-point this check");
    const wanted = destructured[ 1 ].split(",").map((s) => s.trim()).filter(Boolean).sort();

    const passed = /handleInboundEvent\(event, \{([\s\S]*?)\}\)/.exec(src("channel.ts"));
    assert.ok(passed, "the channel no longer calls handleInboundEvent — re-point this check");
    const given = passed[ 1 ].split(",").map((s) => s.trim().split(":")[ 0 ].trim()).filter(Boolean).sort();

    assert.deepEqual(wanted, given,
      "the pipeline asks for names the channel does not pass, or the other way round");
  });

  it("the declared type names exactly those twelve", () => {
    const src = readFileSync(path.resolve(__dirname, "..", "..", "src", "inbound-pipeline.ts"), "utf8");
    const type = /export type InboundContext = \{([\s\S]*?)\n\};/.exec(src);
    assert.ok(type, "InboundContext is gone — re-point this check");
    const declared = [ ...type[ 1 ].matchAll(/^\s{2}([a-zA-Z]\w*)\??:/gm) ].map((m) => m[ 1 ]).sort();
    const destructured = /const \{([\s\S]*?)\} = ctx;/.exec(src)[ 1 ]
      .split(",").map((s) => s.trim()).filter(Boolean).sort();

    assert.deepEqual(declared, destructured, "the type and the destructuring disagree");
  });
});
