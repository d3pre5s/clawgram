import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createChannelPlugin } from "../src/channel";
import { resolveAgentReactionGuidance } from "../src/reactions";
import type { RuntimeMap } from "../src/types";

/**
 * Core has a whole reactions subsystem the channel has to opt into. It calls
 * `agentPrompt.reactionGuidance`, and when a channel returns a level it injects
 * a `## Reactions` section into the system prompt — "React ONLY when truly
 * relevant" for `minimal`, "react whenever it feels natural" for `extensive`.
 *
 * clawgram never implemented the hook, so that section was simply absent: the
 * agent got a `react` action buried in a 106-property tool schema and not one
 * line telling her reacting was something she does. Three rewrites of the
 * SOUL rule failed against that silence — the model had the tool and the
 * instruction and reacted only when asked point blank in a DM.
 *
 * Levels mirror the bundled Telegram channel: off / ack disable agent
 * reactions, minimal and extensive enable them with different appetite.
 */
describe("reaction guidance reaches the system prompt", () => {
  const cfgWith = (reactionLevel?: unknown) => ({
    channels: { clawgram: { accounts: { default: { reactionLevel } } } },
  });

  const guidance = (cfg: unknown, accountId: string | null = "default") =>
    (createChannelPlugin(new Map() as RuntimeMap) as any)
      .agentPrompt.reactionGuidance({ cfg, accountId });

  it("asks core for the minimal section by default", () => {
    // Absent config must still enable reactions: the whole point is that the
    // prompt stops being silent about them.
    assert.deepEqual(guidance(cfgWith(undefined)), {
      level: "minimal",
      channelLabel: "Telegram",
    });
  });

  it("passes extensive through when the owner asks for it", () => {
    assert.equal(guidance(cfgWith("extensive"))?.level, "extensive");
  });

  it("stays silent when reactions are off", () => {
    assert.equal(guidance(cfgWith("off")), undefined);
  });

  it("stays silent for ack, which is the ack emoji and not agent reactions", () => {
    assert.equal(guidance(cfgWith("ack")), undefined);
  });

  it("falls back to no agent reactions on a typo rather than guessing", () => {
    // A misspelt level must not silently become "extensive" — surprise
    // chattiness in a work chat is worse than surprise silence.
    assert.equal(guidance(cfgWith("extensiv")), undefined);
    assert.equal(guidance(cfgWith(42)), undefined);
  });

  it("still answers when the account block is missing entirely", () => {
    // Mirrors the bundled Telegram channel: an absent account reads as an
    // unset level, and unset means minimal. The guidance describes the
    // channel, not whether one particular account happens to be configured.
    assert.equal(guidance({})?.level, "minimal");
  });

  it("resolves the account itself when core passes none", () => {
    assert.equal(guidance(cfgWith("extensive"), null)?.level, "extensive");
  });

  it("names the platform the person actually sees", () => {
    // The injected text reads "Reactions are enabled for <label>"; "clawgram"
    // is our plugin id, not something the agent should repeat to people.
    assert.equal(guidance(cfgWith("minimal"))?.channelLabel, "Telegram");
  });
});

describe("reaction level normalization", () => {
  it("maps the four levels the way core does", () => {
    assert.equal(resolveAgentReactionGuidance("off"), undefined);
    assert.equal(resolveAgentReactionGuidance("ack"), undefined);
    assert.equal(resolveAgentReactionGuidance("minimal"), "minimal");
    assert.equal(resolveAgentReactionGuidance("extensive"), "extensive");
  });

  it("treats missing as minimal and invalid as off", () => {
    assert.equal(resolveAgentReactionGuidance(undefined), "minimal");
    assert.equal(resolveAgentReactionGuidance(""), "minimal");
    assert.equal(resolveAgentReactionGuidance("  minimal  "), "minimal");
    assert.equal(resolveAgentReactionGuidance("nonsense"), undefined);
  });
});
