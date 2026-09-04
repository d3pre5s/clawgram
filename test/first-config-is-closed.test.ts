import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { buildAccountConfigFragment } from "../src/cli-core";

describe("the first config after --auth is closed, not open", () => {
  // It used to seed allowFrom ["*"], a wildcard group entry and no readChats,
  // so straight after --auth any Telegram user could DM the agent, add it to a
  // group and @mention it, and `read` reached the history of every chat the
  // personal account belongs to. A first run should not be a hole the operator
  // closes afterwards.
  const auth = { apiId: 1, apiHash: "h", sessionString: "s", selfId: "100200300" };

  test("only the authorising account may write to it", () => {
    const fragment = buildAccountConfigFragment(auth);
    assert.deepEqual(fragment.allowFrom, [ "100200300" ]);
  });

  test("no wildcard group is seeded", () => {
    const fragment = buildAccountConfigFragment(auth);
    assert.equal(fragment.groups, undefined, "groups are added deliberately, not by default");
  });

  test("history is denied everywhere, and denied explicitly", () => {
    const fragment = buildAccountConfigFragment(auth);
    // An empty array and an absent key mean opposite things for readChats:
    // absent is "no restriction". The denial has to be written down.
    assert.deepEqual(fragment.readChats, []);
  });

  test("without a known self id it is closed to everyone, not open to everyone", () => {
    const fragment = buildAccountConfigFragment({ ...auth, selfId: undefined });
    assert.deepEqual(fragment.allowFrom, []);
    assert.deepEqual(fragment.readChats, []);
  });
});
