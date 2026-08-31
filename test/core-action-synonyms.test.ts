import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

import { CORE_ACTION_SYNONYMS, createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";

/**
 * Core keys its target policy by its own action vocabulary, so an action
 * outside `CHANNEL_MESSAGE_ACTION_NAMES` cannot be called from the agent's
 * `message` tool at all: it is "requires a target" without one and "does not
 * accept a target" with one, and no call satisfies both.
 *
 * Advertising such an action is therefore not a harmless extra — it is a trap
 * the agent walks into. `fetch-media` sprang it on 2026-08-24, `topics` on
 * 2026-08-30, and `chatInfo` on 2026-08-31, that last one in a live chat: the
 * agent chose the descriptive spelling, both halves of the contradiction came
 * back, and the reply died as `✉️ Message failed`.
 *
 * The vocabulary is read from the installed core rather than copied here, so a
 * core release that drops a name fails this suite instead of the chat.
 */
function coreActionNames(): Set<string> {
  const dist = path.resolve(__dirname, "..", "..", "node_modules", "openclaw", "dist");
  const files = readdirSync(dist).filter((f) => f.endsWith(".js"));

  for (const file of files) {
    const source = readFileSync(path.join(dist, file), "utf8");
    const start = source.indexOf("CHANNEL_MESSAGE_ACTION_NAMES = ");
    if (start < 0) {
      continue;
    }
    const open = source.indexOf("[", start);
    const close = source.indexOf("]", open);
    const names = [ ...source.slice(open, close).matchAll(/"([^"]+)"/g) ].map((m) => m[ 1 ]);
    if (names.length > 0) {
      return new Set(names);
    }
  }

  // Not a skip: a core that hides its vocabulary is exactly when this check
  // matters most, and a silent pass would put the trap back.
  throw new Error(
    "CHANNEL_MESSAGE_ACTION_NAMES not found in node_modules/openclaw/dist — "
    + "core changed its layout; re-point this probe before trusting the suite",
  );
}

describe("advertised actions are reachable", () => {
  const channel = createChannelPlugin(new Map() as RuntimeMap) as any;
  const described = channel.actions.describeMessageTool({
    cfg: { channels: { clawgram: { accounts: { default: {} } } } },
    accountId: "default",
  });

  it("offers the agent nothing core cannot dispatch", () => {
    const core = coreActionNames();

    for (const action of described.actions) {
      assert.ok(
        core.has(action),
        `${action} is advertised but is not in core's vocabulary — the agent cannot call it, `
        + "and every attempt ends as a failed message",
      );
    }
  });

  it("keeps a core name for each descriptive action worth reaching", () => {
    for (const [ coreName, nativeName ] of Object.entries(CORE_ACTION_SYNONYMS)) {
      assert.ok(
        described.actions.includes(coreName),
        `${coreName} is the only callable spelling of ${nativeName} and is not advertised`,
      );
    }
  });

  it("still answers to the descriptive spellings for gateway RPC", async () => {
    // RPC dispatches straight to handleAction and never consults the
    // advertised list — measured on the live server on 2026-08-31, where
    // `forumTopics` answered over RPC while absent from this list. Skills and
    // scripts written against the descriptive names keep working; only the
    // agent's tool is narrowed.
    //
    // With no account configured every branch fails at the same first guard,
    // so "not the unsupported-action error" is exactly the evidence that
    // dispatch reached the handler.
    for (const nativeName of Object.values(CORE_ACTION_SYNONYMS)) {
      const error = await channel.actions.handleAction({
        action: nativeName,
        params: { chatId: "-100123" },
        cfg: { channels: { clawgram: { accounts: {} } } },
      }).then(() => null, (e: Error) => e);

      assert.ok(error, `${nativeName} unexpectedly succeeded without an account`);
      assert.ok(
        !/unsupported message action/i.test(error.message),
        `${nativeName} no longer dispatches — RPC callers would start failing`,
      );
    }
  });
});
