import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  buildEmojiSystemPrompt,
  canonicalizeReactionEmoji,
  parseEmojiChoice,
  reactToSilentMention,
  shouldReactToSilentTurn,
} from "../src/silent-reaction";

/**
 * The rule the owner wanted: named in a chat, nothing to add, leave a fitting
 * emoji instead of vanishing. Three rewrites of the workspace wording failed
 * because none of it ever reached the model — so the decision lives here, and
 * these tests cover the two places it can go wrong without Telegram noticing:
 * reacting when it should have kept quiet, and sending something that is not
 * an emoji.
 */
describe("deciding whether a silent turn deserves a reaction", () => {
  const decide = (over: Partial<Parameters<typeof shouldReactToSilentTurn>[0]> = {}) =>
    shouldReactToSilentTurn({
      wasMentioned: true,
      appetite: "extensive",
      messageText: "го обедать",
      ...over,
    });

  it("reacts when she was named and said nothing", () => {
    assert.equal(decide(), true);
  });

  it("stays out of conversations she was not named in", () => {
    // Silence on an unaddressed message is ordinary background reading.
    // Reacting to it would turn every group message into a notification.
    assert.equal(decide({ wasMentioned: false }), false);
  });

  it("honours off and ack, which mean no agent reactions", () => {
    assert.equal(decide({ appetite: undefined }), false);
  });

  it("skips messages with no text to judge", () => {
    // A bare sticker or photo gives the model nothing to read a mood from.
    assert.equal(decide({ messageText: undefined }), false);
    assert.equal(decide({ messageText: "   " }), false);
  });
});

describe("reading the model's emoji choice", () => {
  it("takes a bare emoji", () => {
    assert.equal(parseEmojiChoice("🔥"), "🔥");
  });

  it("unwraps the quoting models add on their own", () => {
    assert.equal(parseEmojiChoice(' "😁" '), "😁");
    assert.equal(parseEmojiChoice("`😢`"), "😢");
    assert.equal(parseEmojiChoice("👍."), "👍");
  });

  it("treats NONE as a decision not to react", () => {
    assert.equal(parseEmojiChoice("NONE"), undefined);
    assert.equal(parseEmojiChoice("none"), undefined);
    assert.equal(parseEmojiChoice(""), undefined);
    assert.equal(parseEmojiChoice("   "), undefined);
  });

  it("refuses a sentence instead of sending part of it", () => {
    // Models explain themselves when asked for one token. Telegram would
    // reject the result anyway, and a half-parsed explanation is worse than
    // no reaction.
    assert.equal(parseEmojiChoice("I would react with 🔥"), undefined);
    assert.equal(parseEmojiChoice("🔥 (fire)"), undefined);
    assert.equal(parseEmojiChoice("Sorry, I can't help with that."), undefined);
  });

  it("refuses anything with letters or digits in it", () => {
    assert.equal(parseEmojiChoice("ok"), undefined);
    assert.equal(parseEmojiChoice("1"), undefined);
    assert.equal(parseEmojiChoice(":fire:"), undefined);
  });

  it("survives a missing answer", () => {
    assert.equal(parseEmojiChoice(undefined), undefined);
    assert.equal(parseEmojiChoice(null), undefined);
  });

  it("strips the U+FE0F that Telegram refuses", () => {
    // The live failure. Telegram's reaction set holds `❤` as U+2764 alone, and
    // `messages.SendReaction` answers REACTION_INVALID for the decorated form
    // models emit by habit. Same for ⚡, ✍, 🕊, ☃.
    assert.equal(parseEmojiChoice("❤️"), "❤");
    assert.equal(parseEmojiChoice("⚡️"), "⚡");
    assert.equal(canonicalizeReactionEmoji("❤️"), "❤");
  });

  it("drops skin tones, which are not members of the set", () => {
    assert.equal(parseEmojiChoice("👍🏽"), "👍");
  });

  it("refuses an emoji Telegram does not accept as a reaction", () => {
    // A perfectly ordinary emoji that is simply not in the reaction set. The
    // old parser passed anything emoji-shaped and let Telegram reject it,
    // which cost the first live attempt.
    assert.equal(parseEmojiChoice("🍕"), undefined);
    assert.equal(parseEmojiChoice("🚀"), undefined);
  });

  it("narrows to what a restricted chat permits", () => {
    assert.equal(parseEmojiChoice("🔥", [ "👍", "🔥" ]), "🔥");
    assert.equal(parseEmojiChoice("😁", [ "👍", "🔥" ]), undefined);
  });

  it("matches a restricted set written with the decorated form", () => {
    // The allowed list comes off the wire and may carry U+FE0F; comparing raw
    // would reject a reaction the chat actually permits.
    assert.equal(parseEmojiChoice("❤", [ "❤️" ]), "❤");
  });

  it("permits nothing when the chat has reactions switched off", () => {
    // ChatReactionsNone arrives as an empty list. Treating empty as "no
    // restriction" — the natural falsy reading — would react in exactly the
    // chats that forbid reacting.
    assert.equal(parseEmojiChoice("👍", []), undefined);
    assert.equal(parseEmojiChoice("👍", undefined), "👍");
  });
});

