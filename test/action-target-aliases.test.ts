import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";

/**
 * Core's target policy is keyed by its own action vocabulary, so every clawgram
 * action it does not know is refused before `handleAction` ever sees it — with
 * "requires a target" when no target is passed and "does not accept a target"
 * when one is. `fetch-media` hit that on 2026-08-24 and got a declaration;
 * `topics` hit the same wall on 2026-08-30 and did not, which cost the
 * bro-feedback-watch job every run until the list below covered it.
 */
const CHAT_SCOPED_PLUGIN_ACTIONS = [
  "fetch-media",
  "download-file",
  "topics",
  "forumTopics",
  "participants",
  "members",
  "chatInfo",
  "getChatInfo",
  "addMembers",
  "removeMember",
  "promoteAdmin",
  "demoteAdmin",
  "transferOwnership",
  "inviteLink",
];

describe("message action target aliases", () => {
  const channel = createChannelPlugin(new Map() as RuntimeMap) as any;

  it("declares chatId for every chat-scoped action core does not know", () => {
    const aliases = channel.actions.messageActionTargetAliases;

    for (const action of CHAT_SCOPED_PLUGIN_ACTIONS) {
      assert.ok(
        aliases?.[ action ]?.aliases?.includes("chatId"),
        `${action} does not declare chatId — core refuses the call as targetless`,
      );
    }
  });

  it("keeps the declared actions and the advertised actions in step", () => {
    const described = channel.actions.describeMessageTool({
      cfg: { channels: { clawgram: { accounts: { default: {} } } } },
      accountId: "default",
    });
    // Aliases for an action the tool never advertises are dead weight; an
    // advertised action missing from the aliases is the bug above. Only the
    // canonical spellings are advertised — the synonyms `handleAction` accepts
    // (`forumTopics`, `members`, `getChatInfo`) are declared but not listed.
    const synonyms = new Set([ "forumTopics", "members", "getChatInfo" ]);

    for (const action of CHAT_SCOPED_PLUGIN_ACTIONS) {
      if (synonyms.has(action)) {
        continue;
      }
      assert.ok(
        described.actions.includes(action),
        `${action} declares a target alias but is not advertised to the agent`,
      );
    }
  });
});
