import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { hasExplicitTelegramMention, resolveGroups } from "../src/helpers";

/**
 * `tag` is the strictest rung of the group ladder: only an `@username` or a
 * reply wakes the agent, never the name it answers to.
 *
 * It exists for one measured situation. In the owner's 1041-person community
 * chat the name «Тина» turns up in conversation about her constantly, while
 * over 15–17.08.2026 exactly one message all week actually tagged her. Under
 * `mention` every one of those conversational uses would start a full turn.
 */
describe("hasExplicitTelegramMention", () => {
  const self = "vorontina";

  test("the @username tags her", () => {
    assert.equal(hasExplicitTelegramMention({ selfUsername: self, text: "@vorontina доработай файл" }), true);
    assert.equal(hasExplicitTelegramMention({ selfUsername: self, text: "спасибо @VoronTina" }), true);
  });

  test("a leading @ is tolerated on the configured username", () => {
    assert.equal(hasExplicitTelegramMention({ selfUsername: "@vorontina", text: "@vorontina тут?" }), true);
  });

  test("the name alone does not", () => {
    // Every one of these woke her under `mention` on 17.08.
    for (const text of [
      "Меня точно заменили на Тину...",
      "надо же хоть в чем-то быть лучше Тины",
      "тина, заведи страничку",
      "а вот тина и начала нас пинать",
    ]) {
      assert.equal(hasExplicitTelegramMention({ selfUsername: self, text }), false, text);
    }
  });

  test("somebody else's tag does not", () => {
    assert.equal(hasExplicitTelegramMention({ selfUsername: self, text: "@ed_ratkevich @kvedrov сюда" }), false);
  });

  // A prefix match would fire for @vorontina_bot, a different account.
  test("a longer username that starts with hers does not", () => {
    assert.equal(hasExplicitTelegramMention({ selfUsername: self, text: "@vorontina_bot глянь" }), false);
  });

  test("Telegram's own mentioned flag counts", () => {
    assert.equal(
      hasExplicitTelegramMention({ selfUsername: self, text: "глянь пожалуйста", message: { mentioned: true } }),
      true,
    );
  });

  test("a mention entity pointing at her counts, one pointing elsewhere does not", () => {
    const entities = (offset: number, length: number) => [ { className: "MessageEntityMention", offset, length } ];
    assert.equal(
      hasExplicitTelegramMention({ selfUsername: self, text: "@vorontina тут", message: { entities: entities(0, 11) } }),
      true,
    );
    assert.equal(
      hasExplicitTelegramMention({ selfUsername: self, text: "@kvedrov тут", message: { entities: entities(0, 8) } }),
      false,
    );
  });

  // Without a known username there is no `@` to look for, and guessing from
  // the display name is exactly the loose matching this rung exists to avoid.
  test("an unknown self username matches nothing", () => {
    assert.equal(hasExplicitTelegramMention({ selfUsername: undefined, text: "@vorontina тут?" }), false);
    assert.equal(hasExplicitTelegramMention({ selfUsername: "  ", text: "@vorontina тут?" }), false);
  });
});

describe("resolveGroups: the tag rung", () => {
  const groupsOf = (groupPolicy: unknown) =>
    resolveGroups({ "-100": { enabled: true, groupPolicy } })[ "-100" ].groupPolicy;

  test("tag is carried through", () => {
    assert.equal(groupsOf("tag"), "tag");
  });

  test("the other two rungs are unchanged", () => {
    assert.equal(groupsOf("open"), "open");
    assert.equal(groupsOf("mention"), "mention");
  });

  // A typo must not silently widen or narrow a chat: `mention` is what this
  // channel has always defaulted to.
  test("anything unrecognised lands on mention", () => {
    for (const value of [ "tags", "TAG", "", undefined, null, 7, {} ]) {
      assert.equal(groupsOf(value), "mention", String(value));
    }
  });
});
