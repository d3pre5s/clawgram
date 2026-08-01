import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  HISTORY_DEFAULT_LIMIT,
  HISTORY_MAX_LIMIT,
  buildHistoryQuery,
  collectHistoryWindow,
  isChatReadable,
  isWithinWindow,
  normalizeHistoryMessage,
  parseLimit,
  parseListMessagesParams,
  parseTimeBoundary,
} from "../src/history";

const HOUR = 3600;
const BASE = 1_785_000_000; // arbitrary fixed point; nothing here depends on "now"

function message(id: number, overrides: Record<string, unknown> = {}) {
  return { id, date: BASE, message: `msg ${id}`, out: false, ...overrides };
}

describe("parseTimeBoundary", () => {
  test("accepts Unix seconds unchanged", () => {
    assert.equal(parseTimeBoundary(BASE, "since"), BASE);
  });

  test("converts millisecond timestamps instead of trusting them as seconds", () => {
    // The failure this guards against is silent: BASE * 1000 read as seconds
    // lands roughly fifty thousand years from now, and every message falls
    // outside the window with no error anywhere.
    assert.equal(parseTimeBoundary(BASE * 1000, "since"), BASE);
  });

  test("parses ISO 8601", () => {
    assert.equal(parseTimeBoundary("2026-08-01T00:00:00Z", "since"), 1785542400);
  });

  test("parses a numeric string", () => {
    assert.equal(parseTimeBoundary(String(BASE), "since"), BASE);
  });

  test("returns undefined for an absent boundary", () => {
    for (const value of [ undefined, null, "" ]) {
      assert.equal(parseTimeBoundary(value, "since"), undefined);
    }
  });

  test("rejects nonsense rather than guessing", () => {
    assert.throws(() => parseTimeBoundary("не дата", "since"), /not a valid date/);
    assert.throws(() => parseTimeBoundary(0, "since"), /positive timestamp/);
    assert.throws(() => parseTimeBoundary(-5, "since"), /positive timestamp/);
    assert.throws(() => parseTimeBoundary({}, "since"), /timestamp or an ISO 8601/);
  });
});

describe("parseLimit", () => {
  test("defaults when unspecified", () => {
    assert.equal(parseLimit(undefined), HISTORY_DEFAULT_LIMIT);
  });

  test("clamps to the ceiling instead of failing", () => {
    assert.equal(parseLimit(10_000), HISTORY_MAX_LIMIT);
  });

  test("truncates fractions", () => {
    assert.equal(parseLimit(10.9), 10);
  });

  test("rejects a limit below one", () => {
    assert.throws(() => parseLimit(0), /at least 1/);
  });

  test("rejects non-numbers", () => {
    assert.throws(() => parseLimit("много"), /must be a number/);
  });
});

describe("parseListMessagesParams", () => {
  test("requires a chat", () => {
    assert.throws(() => parseListMessagesParams({}), /requires a chatId/);
    assert.throws(() => parseListMessagesParams({ chatId: "   " }), /requires a chatId/);
  });

  test("accepts the aliases a caller is likely to use", () => {
    for (const key of [ "chatId", "target", "to", "chat" ]) {
      assert.equal(parseListMessagesParams({ [key]: "-100123" }).target, "-100123");
    }
  });

  test("carries the window through", () => {
    const parsed = parseListMessagesParams({
      chatId: "-100123",
      since: BASE,
      until: BASE + HOUR,
      limit: 50,
    });
    assert.deepEqual(parsed, { target: "-100123", limit: 50, since: BASE, until: BASE + HOUR });
  });

  test("rejects an inverted window", () => {
    assert.throws(
      () => parseListMessagesParams({ chatId: "-1", since: BASE + HOUR, until: BASE }),
      /since must not be later than until/,
    );
  });
});

describe("buildHistoryQuery", () => {
  test("passes the limit through", () => {
    assert.deepEqual(buildHistoryQuery({ limit: 25 }), { limit: 25 });
  });

  test("omits offsetDate when the window has no upper bound", () => {
    assert.equal(Object.hasOwn(buildHistoryQuery({ limit: 25 }), "offsetDate"), false);
  });

  test("shifts offsetDate by a second because Telegram treats it as exclusive", () => {
    // Without the shift a message stamped exactly at `until` is dropped by the
    // server, so a window ending at 12:00:00 would silently lose the message
    // sent at 12:00:00.
    assert.deepEqual(buildHistoryQuery({ limit: 10, until: BASE }), { limit: 10, offsetDate: BASE + 1 });
  });
});

describe("isChatReadable", () => {
  test("no configured scope means no restriction", () => {
    assert.equal(isChatReadable("-100123", undefined), true);
    assert.equal(isChatReadable("-100123", null), true);
  });

  test("a configured empty list denies everything", () => {
    // Distinct from "absent": leaving empty brackets behind must not silently
    // grant access to every chat the account is in.
    assert.equal(isChatReadable("-100123", []), false);
  });

  test("allows only what is listed", () => {
    assert.equal(isChatReadable("-100123", [ "-100123" ]), true);
    assert.equal(isChatReadable("-100999", [ "-100123" ]), false);
  });

  test("matches usernames case-insensitively and ignores a leading @", () => {
    assert.equal(isChatReadable("@WorkChat", [ "workchat" ]), true);
    assert.equal(isChatReadable("workchat", [ "@WorkChat" ]), true);
  });

  test("honours an explicit wildcard", () => {
    assert.equal(isChatReadable("-100999", [ "*" ]), true);
  });

  test("accepts a bare string as a one-entry list", () => {
    assert.equal(isChatReadable("-100123", "-100123"), true);
    assert.equal(isChatReadable("-100999", "-100123"), false);
  });
});

