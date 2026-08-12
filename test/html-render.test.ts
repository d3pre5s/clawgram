import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { HTMLParser } from "telegram/extensions/html";

import { renderTelegramHtml } from "../src/html-render";

/**
 * Every assertion here runs the renderer's output through GramJS's own HTML
 * parser — the code that actually executes on the send path. Checking the
 * HTML string alone would prove nothing: 2026-08-12 00:13 UTC a monthly
 * report went to a work chat with every `**` showing precisely because the
 * layers each looked right in isolation.
 */
function parsed(input: string): { text: string; entities: Array<{ type: string; offset: number; length: number; url?: string; language?: string }> } {
  const [ text, entities ] = HTMLParser.parse(renderTelegramHtml(input));
  return {
    text,
    entities: entities.map((e: any) => ({
      type: e.className,
      offset: e.offset,
      length: e.length,
      ...(e.url !== undefined ? { url: e.url } : {}),
      ...(e.language !== undefined && e.language !== "" ? { language: e.language } : {}),
    })),
  };
}

describe("markdown becomes Telegram entities", () => {
  it("renders **bold** — the exact failure from the 2026-08-12 report", () => {
    const r = parsed("**1. Jira — 0 действий.** Последняя активность — 28.04.2026.");
    assert.equal(r.text, "1. Jira — 0 действий. Последняя активность — 28.04.2026.");
    assert.deepEqual(r.entities, [ { type: "MessageEntityBold", offset: 0, length: 21 } ]);
  });

  it("renders *italic*, _italic_, __bold__, ~~strike~~ and ||spoiler||", () => {
    const r = parsed("*курсив* _тоже_ __жирный__ ~~зачёркнуто~~ ||тайна||");
    assert.equal(r.text, "курсив тоже жирный зачёркнуто тайна");
    assert.deepEqual(r.entities.map((e) => e.type), [
      "MessageEntityItalic",
      "MessageEntityItalic",
      "MessageEntityBold",
      "MessageEntityStrike",
      "MessageEntitySpoiler",
    ]);
  });

  it("renders ***bold italic***", () => {
    const r = parsed("***важно***");
    assert.equal(r.text, "важно");
    assert.deepEqual(r.entities.map((e) => e.type).sort(), [ "MessageEntityBold", "MessageEntityItalic" ]);
  });

  it("nests emphasis inside emphasis", () => {
    const r = parsed("**жирный с *курсивом* внутри**");
    assert.equal(r.text, "жирный с курсивом внутри");
    assert.equal(r.entities.length, 2);
  });

  it("renders [text](url) as a link", () => {
    const r = parsed("смотри [тикет](https://jira.example.ru/browse/WP-21) до конца дня");
    assert.equal(r.text, "смотри тикет до конца дня");
    assert.deepEqual(r.entities, [
      { type: "MessageEntityTextUrl", offset: 7, length: 5, url: "https://jira.example.ru/browse/WP-21" },
    ]);
  });

  it("renders `inline code` and keeps markdown inside it literal", () => {
    const r = parsed("поле `active=false` и маркер `**не жирный**`");
    assert.equal(r.text, "поле active=false и маркер **не жирный**");
    assert.deepEqual(r.entities.map((e) => e.type), [ "MessageEntityCode", "MessageEntityCode" ]);
  });

  it("renders a fenced block with its language", () => {
    const r = parsed("до\n```python\nx = 1 < 2 # и **звёзды**\n```\nпосле");
    assert.equal(r.text, "до\nx = 1 < 2 # и **звёзды**\nпосле");
    assert.deepEqual(r.entities, [ { type: "MessageEntityPre", offset: 3, length: 24, language: "python" } ]);
  });

  it("renders an unclosed fence to the end, as GFM does", () => {
    const r = parsed("```\nхвост без закрытия");
    assert.equal(r.text, "хвост без закрытия");
    assert.deepEqual(r.entities.map((e) => e.type), [ "MessageEntityPre" ]);
  });

  it("renders # headings as bold lines", () => {
    const r = parsed("## Итоги месяца\nвсё плохо");
    assert.equal(r.text, "Итоги месяца\nвсё плохо");
    assert.deepEqual(r.entities, [ { type: "MessageEntityBold", offset: 0, length: 12 } ]);
  });

  it("renders > quotes as a blockquote", () => {
    const r = parsed("> первая строка\n> вторая строка\nобычный текст");
    assert.equal(r.text, "первая строка\nвторая строка\nобычный текст");
    assert.deepEqual(r.entities, [ { type: "MessageEntityBlockquote", offset: 0, length: 27 } ]);
  });
});

