import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { resolveStateDir } from "../src/state-dir";
import { resolveJoinsJournalPath } from "../src/joins";

describe("state directory is one answer for the whole plugin", () => {
  // An isolated Gateway is the layout mandated for every local verification:
  // never touch ~/.openclaw, always set OPENCLAW_STATE_DIR. The media helper
  // honoured it, the joins journal did not, so a test instance appended to the
  // live journal and rewrote it at 2000 records (A6-07).
  test("prefers OPENCLAW_STATE_DIR", () => {
    assert.equal(resolveStateDir({ OPENCLAW_STATE_DIR: "/srv/isolated" }), "/srv/isolated");
    assert.equal(resolveStateDir({ OPENCLAW_STATE_DIR: "  /srv/isolated  " }), "/srv/isolated");
  });

  test("falls back to the home directory when it is unset or blank", () => {
    assert.equal(resolveStateDir({}), join(homedir(), ".openclaw"));
    assert.equal(resolveStateDir({ OPENCLAW_STATE_DIR: "   " }), join(homedir(), ".openclaw"));
  });

  test("the joins journal lands under the isolated state dir", () => {
    const previous = process.env.OPENCLAW_STATE_DIR;
    process.env.OPENCLAW_STATE_DIR = "/srv/isolated";
    try {
      assert.equal(
        resolveJoinsJournalPath({}, "default"),
        join("/srv/isolated", "state", "clawgram", "joins-default.jsonl"),
      );
    } finally {
      if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR;
      else process.env.OPENCLAW_STATE_DIR = previous;
    }
  });

  test("an explicit joinsJournalPath still wins", () => {
    assert.equal(resolveJoinsJournalPath({ joinsJournalPath: "/tmp/j.jsonl" }, "default"), "/tmp/j.jsonl");
  });
});
