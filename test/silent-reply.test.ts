import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  SILENT_REPLY_TOKEN,
  isSilentReplyText,
  prefixReplyTextToAddress,
  stripSilentReplyToken,
} from "../src/helpers";

describe("SILENT_REPLY_TOKEN", () => {
  test("matches the token OpenClaw core uses", () => {
    assert.equal(SILENT_REPLY_TOKEN, "NO_REPLY");
  });
});

describe("stripSilentReplyToken", () => {
  test("removes a payload that is only the token", () => {
    for (const value of [ "NO_REPLY", "no_reply", "No_Reply", "  NO_REPLY  " ]) {
      assert.equal(stripSilentReplyToken(value), "", `expected ${value} to strip to empty`);
    }
  });

  test("removes a leading token glued to the following text", () => {
    assert.equal(
      stripSilentReplyToken("NO_REPLYThe user is just chatting"),
      "The user is just chatting",
    );
  });

  test("removes repeated leading tokens", () => {
    assert.equal(stripSilentReplyToken("NO_REPLY NO_REPLY actual answer"), "actual answer");
  });

  test("removes a trailing token from mixed content", () => {
    assert.equal(stripSilentReplyToken("Готово, задача закрыта. NO_REPLY"), "Готово, задача закрыта.");
  });

  test("keeps the token when it is part of the sentence", () => {
    const text = "Токен NO_REPLY означает молчание";
    assert.equal(stripSilentReplyToken(text), text);
  });

  test("leaves ordinary replies untouched", () => {
    assert.equal(stripSilentReplyToken("  Привет!  "), "Привет!");
  });
});

describe("isSilentReplyText", () => {
  test("is true only when nothing visible remains", () => {
    assert.equal(isSilentReplyText("NO_REPLY"), true);
    assert.equal(isSilentReplyText("no_reply"), true);
    assert.equal(isSilentReplyText("NO_REPLY still thinking"), false);
    assert.equal(isSilentReplyText("Привет!"), false);
  });

  test("is false for empty input", () => {
    assert.equal(isSilentReplyText(""), false);
    assert.equal(isSilentReplyText(undefined), false);
  });
});

describe("silent token never reaches the reply address prefix", () => {
  // Regression: a silent reply in a group was delivered as "@user, NO_REPLY".
  // The prefix is applied unconditionally, so suppression has to happen before it.
  test("a bare token produces no visible text to address", () => {
    const outbound = "NO_REPLY";
    const visible = stripSilentReplyToken(outbound);

    assert.equal(visible, "");
    assert.equal(
      prefixReplyTextToAddress(outbound, "@user"),
      "@user, NO_REPLY",
      "prefixing an unsuppressed token is exactly the bug being guarded against",
    );
  });

  test("mixed content is addressed without the token", () => {
    const visible = stripSilentReplyToken("Статус обновлён. NO_REPLY");

    assert.equal(prefixReplyTextToAddress(visible, "@user"), "@user, Статус обновлён.");
  });
});
