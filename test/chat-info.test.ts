import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { describeChat, parseChatInfoParams } from "../src/chat-info";
import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";

describe("parseChatInfoParams", () => {
  it("takes the chat from the usual aliases", () => {
    for (const key of [ "chatId", "target", "to", "chat" ]) {
      assert.equal(parseChatInfoParams({ [ key ]: "-100123" }, undefined).target, "-100123");
    }
  });

  it("falls back to the current chat from tool context", () => {
    const parsed = parseChatInfoParams({}, { currentChannelId: "-100999" });

    assert.equal(parsed.target, "-100999");
  });

  it("prefers an explicit chat over context", () => {
    const parsed = parseChatInfoParams({ chatId: "-100123" }, { currentChannelId: "-100999" });

    assert.equal(parsed.target, "-100123");
  });

  it("refuses when there is no chat to describe", () => {
    assert.throws(() => parseChatInfoParams({}, undefined), /requires a chatId/);
    assert.throws(() => parseChatInfoParams({ chatId: "   " }, undefined), /requires a chatId/);
  });
});

/**
 * Entities here mirror what GramJS returns: `className` plus raw TL fields.
 * Telegram splits what a caller thinks of as "the chat" across two objects —
 * the entity carries title and flags, the full object carries description,
 * member count and the pinned message — so describeChat takes both.
 */
describe("describeChat", () => {
  it("describes a supergroup", () => {
    const info = describeChat({
      className: "Channel",
      id: 123,
      title: "Проект Альфа",
      username: "alfa_team",
      megagroup: true,
      participantsCount: 24,
    }, {
      className: "ChannelFull",
      about: "рабочий чат",
      participantsCount: 25,
      pinnedMsgId: 77,
    });

    assert.equal(info.type, "supergroup");
    assert.equal(info.title, "Проект Альфа");
    assert.equal(info.username, "alfa_team");
    assert.equal(info.about, "рабочий чат");
    assert.equal(info.pinnedMessageId, "77");
    // The full object is refreshed on request; the entity may be cached.
    assert.equal(info.memberCount, 25);
  });

  it("falls back to the entity count when the full object has none", () => {
    const info = describeChat({ className: "Channel", megagroup: true, participantsCount: 24 }, {});

    assert.equal(info.memberCount, 24);
  });

  it("tells a broadcast channel from a supergroup", () => {
    const info = describeChat({ className: "Channel", title: "Анонсы", broadcast: true }, undefined);

    assert.equal(info.type, "channel");
  });

  // Forum topics change how replies must be addressed, so whether a chat is a
  // forum is not cosmetic.
  it("reports whether a supergroup is a forum", () => {
    assert.equal(describeChat({ className: "Channel", megagroup: true, forum: true }, undefined).isForum, true);
    assert.equal(describeChat({ className: "Channel", megagroup: true }, undefined).isForum, false);
  });

  it("describes a basic group", () => {
    const info = describeChat({
      className: "Chat",
      id: 55,
      title: "Старый чат",
      participantsCount: 4,
    }, { className: "ChatFull", about: "", pinnedMsgId: 12 });

    assert.equal(info.type, "group");
    assert.equal(info.title, "Старый чат");
    assert.equal(info.memberCount, 4);
    assert.equal(info.pinnedMessageId, "12");
  });

  it("describes a direct chat by the person's name", () => {
    const info = describeChat({
      className: "User",
      id: 7,
      firstName: "Иван",
      lastName: "Петров",
      username: "ivan",
    }, { className: "UserFull", about: "PM" });

    assert.equal(info.type, "direct");
    assert.equal(info.title, "Иван Петров");
    assert.equal(info.username, "ivan");
    assert.equal(info.about, "PM");
    assert.equal(info.memberCount, undefined);
  });

  it("handles a one-name user without trailing whitespace", () => {
    assert.equal(describeChat({ className: "User", firstName: "Иван" }, undefined).title, "Иван");
    assert.equal(describeChat({ className: "User", lastName: "Петров" }, undefined).title, "Петров");
  });

  it("marks a bot so a reader does not mistake it for a colleague", () => {
    assert.equal(describeChat({ className: "User", firstName: "CI", bot: true }, undefined).isBot, true);
    assert.equal(describeChat({ className: "User", firstName: "Иван" }, undefined).isBot, false);
  });

  // Ids and counts arrive as big-integer objects as often as numbers — the
  // shape that once made senderId silently undefined.
  it("reads ids and counts carried as big-integer objects", () => {
    const info = describeChat({
      className: "Channel",
      id: { toString: () => "1234567890" },
      megagroup: true,
    }, { participantsCount: { toString: () => "42" } });

    assert.equal(info.chatId, "1234567890");
    assert.equal(info.memberCount, 42);
  });

  it("omits an empty description rather than reporting a blank one", () => {
    assert.equal(describeChat({ className: "Channel", megagroup: true }, { about: "   " }).about, undefined);
  });

  it("survives an entity it does not recognize", () => {
    const info = describeChat({ className: "ChatForbidden", title: "Закрытый" }, undefined);

    assert.equal(info.type, "unknown");
    assert.equal(info.title, "Закрытый");
  });

  it("never carries the raw GramJS object into the result", () => {
    const info = describeChat({ className: "Channel", megagroup: true, _client: {}, accessHash: 1 }, {});

    assert.equal(Object.hasOwn(info, "raw"), false);
    assert.equal(Object.hasOwn(info, "_client"), false);
    assert.equal(Object.hasOwn(info, "accessHash"), false);
  });
});


