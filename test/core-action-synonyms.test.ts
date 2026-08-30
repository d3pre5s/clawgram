import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { CORE_ACTION_SYNONYMS, createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";

/**
 * Core keys its target policy by its own action vocabulary, so a clawgram
 * action outside that vocabulary is refused before `handleAction` ever sees it
 * — "requires a target" without one, "does not accept a target" with one.
 * `messageActionTargetAliases` does not rescue it: core resolves the channel
 * through `getBootstrapChannelPlugin`, which only knows bundled channels.
 *
 * The one thing that works is a second name core already knows. `fetch-media`
 * got `download-file` on 2026-08-24; `topics` had nothing until 2026-08-30,
 * when `bro-feedback-watch` failed every fifteen minutes because the agent
 * could not list a single forum topic.
 */
describe("core action synonyms", () => {
  const channel = createChannelPlugin(new Map() as RuntimeMap) as any;
  const described = channel.actions.describeMessageTool({
    cfg: { channels: { clawgram: { accounts: { default: {} } } } },
    accountId: "default",
  });

  it("advertises the core name for every action that needs one", () => {
    for (const coreName of Object.keys(CORE_ACTION_SYNONYMS)) {
      assert.ok(
        described.actions.includes(coreName),
        `${coreName} is not advertised — the agent never learns the reachable spelling`,
      );
    }
  });

  it("keeps the clawgram name advertised beside it", () => {
    // The native spelling still works through the gateway RPC, which skips
    // core's target policy entirely, and it is what every existing cron
    // prompt and skill was written against.
    for (const nativeName of Object.values(CORE_ACTION_SYNONYMS)) {
      assert.ok(
        described.actions.includes(nativeName),
        `${nativeName} disappeared from the advertised actions`,
      );
    }
  });

  it("still declares chatId, for the day core reads plugin channels", () => {
    const aliases = channel.actions.messageActionTargetAliases;

    for (const action of [ "fetch-media", "download-file" ]) {
      assert.ok(
        aliases?.[ action ]?.aliases?.includes("chatId"),
        `${action} does not declare chatId`,
      );
    }
  });
});