describe("isWithinWindow", () => {
  test("treats both bounds as inclusive", () => {
    assert.equal(isWithinWindow(BASE, BASE, BASE), true);
  });

  test("excludes either side", () => {
    assert.equal(isWithinWindow(BASE - 1, BASE, undefined), false);
    assert.equal(isWithinWindow(BASE + 1, undefined, BASE), false);
  });

  test("keeps an undated message only when the window is open", () => {
    assert.equal(isWithinWindow(undefined, undefined, undefined), true);
    assert.equal(isWithinWindow(undefined, BASE, undefined), false);
  });
});

describe("normalizeHistoryMessage", () => {
  test("drops a message without an id", () => {
    assert.equal(normalizeHistoryMessage({ message: "no id" }), null);
  });

  test("extracts the fields a summary needs", () => {
    const normalized = normalizeHistoryMessage(message(7, {
      chatId: -100123,
      senderId: 42,
      sender: { username: "ivan", firstName: "Иван", lastName: "П." },
      replyTo: { replyToMsgId: 3 },
      out: true,
    }));

    assert.equal(normalized?.messageId, "7");
    assert.equal(normalized?.chatId, "-100123");
    assert.equal(normalized?.senderId, "42");
    assert.equal(normalized?.senderUsername, "ivan");
    assert.equal(normalized?.senderDisplay, "Иван П.");
    assert.equal(normalized?.replyToMessageId, "3");
    assert.equal(normalized?.isOutgoing, true);
    assert.equal(normalized?.timestamp, BASE);
  });

  test("never carries the raw GramJS object into the result", () => {
    // History is read straight into a model's context; an unbounded structure
    // there costs tokens and leaks internals into a prompt.
    const normalized = normalizeHistoryMessage(message(1, { className: "Message", _client: {} }));
    assert.equal(Object.hasOwn(normalized as object, "raw"), false);
    assert.deepEqual(Object.keys(normalized as object).sort(), [
      "chatId", "isOutgoing", "messageId", "messageThreadId", "replyToMessageId",
      "senderDisplay", "senderId", "senderUsername", "sentAt", "text", "timestamp",
    ]);
  });

  test("states the instant as ISO 8601 UTC as well as seconds", () => {
    const normalized = normalizeHistoryMessage(message(1, { date: 1785542400 }));
    assert.equal(normalized?.sentAt, "2026-08-01T00:00:00.000Z");
    assert.equal(normalized?.timestamp, 1785542400);
  });

  test("omits sentAt when the message has no date", () => {
    assert.equal(normalizeHistoryMessage({ id: 1 })?.sentAt, undefined);
  });

  test("accepts a Date as well as seconds", () => {
    assert.equal(normalizeHistoryMessage(message(1, { date: new Date(BASE * 1000) }))?.timestamp, BASE);
  });

  test("falls back to the resolved chat id", () => {
    assert.equal(normalizeHistoryMessage({ id: 1 }, "-100999")?.chatId, "-100999");
  });
});

describe("collectHistoryWindow", () => {
  test("returns oldest first, whatever order Telegram used", () => {
    // Telegram answers newest first. Left unsorted, a model reconstructs the
    // conversation backwards and reports the wrong sequence of events.
    const window = collectHistoryWindow([
      message(3, { date: BASE + 2 * HOUR }),
      message(1, { date: BASE }),
      message(2, { date: BASE + HOUR }),
    ]);
    assert.deepEqual(window.map((m) => m.messageId), [ "1", "2", "3" ]);
  });

  test("drops what falls outside the window", () => {
    const window = collectHistoryWindow(
      [ message(1, { date: BASE - HOUR }), message(2, { date: BASE }), message(3, { date: BASE + 2 * HOUR }) ],
      { since: BASE, until: BASE + HOUR },
    );
    assert.deepEqual(window.map((m) => m.messageId), [ "2" ]);
  });

  test("orders by message id when timestamps collide", () => {
    const window = collectHistoryWindow([ message(9), message(4) ]);
    assert.deepEqual(window.map((m) => m.messageId), [ "4", "9" ]);
  });

  test("skips unusable entries without failing the whole read", () => {
    const window = collectHistoryWindow([ message(1), { message: "no id" }, null, message(2) ]);
    assert.deepEqual(window.map((m) => m.messageId), [ "1", "2" ]);
  });

  test("survives an empty or missing list", () => {
    assert.deepEqual(collectHistoryWindow([]), []);
    assert.deepEqual(collectHistoryWindow(undefined as unknown as unknown[]), []);
  });
});
