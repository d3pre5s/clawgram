import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { isPlainObject, readNumber, readString } from "../src/util";
import { toStringId } from "../src/normalize";

/**
 * These readers existed two or three times each. Identical copies are the
 * good case: `toStringId` had drifted, so a peer that stringified to
 * `[object Object]` was rejected by the history path and accepted by the
 * client path — the same peer "found" by one and "unknown" by the other
 * (finding A12-05).
 */
describe("shared readers", () => {
  test("readString keeps only non-empty trimmed strings", () => {
    assert.equal(readString("  x  "), "x");
    assert.equal(readString("   "), undefined);
    assert.equal(readString(""), undefined);
    assert.equal(readString(5), undefined, "a number is not a string here");
    assert.equal(readString(null), undefined);
  });

  test("readNumber takes numbers and their decimal spellings", () => {
    assert.equal(readNumber(5), 5);
    assert.equal(readNumber("5"), 5);
    assert.equal(readNumber("  5.5 "), 5.5);
    assert.equal(readNumber(Number.NaN), undefined);
    assert.equal(readNumber(Infinity), undefined);
    assert.equal(readNumber("abc"), undefined);
    assert.equal(readNumber(null), undefined);
  });

  test("isPlainObject separates a params bag from an array or null", () => {
    assert.equal(isPlainObject({}), true);
    assert.equal(isPlainObject([]), false);
    assert.equal(isPlainObject(null), false);
    assert.equal(isPlainObject("x"), false);
  });

  test("toStringId refuses a whole object where an id was meant", () => {
    assert.equal(toStringId(123), "123");
    assert.equal(toStringId("abc"), "abc");
    assert.equal(toStringId({ id: 1 }), undefined, "`[object Object]` is not an id");
    assert.equal(toStringId(null), undefined);
    assert.equal(toStringId(undefined), undefined);
  });

  test("a big-integer-like id survives, since that is what GramJS hands over", () => {
    const bigish = { toString: () => "1234567890123" };
    assert.equal(toStringId(bigish), "1234567890123");
  });
});
