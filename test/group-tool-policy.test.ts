import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { createChannelPlugin } from "../src/channel";
import { stripAccountScopedGroupId } from "../src/helpers";
import type { RuntimeMap } from "../src/types";

/**
 * Core resolves a group's tool policy from the session key, and the group id
 * it hands a channel plugin is the scoped peer id this channel builds —
 * `<accountId>:<chatId>` — not the bare chat id that keys `groups` in the
 * config. Without the hook core would look up `groups["default:-100…"]`,
 * find nothing, and the policy would silently not apply.
 */
describe("stripAccountScopedGroupId", () => {
  test("strips this account's prefix", () => {
    assert.equal(stripAccountScopedGroupId("default:-1001234567890", "default"), "-1001234567890");
    assert.equal(stripAccountScopedGroupId("work:-1001234567890", "work"), "-1001234567890");
  });

  test("a bare chat id passes through", () => {
    assert.equal(stripAccountScopedGroupId("-1001234567890", "default"), "-1001234567890");
  });

  test("a missing account id means the default account", () => {
    assert.equal(stripAccountScopedGroupId("default:-1001234567890", undefined), "-1001234567890");
    assert.equal(stripAccountScopedGroupId("default:-1001234567890", null), "-1001234567890");
  });

  test("another account's prefix is not ours to strip", () => {
    assert.equal(stripAccountScopedGroupId("work:-1001234567890", "default"), "work:-1001234567890");
  });

  test("empty input is undefined", () => {
    assert.equal(stripAccountScopedGroupId("", "default"), undefined);
    assert.equal(stripAccountScopedGroupId("   ", "default"), undefined);
    assert.equal(stripAccountScopedGroupId(undefined, "default"), undefined);
    assert.equal(stripAccountScopedGroupId(null, "default"), undefined);
  });
});

describe("groups.resolveToolPolicy hook", () => {
  const cfg = {
    channels: {
      clawgram: {
        accounts: {
          default: {
            groups: {
              "-1001": {
                tools: { deny: [ "exec" ] },
                toolsBySender: { "id:42": { allow: [ "read" ] } },
              },
              "*": { tools: { deny: [ "browser" ] } },
            },
          },
        },
      },
    },
  };
  const channel = createChannelPlugin(new Map() as RuntimeMap) as any;
  const hook = channel.groups?.resolveToolPolicy as (ctx: Record<string, unknown>) => unknown;

  test("the hook is declared", () => {
    assert.equal(typeof hook, "function");
  });

  test("resolves the scoped id core passes to the group's tools", () => {
    assert.deepEqual(hook({ cfg, groupId: "default:-1001", accountId: "default" }), { deny: [ "exec" ] });
  });

  test("resolves a bare chat id the same way", () => {
    assert.deepEqual(hook({ cfg, groupId: "-1001", accountId: "default" }), { deny: [ "exec" ] });
  });

  test("falls back to the * group", () => {
    assert.deepEqual(hook({ cfg, groupId: "default:-1002", accountId: "default" }), { deny: [ "browser" ] });
  });

  test("toolsBySender wins for that sender", () => {
    assert.deepEqual(hook({ cfg, groupId: "default:-1001", accountId: "default", senderId: "42" }), { allow: [ "read" ] });
    assert.deepEqual(hook({ cfg, groupId: "default:-1001", accountId: "default", senderId: "43" }), { deny: [ "exec" ] });
  });

  test("a missing account id resolves against the default account", () => {
    assert.deepEqual(hook({ cfg, groupId: "default:-1001" }), { deny: [ "exec" ] });
  });

  test("top-level groups work when the account has none", () => {
    const topLevel = {
      channels: { clawgram: { accounts: { default: {} }, groups: { "-1003": { tools: { alsoAllow: [ "lobster" ] } } } } },
    };

    assert.deepEqual(hook({ cfg: topLevel, groupId: "default:-1003", accountId: "default" }), { alsoAllow: [ "lobster" ] });
  });

  test("no tools anywhere → undefined, so core keeps the agent policy", () => {
    const plain = { channels: { clawgram: { accounts: { default: { groups: { "-1001": { enabled: true } } } } } } };

    assert.equal(hook({ cfg: plain, groupId: "default:-1001", accountId: "default" }), undefined);
    assert.equal(hook({ cfg: {}, groupId: "default:-1001", accountId: "default" }), undefined);
    assert.equal(hook({ cfg, groupId: "", accountId: "default" }), undefined);
  });
});
