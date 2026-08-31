import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";

/**
 * `capabilities.reactions: true` is a promise made to the Gateway: the agent
 * may reach for a reaction instead of a message. Until 2.2.0 the flag was set
 * and nothing implemented it, so the promise failed at the worst moment —
 * while the agent was acting. These tests tie the flag to the action, in both
 * directions, so the two cannot drift apart again.
 */
describe("reaction capability matches the implementation", () => {
  const channel = createChannelPlugin(new Map() as RuntimeMap) as any;

  const describeTool = () => channel.actions.describeMessageTool({
    cfg: { channels: { clawgram: { accounts: { default: {} } } } },
    accountId: "default",
  });

  it("advertises reactions in capabilities", () => {
    assert.equal(channel.capabilities.reactions, true);
  });

  it("offers a react action whenever reactions are advertised", () => {
    if (!channel.capabilities.reactions) {
      return; // flag honestly off — nothing to promise
    }

    const described = describeTool();
    assert.ok(described, "expected the message tool to be described for a configured account");
    assert.ok(
      described.actions.includes("react"),
      `capabilities.reactions is true but the tool offers only: ${described.actions.join(", ")}`,
    );
  });

  it("keeps the actions the channel already had", () => {
    const described = describeTool();

    // `member-info` is core's name for `participants`; `joins` has none and
    // is gateway-only, so the tool must not offer it.
    for (const action of [ "send", "read", "member-info" ]) {
      assert.ok(described.actions.includes(action), `lost the ${action} action`);
    }
  });

  it("refuses an unknown action rather than treating it as a send", async () => {
    await assert.rejects(
      () => channel.actions.handleAction({
        action: "definitely-not-an-action",
        params: {},
        cfg: { channels: { clawgram: { accounts: { default: {} } } } },
        accountId: "default",
      }),
      /unsupported message action/,
    );
  });

  // A dry run must answer without touching Telegram — there is no runtime in
  // this map, so reaching the network would throw "runtime not found".
  it("answers a dry-run reaction without a runtime", async () => {
    const result = await channel.actions.handleAction({
      action: "react",
      params: { chatId: "-100123", messageId: 42, emoji: "👍" },
      cfg: { channels: { clawgram: { accounts: { default: {} } } } },
      accountId: "default",
      dryRun: true,
    });

    const payload = JSON.parse(typeof result === "string" ? result : result.content?.[ 0 ]?.text ?? "{}");
    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.messageId, 42);
    assert.equal(payload.removed, false);
  });

  it("validates arguments before it needs a runtime", async () => {
    await assert.rejects(
      () => channel.actions.handleAction({
        action: "react",
        params: { chatId: "-100123", emoji: "👍" },
        cfg: { channels: { clawgram: { accounts: { default: {} } } } },
        accountId: "default",
      }),
      /requires a messageId/,
    );
  });
});
