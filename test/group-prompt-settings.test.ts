import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { resolveGroupPromptSettings, resolveGroups } from "../src/helpers";

/**
 * `skills` and `systemPrompt` on a group are passed to core as
 * `replyOptions.skillFilter` and `GroupSystemPrompt`. Two semantics matter:
 * an empty `skills` array is an answer ("no skills here"), not "unset" — the
 * same rule core applies to `agents.list[].skills: []`; and a blank system
 * prompt is unset, because core would otherwise inject an empty trusted block.
 */
describe("resolveGroupPromptSettings", () => {
  test("nothing configured → nothing set", () => {
    assert.deepEqual(resolveGroupPromptSettings(undefined), {});
    assert.deepEqual(resolveGroupPromptSettings({}), {});
    assert.deepEqual(resolveGroupPromptSettings({ enabled: true, groupPolicy: "open" }), {});
  });

  test("skills are trimmed, blanks and non-strings dropped", () => {
    assert.deepEqual(
      resolveGroupPromptSettings({ skills: [ "pm-standup", "  pm-jira ", "", 3, null ] }),
      { skillFilter: [ "pm-standup", "pm-jira" ] },
    );
  });

  test("an empty skills array stays an empty array", () => {
    assert.deepEqual(resolveGroupPromptSettings({ skills: [] }), { skillFilter: [] });
    assert.deepEqual(resolveGroupPromptSettings({ skills: [ "", "  " ] }), { skillFilter: [] });
  });

  test("skills that are not an array are ignored", () => {
    assert.deepEqual(resolveGroupPromptSettings({ skills: "pm-standup" }), {});
    assert.deepEqual(resolveGroupPromptSettings({ skills: { a: 1 } }), {});
  });

  test("systemPrompt is trimmed; blank or non-string is unset", () => {
    assert.deepEqual(resolveGroupPromptSettings({ systemPrompt: "  Только BRO.  " }), { systemPrompt: "Только BRO." });
    assert.deepEqual(resolveGroupPromptSettings({ systemPrompt: "   " }), {});
    assert.deepEqual(resolveGroupPromptSettings({ systemPrompt: 5 }), {});
  });
});

describe("resolveGroups carries prompt settings", () => {
  test("a group with skills and systemPrompt exposes them next to the old fields", () => {
    const groups = resolveGroups({
      "-1001": { enabled: true, groupPolicy: "open", allowFrom: [ "42" ], skills: [ "pm-standup" ], systemPrompt: "BRO" },
    });

    assert.deepEqual(groups[ "-1001" ], {
      enabled: true,
      groupPolicy: "open",
      allowFrom: [ "42" ],
      skillFilter: [ "pm-standup" ],
      systemPrompt: "BRO",
    });
  });

  test("a group without them exposes neither", () => {
    const groups = resolveGroups({ "*": { enabled: true } });

    assert.equal(groups[ "*" ].skillFilter, undefined);
    assert.equal(groups[ "*" ].systemPrompt, undefined);
    assert.equal(groups[ "*" ].enabled, true);
    assert.equal(groups[ "*" ].groupPolicy, "mention");
    assert.deepEqual(groups[ "*" ].allowFrom, [ "*" ]);
  });
});