describe("reacting to a silent mention end to end", () => {
  type Sent = { target: unknown; messageId: number; emoji: string; remove: boolean };

  function harness(answer: string | (() => Promise<{ text?: string }>)) {
    const sent: Sent[] = [];
    const asked: Array<Record<string, unknown>> = [];
    const decisions: Array<Record<string, unknown>> = [];

    return {
      sent,
      asked,
      decisions,
      deps: {
        complete: async (args: any) => {
          asked.push(args);
          return typeof answer === "string" ? { text: answer } : answer();
        },
        sendReaction: async (args: Sent) => {
          sent.push(args);
        },
        onDecision: (info: Record<string, unknown>) => {
          decisions.push(info);
        },
      },
    };
  }

  const call = (deps: any, over: Record<string, unknown> = {}) =>
    reactToSilentMention({
      deps,
      appetite: "extensive",
      wasMentioned: true,
      chatId: -1002_000_000_001,
      messageId: 2188,
      messageText: "тина сегодня опять всех спасла",
      ...over,
    });

  it("puts the chosen emoji on the message that named her", async () => {
    const h = harness("🔥");

    assert.equal(await call(h.deps), "🔥");
    assert.deepEqual(h.sent, [ {
      target: -1002_000_000_001,
      messageId: 2188,
      emoji: "🔥",
      remove: false,
    } ]);
  });

  it("adds a reaction rather than clearing one", async () => {
    // `remove: true` would wipe the reaction instead of leaving it, and a
    // plain account holds only one reaction per message.
    const h = harness("👍");
    await call(h.deps);

    assert.equal(h.sent[ 0 ].remove, false);
  });

  it("sends nothing when the model declines", async () => {
    const h = harness("NONE");

    assert.equal(await call(h.deps), undefined);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.decisions, [ {
      messageId: 2188,
      appetite: "extensive",
      chose: "none",
      emoji: undefined,
      allowedCount: undefined,
    } ]);
  });

  it("offers the model only what a restricted chat permits", async () => {
    const h = harness("🔥");
    (h.deps as any).allowedReactions = async () => [ "👍", "🔥" ];

    assert.equal(await call(h.deps), "🔥");
    assert.match(String(h.asked[ 0 ].systemPrompt), /Choose ONLY from this set, copied exactly: 👍 🔥$/m);
  });

  it("does not react at all where the chat switched reactions off", async () => {
    // ChatReactionsNone. Asking the model here would spend a call to produce
    // an emoji that cannot be sent.
    const h = harness("🔥");
    (h.deps as any).allowedReactions = async () => [];

    assert.equal(await call(h.deps), undefined);
    assert.deepEqual(h.asked, []);
    assert.deepEqual(h.sent, []);
    assert.deepEqual(h.decisions, [ {
      messageId: 2188,
      appetite: "extensive",
      chose: "none",
      allowedCount: 0,
    } ]);
  });

  it("falls back to the full set when the chat cannot be read", async () => {
    // A failed lookup must not mean "forbidden": most chats allow everything,
    // and this path runs after the reply is already settled.
    const h = harness("🔥");
    (h.deps as any).allowedReactions = async () => {
      throw new Error("CHANNEL_PRIVATE");
    };

    assert.equal(await call(h.deps), "🔥");
  });

  it("never asks the model when the turn does not qualify", async () => {
    // Each of these must short-circuit before spending a model call: they
    // fire on every silent turn in every group she sits in.
    for (const over of [
      { wasMentioned: false },
      { appetite: undefined },
      { messageText: "" },
      { messageId: 0 },
      { messageId: "not-an-id" },
    ]) {
      const h = harness("🔥");

      assert.equal(await call(h.deps, over), undefined, JSON.stringify(over));
      assert.deepEqual(h.asked, [], JSON.stringify(over));
      assert.deepEqual(h.sent, []);
    }
  });

  it("judges the message with the appetite the account configured", async () => {
    const h = harness("🔥");
    await call(h.deps, { appetite: "minimal" });

    assert.match(String(h.asked[ 0 ].systemPrompt), /sparing/i);
    assert.equal((h.asked[ 0 ].messages as any[])[ 0 ].content, "тина сегодня опять всех спасла");
  });

  it("keeps the model call small", async () => {
    // One emoji. A long answer is a refusal or an essay, and both get
    // discarded — paying for them twice over would be the only result.
    const h = harness("🔥");
    await call(h.deps);

    assert.equal(h.asked[ 0 ].maxTokens, 8);
  });

  it("truncates a long message instead of sending a wall of text to the model", async () => {
    const h = harness("🔥");
    await call(h.deps, { messageText: "я".repeat(5000) });

    assert.equal(String((h.asked[ 0 ].messages as any[])[ 0 ].content).length, 2000);
  });

  it("logs the emoji but never the message body", async () => {
    // Bodies are private correspondence; the emoji is our own act, and the
    // first live failure was undiagnosable without it in the log.
    const h = harness("🔥");
    await call(h.deps);

    assert.deepEqual(h.decisions, [ {
      messageId: 2188,
      appetite: "extensive",
      chose: "emoji",
      emoji: "🔥",
      allowedCount: undefined,
    } ]);
    assert.doesNotMatch(JSON.stringify(h.decisions), /спасла/);
  });

  it("lets a model failure surface to the caller, which swallows it", async () => {
    // The caller wraps this in `.catch()`. What must not happen is a partial
    // send: a failed judgement means no reaction at all.
    const h = harness(async () => {
      throw new Error("llm unavailable");
    });

    await assert.rejects(call(h.deps), /llm unavailable/);
    assert.deepEqual(h.sent, []);
  });
});

describe("the emoji prompt", () => {
  it("asks for one emoji or nothing at all", () => {
    const prompt = buildEmojiSystemPrompt("extensive");

    assert.match(prompt, /exactly one emoji/);
    assert.match(prompt, /NONE/);
  });

  it("carries the appetite the account configured", () => {
    assert.match(buildEmojiSystemPrompt("minimal"), /sparing/i);
    assert.match(buildEmojiSystemPrompt("extensive"), /generous/i);
  });

  it("holds back where a reaction reads as a verdict on someone", () => {
    // She sits in work chats. An emoji on "Петя опять сорвал сроки" is a
    // public opinion about a colleague, not an acknowledgement.
    assert.match(buildEmojiSystemPrompt("extensive"), /conflictual|performance/);
  });
});
