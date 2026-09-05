import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { ExpiringMap } from "../src/expiring-map";

/**
 * Two of the three per-message maps swept nothing.
 *
 * An entry lived until someone read it back, and plenty are never read: a
 * mention nobody answers, a send whose echo never comes. The gateway is
 * restarted rarely by design, so the leak was slow and permanent (A6-16).
 */
describe("ExpiringMap", () => {
  test("an entry disappears once its TTL passes, unread", () => {
    const map = new ExpiringMap<string>(1000);
    map.set("k", "v", 0);
    assert.equal(map.get("k", 999), "v");
    assert.equal(map.get("k", 1000), undefined, "TTL is inclusive at the boundary");
    assert.equal(map.size, 0, "and the entry is gone, not just hidden");
  });

  test("writing sweeps what expired, so a busy map does not grow", () => {
    const map = new ExpiringMap<string>(100);
    for (let i = 0; i < 50; i += 1) {
      map.set(`old-${i}`, "v", 0);
    }
    assert.equal(map.size, 50);
    map.set("new", "v", 1000);
    assert.equal(map.size, 1, "the sweep ran on write, not on read");
  });

  test("the count cap covers what time cannot: many keys inside one window", () => {
    const map = new ExpiringMap<string>(60_000, 3);
    map.set("a", "v", 0);
    map.set("b", "v", 1);
    map.set("c", "v", 2);
    map.set("d", "v", 3);
    assert.equal(map.size, 3);
    assert.equal(map.get("a", 4), undefined, "the entry expiring soonest went first");
    assert.equal(map.get("d", 4), "v");
  });

  test("take reads and removes in one step", () => {
    const map = new ExpiringMap<string>(1000);
    map.set("k", "v", 0);
    assert.equal(map.take("k", 1), "v");
    assert.equal(map.get("k", 1), undefined);
  });

  test("take on an expired entry removes it and answers undefined", () => {
    const map = new ExpiringMap<string>(10);
    map.set("k", "v", 0);
    assert.equal(map.take("k", 100), undefined);
    assert.equal(map.size, 0);
  });

  test("a rewritten key gets a fresh life, not the old one", () => {
    const map = new ExpiringMap<string>(100);
    map.set("k", "first", 0);
    map.set("k", "second", 50);
    assert.equal(map.get("k", 120), "second", "TTL counts from the last write");
    assert.equal(map.get("k", 151), undefined);
  });
});