describe("chatInfo action", () => {
  const channel = createChannelPlugin(new Map() as RuntimeMap) as any;
  const cfg = (readChats?: string[]) => ({
    channels: { clawgram: { accounts: { default: readChats ? { readChats } : {} } } },
  });

  it("is offered by the message tool", () => {
    const described = channel.actions.describeMessageTool({ cfg: cfg(), accountId: "default" });

    assert.ok(described.actions.includes("chatInfo"));
  });

  // Learning a chat's title and size is learning about its contents, so the
  // scope that gates reading has to gate this too.
  it("refuses a chat outside the configured read scope", async () => {
    await assert.rejects(
      () => channel.actions.handleAction({
        action: "chatInfo",
        params: { chatId: "-100999" },
        cfg: cfg([ "-100123" ]),
        accountId: "default",
      }),
      /not-allowed-chat/,
    );
  });

  it("accepts the alternate spellings a caller may reach for", async () => {
    for (const action of [ "chatInfo", "getChatInfo", "chatMetadata", "getChatMetadata" ]) {
      await assert.rejects(
        () => channel.actions.handleAction({
          action,
          params: { chatId: "-100999" },
          cfg: cfg([ "-100123" ]),
          accountId: "default",
        }),
        /not-allowed-chat/,
        `${action} should have been routed to chatInfo and refused by scope`,
      );
    }
  });

  it("validates the target before reaching for a runtime", async () => {
    await assert.rejects(
      () => channel.actions.handleAction({
        action: "chatInfo",
        params: {},
        cfg: cfg(),
        accountId: "default",
      }),
      /requires a chatId/,
    );
  });
});

/**
 * Same trap as in the participant list: an account or chat holding more than
 * one username keeps them in `usernames[]`, and the legacy field arrives empty.
 */
describe("describeChat and multi-username accounts", () => {
  it("finds the handle in usernames[] when the plain field is empty", () => {
    const info = describeChat({
      className: "User",
      id: 116847835,
      username: null,
      usernames: [
        { username: "retired_handle", active: false },
        { username: "top1ceo", active: true },
      ],
      firstName: "Константин",
    }, undefined);

    assert.equal(info.username, "top1ceo");
  });

  it("still reads a single plain username", () => {
    const info = describeChat({ className: "Channel", id: 1, title: "Проект", username: "alfa_team" }, undefined);

    assert.equal(info.username, "alfa_team");
  });
});
