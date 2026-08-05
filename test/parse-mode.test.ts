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
