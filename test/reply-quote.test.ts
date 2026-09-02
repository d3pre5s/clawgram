import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { normalizeTelegramEvent } from "../src/normalize";
import { normalizeHistoryMessage } from "../src/history";

/**
 * Telegram lets a reply highlight a fragment of the message it answers.
 * That fragment is not part of the reply text: it arrives as `quoteText`
 * on `MessageReplyHeader`, alongside the `quote` flag.
 *
 * Dropping it loses the whole point of the gesture. The case that exposed
 * this: the owner highlighted two ids out of a list the agent had itself
 * written and asked "find them" — the agent received only "find them",
 * saw no highlight, and went back to guessing across every candidate,
 * including the one that had just been pointed at.
 */

const BASE = 1_785_000_000;

function event(overrides: Record<string, unknown> = {}) {
  return {
    message: {
      id: 42,
      chatId: -1001503965698,
      senderId: 116847835,
      message: "это сима и рина, они художницы. найдешь так?",
      date: BASE,
      out: false,
      ...overrides,
    },
  };
}

const QUOTE = "742000914 (@FENNY_SKETCH), 787573662 (@rinarinchic)";

describe("normalizeTelegramEvent: reply quote", () => {
  test("carries the highlighted fragment", () => {
    const normalized = normalizeTelegramEvent(
      event({ replyTo: { replyToMsgId: 41, quote: true, quoteText: QUOTE } }),
      "default",
    );
    assert.equal(normalized?.replyQuoteText, QUOTE);
    assert.equal(normalized?.replyIsQuote, true);
    // The reply text itself must stay untouched: the quote is extra context,
    // not a rewrite of what the person wrote.
    assert.equal(normalized?.text, "это сима и рина, они художницы. найдешь так?");
    assert.equal(normalized?.replyToMessageId, "41");
  });

  test("a plain reply without a highlight carries no quote", () => {
    const normalized = normalizeTelegramEvent(
      event({ replyTo: { replyToMsgId: 41 } }),
      "default",
    );
    assert.equal(normalized?.replyQuoteText, undefined);
    assert.equal(normalized?.replyIsQuote, undefined);
    assert.equal(normalized?.replyToMessageId, "41");
  });

  test("a message that is not a reply carries no quote", () => {
    const normalized = normalizeTelegramEvent(event(), "default");
    assert.equal(normalized?.replyQuoteText, undefined);
    assert.equal(normalized?.replyIsQuote, undefined);
  });

  test("an empty quoteText is treated as absent, not as an empty highlight", () => {
    const normalized = normalizeTelegramEvent(
      event({ replyTo: { replyToMsgId: 41, quote: true, quoteText: "   " } }),
      "default",
    );
    assert.equal(normalized?.replyQuoteText, undefined);
  });

  test("quoteText without the flag still counts — the text is the evidence", () => {
    const normalized = normalizeTelegramEvent(
      event({ replyTo: { replyToMsgId: 41, quoteText: QUOTE } }),
      "default",
    );
    assert.equal(normalized?.replyQuoteText, QUOTE);
    assert.equal(normalized?.replyIsQuote, true);
  });
});

describe("normalizeHistoryMessage: reply quote", () => {
  test("history carries the highlight too", () => {
    // Reading a chat window is where the agent reconstructs a conversation it
    // did not witness. A reply whose highlight is missing reads as an answer
    // to a whole message rather than to one line of it.
    const normalized = normalizeHistoryMessage(
      {
        id: 42,
        date: BASE,
        message: "именно этих двоих",
        replyTo: { replyToMsgId: 41, quote: true, quoteText: QUOTE },
      },
      "-1001503965698",
    );
    assert.equal(normalized?.replyQuoteText, QUOTE);
    assert.equal(normalized?.replyToMessageId, "41");
  });

  test("history without a highlight leaves the field absent", () => {
    const normalized = normalizeHistoryMessage(
      { id: 42, date: BASE, message: "ок", replyTo: { replyToMsgId: 41 } },
      "-1001503965698",
    );
    assert.equal(normalized?.replyQuoteText, undefined);
  });
});

// Static guard, not a behavioural test — same reasoning as no-secret-logging.
// Inbound context is assembled at two separate sites in channel.ts (group and
// direct message), and nothing in the type system links them. The failure this
// catches is a future edit that wires one and forgets the other: the feature
// then works in groups and silently does nothing in DMs, or the reverse.
describe("inbound context wiring", () => {
  const source = readFileSync(path.resolve(__dirname, "..", "..", "src", "channel.ts"), "utf8");
  const count = (needle: string) => source.split(needle).length - 1;

  test("every site that passes the parent id also passes the highlight", () => {
    const sites = count("ReplyToId: normalized.replyToMessageId");
    assert.ok(sites >= 2, `expected the group and DM sites, found ${sites}`);
    assert.equal(count("ReplyToQuoteText: normalized.replyQuoteText"), sites);
    assert.equal(count("ReplyToIsQuote: normalized.replyIsQuote"), sites);
  });

  test("every site that passes the parent id also passes the parent body and sender", () => {
    // A highlight is the exception; most replies point at a whole message.
    // Core falls back from ReplyToQuoteText to ReplyToBody, so a site that
    // wires only the highlight hands the agent a bare id for every plain
    // reply — which is what happened in DMs until 2.20.1.
    const sites = count("ReplyToId: normalized.replyToMessageId");
    assert.equal(count("ReplyToBody: replyParent.body"), sites);
    assert.equal(count("ReplyToSender: replyParent.sender"), sites);
  });

  test("the key names are the ones core reads", () => {
    // Core renders `[Replying to: …]` off ReplyToQuoteText and gates the
    // untrusted reply block on ReplyToIsQuote. A renamed key here would be
    // accepted by the payload type and quietly ignored downstream.
    assert.ok(source.includes("ReplyToQuoteText:"));
    assert.ok(source.includes("ReplyToIsQuote:"));
    assert.ok(source.includes("ReplyToBody:"));
    assert.ok(source.includes("ReplyToSender:"));
  });
});
