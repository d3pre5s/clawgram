import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { isSenderAllowed, resolveAccountScopes, resolveAllowFrom, resolveGroups } from "../src/helpers";

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

/**
 * `allowFrom` and `groups` are declared at the channel level as well as per
 * account, and the manifest validates them there — but only the account copies
 * were read. A channel-level allowlist therefore passed validation and then
 * admitted everyone, which is the worst way for an allowlist to fail. The two
 * config reads (`resolveAccount` and the inbound handler) were also
 * independent, so they could disagree about the same config.
 */
describe("channel-level scopes are read, and the account still wins", () => {
  const cfg = (channel: Record<string, unknown>) => ({ channels: { clawgram: channel } });

  test("a channel-level allowFrom applies to an account that declares none", () => {
    const scopes = resolveAccountScopes(cfg({ allowFrom: [ "42" ], accounts: { default: {} } }), "default");

    assert.deepEqual(scopes.allowFrom, [ "42" ]);
  });

  test("the account's own list wins, including a deliberate empty one", () => {
    assert.deepEqual(
      resolveAccountScopes(cfg({ allowFrom: [ "42" ], accounts: { default: { allowFrom: [ "7" ] } } }), "default").allowFrom,
      [ "7" ],
    );
    assert.deepEqual(
      resolveAccountScopes(cfg({ allowFrom: [ "42" ], accounts: { default: { allowFrom: [] } } }), "default").allowFrom,
      [],
    );
  });

  test("groups merge per key rather than replacing wholesale", () => {
    const scopes = resolveAccountScopes(
      cfg({
        groups: { "-1001": { enabled: true, groupPolicy: "open" }, "-1002": { enabled: true } },
        accounts: { default: { groups: { "-1002": { enabled: false } } } },
      }),
      "default",
    );

    assert.equal(scopes.groups[ "-1001" ].groupPolicy, "open", "the channel-level group survives");
    assert.equal(scopes.groups[ "-1002" ].enabled, false, "the account's override wins for its own key");
  });

  test("no scopes anywhere is still the historical wildcard", () => {
    assert.deepEqual(resolveAccountScopes(cfg({ accounts: { default: {} } }), "default").allowFrom, [ "*" ]);
    assert.deepEqual(resolveAccountScopes(undefined, "default").allowFrom, [ "*" ]);
  });
});
