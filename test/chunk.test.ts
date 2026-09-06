import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { chunkTelegramText, TELEGRAM_CAPTION_LIMIT, TELEGRAM_TEXT_LIMIT } from "../src/chunk";

describe("chunkTelegramText (B5-03)", () => {
  it("leaves short text alone and never exceeds the limit", () => {
    assert.deepEqual(chunkTelegramText("привет"), [ "привет" ]);
    const long = Array.from({ length: 30 }, (_, i) => `Абзац ${i} ` + "слово ".repeat(40)).join("\n\n");
    const chunks = chunkTelegramText(long);
    assert.ok(chunks.length > 1);
    for (const c of chunks) assert.ok(Array.from(c).length <= TELEGRAM_TEXT_LIMIT, `chunk of ${c.length}`);
    assert.equal(chunks.join("\n\n").replace(/\s+/g, " "), long.replace(/\s+/g, " "), "nothing lost");
  });

  it("prefers paragraph breaks, then line breaks, and hard-cuts a wall of text", () => {
    const paragraphs = [ "а".repeat(3000), "б".repeat(3000) ].join("\n\n");
    assert.deepEqual(chunkTelegramText(paragraphs), [ "а".repeat(3000), "б".repeat(3000) ]);
    const wall = "в".repeat(TELEGRAM_TEXT_LIMIT * 2 + 10);
    const parts = chunkTelegramText(wall);
    assert.equal(parts.length, 3);
    assert.equal(Array.from(parts[0]).length, TELEGRAM_TEXT_LIMIT);
  });

  it("counts code points, not UTF-16 units, and honours a caption limit", () => {
    const emoji = "😀".repeat(1500);
    const parts = chunkTelegramText(emoji, TELEGRAM_CAPTION_LIMIT);
    assert.equal(parts.length, 2);
    assert.equal(Array.from(parts[0]).length, TELEGRAM_CAPTION_LIMIT);
  });
});
