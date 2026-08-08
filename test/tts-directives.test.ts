import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { stripTtsDirectives } from "../src/helpers";

/**
 * Core strips `[[tts:...]]` markup from visible text before a channel ever
 * sees it — but only on the normal reply path. The transcript fallback reads
 * the assistant's raw text straight out of the session file and sends that,
 * so on 2026-08-08 a group got the literal markup in the chat:
 *
 *   @top1ceo, [[tts:text]]Привет, Вася! …[[/tts:text]]
 *
 * The fallback exists to rescue a reply that would otherwise vanish. It must
 * therefore rescue it as something a human can read: keep the spoken words,
 * drop the machinery.
 */
describe("TTS directives never reach a human", () => {
  it("unwraps a spoken block and keeps its words", () => {
    assert.equal(
      stripTtsDirectives("[[tts:text]]Привет, Вася![[/tts:text]]"),
      "Привет, Вася!",
    );
  });

  it("keeps text that lives outside the block", () => {
    assert.equal(
      stripTtsDirectives("Коротко по проекту:\n[[tts:text]]всё ровно[[/tts:text]]"),
      "Коротко по проекту:\nвсё ровно",
    );
  });

  it("removes a settings directive entirely", () => {
    assert.equal(
      stripTtsDirectives("Готово. [[tts:speakerVoiceId=abc speed=1.1]]"),
      "Готово.",
    );
  });

  it("removes the audio_as_voice directive core also accepts", () => {
    assert.equal(
      stripTtsDirectives("[[tts:text]]Привет[[/tts:text]] [[audio_as_voice]]"),
      "Привет",
    );
  });

  it("survives an unmatched closing tag", () => {
    // A truncated reply can end mid-markup; half a tag must not ship either.
    assert.equal(stripTtsDirectives("Привет[[/tts:text]]"), "Привет");
  });

  it("leaves ordinary text alone, brackets included", () => {
    const text = "Смотри [этот документ](https://example.com) — там [[важное]] выделено";
    assert.equal(stripTtsDirectives(text), text);
  });

  it("reports an empty result when the reply was nothing but markup", () => {
    // Caller must be able to tell "nothing to say" from "something to say":
    // sending an empty message is worse than sending none.
    assert.equal(stripTtsDirectives("[[tts:speed=1.1]]"), "");
    assert.equal(stripTtsDirectives("   [[audio_as_voice]]  "), "");
  });

  it("does not mangle a reply that has no directives at all", () => {
    assert.equal(stripTtsDirectives("  Просто ответ  "), "Просто ответ");
  });
});
