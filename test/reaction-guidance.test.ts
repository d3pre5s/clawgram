import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { resolveAgentReactionGuidance } from "../src/reactions";

/**
 * `reactionLevel` used to answer core's `agentPrompt.reactionGuidance` hook.
 * That hook is gone — core never called it for this channel, proven by zero
 * logged invocations against a byte-identical prompt — but the config key
 * survived it and now decides whether the channel reacts on its own when the
 * agent stays silent. The mapping still mirrors the bundled Telegram channel
 * so the same value means the same thing in both.
 */
describe("reaction level normalization", () => {
  it("maps the four levels the way core does", () => {
    assert.equal(resolveAgentReactionGuidance("off"), undefined);
    assert.equal(resolveAgentReactionGuidance("ack"), undefined);
    assert.equal(resolveAgentReactionGuidance("minimal"), "minimal");
    assert.equal(resolveAgentReactionGuidance("extensive"), "extensive");
  });

  it("treats missing as minimal and invalid as off", () => {
    // A misspelt level must not silently become "extensive" — surprise
    // chattiness in a work chat is worse than surprise silence.
    assert.equal(resolveAgentReactionGuidance(undefined), "minimal");
    assert.equal(resolveAgentReactionGuidance(""), "minimal");
    assert.equal(resolveAgentReactionGuidance("  minimal  "), "minimal");
    assert.equal(resolveAgentReactionGuidance("nonsense"), undefined);
    assert.equal(resolveAgentReactionGuidance(42), undefined);
  });
});
