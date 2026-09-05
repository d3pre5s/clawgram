import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";

describe("a reply threads in a DM too", () => {
  // resolveReplyToMessageIdForTarget dropped replyToId unless the target kind
  // was group or channel, and inferOutboundTargetKind answers undefined for
  // @username and for a positive numeric id — every DM. The tool returned
  // ok: true and the person got an unthreaded message, while the inbound DM
  // path threaded correctly, so the two disagreed (A6-05).
  function makeChannel() {
    const sent: Array<Record<string, unknown>> = [];
    const gram = {
      sendText: (args: Record<string, unknown>) => { sent.push(args); return Promise.resolve({ id: 700 }); },
      get replyParseMode() { return undefined; },
    };
    return { sent, channel: createChannelPlugin(new Map([ [ "default", gram ] ]) as unknown as RuntimeMap) as any };
  }

  test("a numeric DM target keeps the reply id", async () => {
    const { sent, channel } = makeChannel();
    await channel.outbound.sendText({
      accountId: "default", to: "100200300", text: "в ветке", replyToId: "42",
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[ 0 ].replyToMessageId, 42);
  });

  test("a group target keeps it, as before", async () => {
    const { sent, channel } = makeChannel();
    await channel.outbound.sendText({
      accountId: "default", to: "-1001234567890", text: "в ветке", replyToId: 7,
    });
    assert.equal(sent[ 0 ].replyToMessageId, 7);
  });

  test("no reply id means no threading", async () => {
    const { sent, channel } = makeChannel();
    await channel.outbound.sendText({ accountId: "default", to: "100200300", text: "просто" });
    assert.equal(sent[ 0 ].replyToMessageId, undefined);
  });
});
