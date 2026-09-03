import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { hasExplicitTelegramMention, resolveAddressableText } from "../src/helpers";

/**
 * The mention gate used to read the whole assembled body, attachment reading
 * included. A screenshot of a chat where somebody else wrote `@tina_bot`, or a
 * photo of a poster carrying the name, therefore counted as being addressed —
 * the vision model's words were treated as the sender's.
 *
 * A transcript is different in kind: it is the sender speaking, so "Тина,
 * посмотри" said aloud has to keep working.
 */
describe("only the sender's own words can address the agent", () => {
  test("a vision description cannot, however clearly it names her", () => {
    const addressable = resolveAddressableText({
      messageText: "",
      bodyText: "[изображение] Скриншот чата: @tina_bot сделай отчёт",
      understanding: "description",
    });

    assert.equal(addressable, "");
    assert.equal(
      hasExplicitTelegramMention({ selfUsername: "tina_bot", text: addressable, message: { entities: [] } }),
      false,
    );
  });

  test("a caption on that same image still addresses her", () => {
    const addressable = resolveAddressableText({
      messageText: "@tina_bot глянь",
      bodyText: "@tina_bot глянь\n\n[изображение] Скриншот чата",
      understanding: "description",
    });

    assert.equal(addressable, "@tina_bot глянь");
    assert.equal(
      hasExplicitTelegramMention({ selfUsername: "tina_bot", text: addressable, message: { entities: [] } }),
      true,
    );
  });

  test("a voice transcript is the sender speaking, so it still counts", () => {
    const addressable = resolveAddressableText({
      messageText: "",
      bodyText: "[голосовое] @tina_bot посмотри задачу",
      understanding: "transcript",
    });

    assert.equal(addressable, "[голосовое] @tina_bot посмотри задачу");
    assert.equal(
      hasExplicitTelegramMention({ selfUsername: "tina_bot", text: addressable, message: { entities: [] } }),
      true,
    );
  });

  test("a plain message is unchanged", () => {
    assert.equal(
      resolveAddressableText({ messageText: "привет", bodyText: "привет", understanding: undefined }),
      "привет",
    );
    assert.equal(resolveAddressableText({}), "");
  });
});
