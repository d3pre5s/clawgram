import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";

/**
 * The resolver has unit tests; this covers the wiring, which is what actually
 * broke. `replyParseMode` reached the reply pipeline and not the `send`
 * action, so an account configured for HTML rendered replies as HTML and
 * tool-driven sends as plain text — and a long answer arrived in a work chat
 * with `**Вне каталога — Telegram**` showing (2026-08-09, 22:30 UTC).
 *
 * Testing the helper alone would not have caught that: the helper was fine and
 * simply was not called here.
 */
function harness(accountConfig: Record<string, unknown>) {
  const sends: Array<Record<string, unknown>> = [];
  const runtimes = new Map([ [ "default", {
    sendText: async (args: Record<string, unknown>) => {
      sends.push(args);
      return { id: 1 };
    },
  } ] ]) as unknown as RuntimeMap;

  const channel = createChannelPlugin(runtimes) as any;
  const cfg = { channels: { clawgram: { accounts: { default: accountConfig } } } };

  const send = (params: Record<string, unknown>) =>
    channel.actions.handleAction({ action: "send", params, cfg, accountId: "default" });

  return { sends, send };
}

describe("send action inherits the account parse mode", () => {
  test("an omitted parseMode uses the configured mode", async () => {
    const h = harness({ replyParseMode: "html" });
    await h.send({ to: "-100123", text: "<b>жирный</b>" });

    assert.equal(h.sends.length, 1);
    assert.equal(h.sends[ 0 ].parseMode, "html");
  });

  test("an explicit parseMode still wins", async () => {
    const h = harness({ replyParseMode: "html" });
    await h.send({ to: "-100123", text: "**жирный**", parseMode: "markdown" });

    assert.equal(h.sends[ 0 ].parseMode, "markdown");
  });

  test("an empty parseMode still means send it exactly as typed", async () => {
    // The escape hatch has to survive: a message about markup, or one holding
    // characters HTML would choke on, must be sendable raw. Since 2.15.0 the
    // hatch resolves to "none", not undefined — undefined at the GramJS
    // boundary means GramJS's own default markdown parser, which would still
    // have eaten `**` out of a message that asked for "exactly as typed".
    const h = harness({ replyParseMode: "html" });
    await h.send({ to: "-100123", text: "5 < 7 & 8 > 6", parseMode: "" });

    assert.equal(h.sends[ 0 ].parseMode, "none");
  });

  test("an unconfigured account still sends plain text", async () => {
    const h = harness({});
    await h.send({ to: "-100123", text: "просто текст" });

    assert.equal(h.sends[ 0 ].parseMode, undefined);
  });
});
