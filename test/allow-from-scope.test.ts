import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { isSenderAllowed, resolveAllowFrom, resolveGroups } from "../src/helpers";

/**
 * `allowFrom: []` used to mean "everyone".
 *
 * An operator who empties the list to shut an account off got the opposite of
 * what they asked for, and the sibling scopes disagree with it in writing:
 * README documents `readChats: []` and `manageChats: []` as deny. The wildcard
 * now belongs to an absent key (a fresh install stays usable) and to an
 * explicit `"*"` — nothing else.
 */

describe("an empty allowFrom denies rather than admits", () => {
  test("absent or unreadable stays the historical wildcard", () => {
    assert.deepEqual(resolveAllowFrom(undefined), [ "*" ]);
    assert.deepEqual(resolveAllowFrom(null), [ "*" ]);
    assert.deepEqual(resolveAllowFrom({}), [ "*" ]);
  });

  test("an explicit wildcard is still a wildcard", () => {
    assert.deepEqual(resolveAllowFrom("*"), [ "*" ]);
    assert.deepEqual(resolveAllowFrom([ "*" ]), [ "*" ]);
  });

  test("an empty or blank list denies everyone", () => {
    assert.deepEqual(resolveAllowFrom([]), []);
    assert.deepEqual(resolveAllowFrom([ "", "  " ]), []);
    assert.deepEqual(resolveAllowFrom(""), []);
    assert.deepEqual(resolveAllowFrom("   "), []);
  });

  test("a populated list is unchanged", () => {
    assert.deepEqual(resolveAllowFrom([ " 42 ", "@handle" ]), [ "42", "@handle" ]);
    assert.deepEqual(resolveAllowFrom(42), [ "42" ]);
  });

  test("the deny reaches the gate: nobody matches an empty list", () => {
    assert.equal(isSenderAllowed({ allowFrom: [], senderId: "42" }), false);
    assert.equal(isSenderAllowed({ allowFrom: [], senderUsername: "handle" }), false);
    assert.equal(isSenderAllowed({ allowFrom: [ "42" ], senderId: "42" }), true);
    assert.equal(isSenderAllowed({ allowFrom: [ "*" ], senderId: "42" }), true);
  });

  test("a group with an empty allowFrom answers nobody, not everybody", () => {
    const groups = resolveGroups({ "-1001": { enabled: true, allowFrom: [] } });

    assert.deepEqual(groups[ "-1001" ].allowFrom, []);
    assert.equal(isSenderAllowed({ allowFrom: groups[ "-1001" ].allowFrom, senderId: "42" }), false);
  });

  test("a group without the key keeps the wildcard", () => {
    const groups = resolveGroups({ "-1002": { enabled: true } });

    assert.deepEqual(groups[ "-1002" ].allowFrom, [ "*" ]);
  });
});
