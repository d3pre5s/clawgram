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
