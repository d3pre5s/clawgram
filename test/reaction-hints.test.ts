import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createChannelPlugin } from "../src/channel";
import { buildReactionHintLines } from "../src/reactions";
import type { RuntimeMap } from "../src/types";

/**
 * Core builds its own `## Reactions` section, but only when `params.config` is
 * truthy in the prompt assembler — a condition this channel never met. Live
 * turns logged zero `reactionGuidance` invocations while the prompt stayed
 * byte-identical, so the hook was never called at all.
 *
 * That condition is inside the minified `openclaw` dependency and is not ours
 * to change. `messageToolHints`, computed two lines above it, is guarded only
 * by the channel resolving — so the guidance rides that path instead.
 */
describe("reaction guidance rides the message tool hints", () => {
  const hints = (reactionLevel?: unknown, accountId: string | null = "default") =>
    (createChannelPlugin(new Map() as RuntimeMap) as any).agentPrompt.messageToolHints({
      cfg: { channels: { clawgram: { accounts: { default: { reactionLevel } } } } },
      accountId,
    }) as string[];

  it("tells the agent reactions are enabled", () => {
    const text = hints("extensive").join("\n");

    assert.match(text, /Reactions are enabled for Telegram in EXTENSIVE mode/);
    assert.match(text, /react whenever it feels natural/i);
  });

  it("carries the sparing wording for minimal", () => {
    const text = hints("minimal").join("\n");

    assert.match(text, /MINIMAL mode/);
    assert.match(text, /at most 1 reaction per 5-10 exchanges/);
  });

  it("says a reaction and NO_REPLY are compatible", () => {
    // The whole point of the feature: the agent kept treating NO_REPLY as a
    // terminal step that forbids doing anything else first.
    assert.match(hints("extensive").join("\n"), /still return NO_REPLY/);
  });

  it("stays quiet about reactions when they are off", () => {
    const text = hints("off").join("\n");

    assert.doesNotMatch(text, /Reactions are enabled/);
    // The pre-existing hints must survive: this path carries all of them.
    assert.match(text, /Use clawgram to send Telegram replies/);
  });

  it("keeps every hint the channel already had", () => {
    const text = hints("extensive").join("\n");

    for (const existing of [
      "Use clawgram to send Telegram replies",
      "omit `to`/`target`",
      "Explicit targets may be @username",
      "Telegram forum topics",
      "Use the `react` action",
      "Use the `chatInfo` action",
    ]) {
      assert.ok(text.includes(existing), `lost hint: ${existing}`);
    }
  });

  it("works when core passes no account id", () => {
    assert.match(hints("extensive", null).join("\n"), /EXTENSIVE mode/);
  });

  it("survives being called with nothing at all", () => {
    // Core's type says the params are always there; a channel that throws
    // during prompt assembly would take the whole turn down with it.
    const plugin = createChannelPlugin(new Map() as RuntimeMap) as any;

    assert.doesNotThrow(() => plugin.agentPrompt.messageToolHints());
    assert.ok(plugin.agentPrompt.messageToolHints().length > 0);
  });

  it("emits nothing extra when there is no level", () => {
    assert.deepEqual(buildReactionHintLines(undefined), []);
  });
});