describe("what must NOT convert stays literal", () => {
  it("leaves arithmetic asterisks alone", () => {
    const r = parsed("2 * 3 * 4 = 24");
    assert.equal(r.text, "2 * 3 * 4 = 24");
    assert.deepEqual(r.entities, []);
  });

  it("leaves snake_case identifiers alone", () => {
    const r = parsed("поле user_display_name не заполнено");
    assert.equal(r.text, "поле user_display_name не заполнено");
    assert.deepEqual(r.entities, []);
  });

  it("leaves an unpaired ** literal", () => {
    const r = parsed("рейтинг ** без пары");
    assert.equal(r.text, "рейтинг ** без пары");
    assert.deepEqual(r.entities, []);
  });

  it("leaves list markers and tables alone", () => {
    const src = "- пункт один\n- пункт два\n| a | b |";
    const r = parsed(src);
    assert.equal(r.text, src);
    assert.deepEqual(r.entities, []);
  });

  it("honours backslash escapes", () => {
    const r = parsed("\\*не курсив\\* и \\[не ссылка\\](x)");
    assert.equal(r.text, "*не курсив* и [не ссылка](x)");
    assert.deepEqual(r.entities, []);
  });

  it("refuses schemes Telegram cannot open", () => {
    const r = parsed("[файл](/tmp/report.md) и [скрипт](javascript:alert(1))");
    assert.equal(r.text, "[файл](/tmp/report.md) и [скрипт](javascript:alert(1))");
    assert.deepEqual(r.entities, []);
  });
});

describe("hand-authored HTML keeps working — the links the agent already sends", () => {
  it("keeps <a href> links, including query ampersands, raw or pre-escaped", () => {
    for (const href of [ "https://x.y/z?a=1&b=2", "https://x.y/z?a=1&amp;b=2" ]) {
      const r = parsed(`итог: <a href="${href}">ссылка</a>`);
      assert.equal(r.text, "итог: ссылка");
      assert.deepEqual(r.entities, [
        { type: "MessageEntityTextUrl", offset: 6, length: 6, url: "https://x.y/z?a=1&b=2" },
      ]);
    }
  });

  it("keeps <b>/<i>/<code> and renders markdown around them", () => {
    const r = parsed("<b>жирный</b> и **тоже жирный** и <code>x &lt; y</code>");
    assert.equal(r.text, "жирный и тоже жирный и x < y");
    assert.deepEqual(r.entities.map((e) => e.type), [
      "MessageEntityBold",
      "MessageEntityBold",
      "MessageEntityCode",
    ]);
  });

  it("keeps markdown inside <code>/<pre> bodies literal", () => {
    const r = parsed("<pre>rate = 5 ** 2 # **不 bold**</pre>");
    assert.equal(r.text, "rate = 5 ** 2 # **不 bold**");
    assert.deepEqual(r.entities.map((e) => e.type), [ "MessageEntityPre" ]);
  });

  it("maps Bot-API-only names onto what GramJS knows", () => {
    const r = parsed("<tg-spoiler>тайна</tg-spoiler> <ins>внизу</ins> <strike>нет</strike>");
    assert.deepEqual(r.entities.map((e) => e.type), [
      "MessageEntitySpoiler",
      "MessageEntityUnderline",
      "MessageEntityStrike",
    ]);
  });

  it("turns <br> into a newline and drops structural tags, keeping their text", () => {
    const r = parsed("строка<br><ul><li>пункт</li></ul>");
    assert.equal(r.text, "строка\nпункт");
    assert.deepEqual(r.entities, []);
  });
});

describe("stray characters survive instead of being eaten", () => {
  it("escapes bare <, > and & so the parser returns them as text", () => {
    const r = parsed("пять < семи, Q&A, x > y");
    assert.equal(r.text, "пять < семи, Q&A, x > y");
    assert.deepEqual(r.entities, []);
  });

  it("keeps an ASCII pseudo-tag the old path silently swallowed", () => {
    // GramJS's parser eats `<username>` whole; after escaping it comes back
    // to the reader as the placeholder the agent actually wrote.
    const r = parsed("логин вида <username> обязателен");
    assert.equal(r.text, "логин вида <username> обязателен");
  });

  it("keeps a Cyrillic placeholder", () => {
    const r = parsed("подставь <имя> сюда");
    assert.equal(r.text, "подставь <имя> сюда");
  });

  it("keeps a pre-escaped entity as one escape, not two", () => {
    const r = parsed("уже написано a &lt; b и AT&amp;T");
    assert.equal(r.text, "уже написано a < b и AT&T");
  });
});

describe("the mixed message — what the agent actually writes", () => {
  it("renders markdown structure and an HTML link in one message", () => {
    const src = [
      "**Разбор работы за июль**",
      "",
      "1. Jira — **0 действий** (учётка `active=false`).",
      "2. Ссылка: <a href=\"https://conf.example.ru/x?p=1&s=2\">страница</a>.",
      "",
      "> последняя активность — апрель",
    ].join("\n");
    const r = parsed(src);

    assert.equal(r.text, [
      "Разбор работы за июль",
      "",
      "1. Jira — 0 действий (учётка active=false).",
      "2. Ссылка: страница.",
      "",
      "последняя активность — апрель",
    ].join("\n"));

    assert.deepEqual(r.entities.map((e) => e.type), [
      "MessageEntityBold",
      "MessageEntityBold",
      "MessageEntityCode",
      "MessageEntityTextUrl",
      "MessageEntityBlockquote",
    ]);
    const link = r.entities.find((e) => e.type === "MessageEntityTextUrl");
    assert.equal(link?.url, "https://conf.example.ru/x?p=1&s=2");
  });

  it("keeps emphasis across a soft break but not across a blank line", () => {
    const soft = parsed("**жирный\nперенос**");
    assert.equal(soft.entities.length, 1);

    const hard = parsed("**оборвано\n\nне жирный**");
    assert.deepEqual(hard.entities, []);
    assert.equal(hard.text, "**оборвано\n\nне жирный**");
  });
});
