import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { normalizeParseMode } from "../src/helpers";

/**
 * parseMode reaches GramJS and therefore a live human's screen: an unknown
 * mode must fail at the action boundary, not silently deliver markup as
 * literal text. Absence must keep the pre-2.3.0 plain-text behaviour for
 * every existing caller.
 */
describe("normalizeParseMode", () => {
  it("absent, null and empty mean plain text — the pre-2.3.0 behaviour", () => {
    assert.equal(normalizeParseMode(undefined), undefined);
    assert.equal(normalizeParseMode(null), undefined);
    assert.equal(normalizeParseMode(""), undefined);
  });

  it("accepts markdown under both spellings, case-insensitively", () => {
    assert.equal(normalizeParseMode("md"), "markdown");
    assert.equal(normalizeParseMode("markdown"), "markdown");
    assert.equal(normalizeParseMode("Markdown"), "markdown");
  });

  it("accepts html", () => {
    assert.equal(normalizeParseMode("html"), "html");
    assert.equal(normalizeParseMode("HTML"), "html");
  });

  it("refuses anything else loudly", () => {
    assert.throws(() => normalizeParseMode("bbcode"), /invalid parseMode/);
    assert.throws(() => normalizeParseMode("markdownv2"), /invalid parseMode/);
  });
});

import { resolveReplyParseMode } from "../src/helpers";

describe("resolveReplyParseMode (reply pipeline, 2.3.1)", () => {
  const withMode = (m: unknown) => ({ channels: { clawgram: { accounts: { default: { replyParseMode: m } } } } });

  it("absent means plain text — pre-2.3.1 behaviour", () => {
    assert.equal(resolveReplyParseMode({ channels: { clawgram: { accounts: { default: {} } } } }, "default"), undefined);
    assert.equal(resolveReplyParseMode({}, "default"), undefined);
  });

  it("reads markdown and html from the account config", () => {
    assert.equal(resolveReplyParseMode(withMode("markdown"), "default"), "markdown");
    assert.equal(resolveReplyParseMode(withMode("md"), "default"), "markdown");
    assert.equal(resolveReplyParseMode(withMode("html"), "default"), "html");
  });

  it("falls back to the channel level when no account entry exists", () => {
    assert.equal(resolveReplyParseMode({ channels: { clawgram: { replyParseMode: "html" } } }, "default"), "html");
  });

  it("throws on an invalid value at config-read time", () => {
    assert.throws(() => resolveReplyParseMode(withMode("bbcode"), "default"), /invalid parseMode/);
  });
});

import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";

/**
 * resolveAccount builds PluginConfig field by field, so a setting missing
 * from that list is silently dropped between a valid config and the client
 * that reads it — which is exactly how 2.3.1 shipped a working, deployed and
 * completely inert replyParseMode.
 */
describe("resolveAccount carries the reply format through", () => {
  const channel = createChannelPlugin(new Map() as RuntimeMap) as any;
  const cfgWith = (mode: unknown) => ({
    channels: { clawgram: { accounts: { default: {
      apiId: 1, apiHash: "h", sessionString: "s", allowFrom: ["*"], replyParseMode: mode,
    } } } },
  });

  it("keeps replyParseMode on the resolved account", () => {
    const resolved = channel.config.resolveAccount(cfgWith("markdown"), "default");
    assert.equal(resolved.replyParseMode, "markdown");
  });

  it("leaves it undefined when unset", () => {
    const resolved = channel.config.resolveAccount(
      { channels: { clawgram: { accounts: { default: { apiId: 1, apiHash: "h", sessionString: "s" } } } } },
      "default",
    );
    assert.equal(resolved.replyParseMode, undefined);
  });
});
