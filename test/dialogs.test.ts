import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";
import {
  DIALOGS_DEFAULT_LIMIT,
  DIALOGS_MAX_LIMIT,
  normalizeDialogs,
  parseDialogsParams,
} from "../src/dialogs";

describe("parseDialogsParams", () => {
  test("needs no target: the question is which chats exist at all", () => {
    assert.equal(parseDialogsParams({}).limit, DIALOGS_DEFAULT_LIMIT);
  });

  test("clamps the limit like the other read actions", () => {
    assert.equal(parseDialogsParams({ limit: 5 }).limit, 5);
    assert.equal(parseDialogsParams({ limit: 100000 }).limit, DIALOGS_MAX_LIMIT);
    assert.throws(() => parseDialogsParams({ limit: 0 }), /positive number/);
    assert.throws(() => parseDialogsParams({ limit: "many" }), /positive number/);
  });

  test("carries an optional title query", () => {
    assert.equal(parseDialogsParams({}).query, undefined);
    assert.equal(parseDialogsParams({ query: "  Старший " }).query, "Старший");
    assert.equal(parseDialogsParams({ query: "   " }).query, undefined);
  });
});

/**
 * Shapes mirror GramJS `getDialogs()` entries: an `entity` carrying the title
 * and type flags, plus the boolean helpers the Dialog wrapper exposes.
 */
describe("normalizeDialogs", () => {
  const supergroup = {
    isUser: false,
    isGroup: true,
    isChannel: true,
    id: -1000000000003,
    title: "Старший брат",
    entity: { className: "Channel", id: 4428871220, title: "Старший брат", megagroup: true, forum: true },
  };
  const basicGroup = {
    isUser: false,
    isGroup: true,
    isChannel: false,
    id: -5350166084,
    title: "Иллюминаты",
    entity: { className: "Chat", id: 5350166084, title: "Иллюминаты" },
  };
  const person = {
    isUser: true,
    isGroup: false,
    isChannel: false,
    id: 100200300,
    title: "Владелец",
    entity: { className: "User", id: 100200300, firstName: "Владелец" },
  };

  test("reports a forum supergroup with the id the config is written in", () => {
    assert.deepEqual(normalizeDialogs([ supergroup ]), [
      { chatId: "-1000000000003", title: "Старший брат", type: "supergroup", isForum: true },
    ]);
  });

  test("reports a basic group, which has no topics and says so by omission", () => {
    assert.deepEqual(normalizeDialogs([ basicGroup ]), [
      { chatId: "-5350166084", title: "Иллюминаты", type: "group" },
    ]);
  });

  // Discovery exists to find WORK chats. A personal account also sits in
  // family and one-to-one conversations, and enumerating those is exactly the
  // surveillance the read scope was built to prevent.
  test("never reports direct chats", () => {
    assert.deepEqual(normalizeDialogs([ person ]), []);
    assert.deepEqual(normalizeDialogs([ person, basicGroup ]).map((d) => d.chatId), [ "-5350166084" ]);
  });

  test("filters by title when asked", () => {
    const all = [ supergroup, basicGroup ];

    assert.deepEqual(normalizeDialogs(all, { query: "старший" }).map((d) => d.chatId), [ "-1000000000003" ]);
    assert.deepEqual(normalizeDialogs(all, { query: "нет такого" }), []);
  });

  test("survives junk and missing ids", () => {
    assert.deepEqual(normalizeDialogs([ undefined, null, {}, { isGroup: true } ] as unknown[]), []);
    assert.deepEqual(normalizeDialogs(undefined), []);
  });
});

describe("the dialogs action", () => {
  const makeGram = () => {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      listDialogs: (args: Record<string, unknown>) => {
        calls.push(args);
        return Promise.resolve({
          dialogs: [ { chatId: "-1000000000003", title: "Старший брат", type: "supergroup", isForum: true } ],
          truncated: false,
        });
      },
    };
  };

  const makeChannel = (gram: ReturnType<typeof makeGram>, account: Record<string, unknown>) => {
    const runtimes = new Map([ [ "default", gram ] ]) as unknown as RuntimeMap;
    const channel = createChannelPlugin(runtimes) as any;
    const cfg = { channels: { clawgram: { accounts: { default: account } } } };

    return {
      channel,
      act: (params: Record<string, unknown>) => channel.actions.handleAction({
        action: "dialogs",
        params,
        cfg,
        accountId: "default",
      }),
    };
  };

  const parse = (result: unknown) => JSON.parse(
    typeof result === "string" ? result : (result as any).content?.[ 0 ]?.text ?? "{}",
  );

  test("is offered by the message tool", () => {
    const { channel } = makeChannel(makeGram(), {});
    const described = channel.actions.describeMessageTool({
      cfg: { channels: { clawgram: { accounts: { default: {} } } } },
      accountId: "default",
    });

    // `channel-list` is the callable spelling; `dialogs` answers only over
    // gateway RPC, which does not read this list.
    assert.ok(described.actions.includes("channel-list"));
    assert.ok(!described.actions.includes("dialogs"));
  });

  // Listing the chats an account sits in is a capability the read scope
  // deliberately withholds, so it is off until the account opts in.
  test("is refused until the account enables chat discovery", async () => {
    const gram = makeGram();
    const { act } = makeChannel(gram, { readChats: [ "*" ] });

    await assert.rejects(() => act({}), /chat-discovery is not enabled/);
    assert.equal(gram.calls.length, 0);
  });

  test("lists chats once discovery is enabled, including ones outside readChats", async () => {
    const gram = makeGram();
    const { act } = makeChannel(gram, { discoverChats: true, readChats: [ "-100123" ] });

    const payload = parse(await act({ query: "Старший", limit: 10 }));

    assert.deepEqual(gram.calls, [ { limit: 10, query: "Старший" } ]);
    assert.equal(payload.count, 1);
    assert.deepEqual(payload.dialogs, [
      { chatId: "-1000000000003", title: "Старший брат", type: "supergroup", isForum: true },
    ]);
  });

  test("is announced in the hints and capabilities", () => {
    const { channel } = makeChannel(makeGram(), {});

    // Under `channel-list`: naming `dialogs` to the agent offers a spelling
    // core cannot dispatch, and every attempt ends as a failed message.
    assert.ok(channel.agentPrompt.messageToolHints().some((hint: string) => hint.includes("`channel-list`")));
    assert.ok(channel.agentPrompt.messageToolCapabilities().some((line: string) => line.includes("channel-list")));
    assert.ok(!channel.agentPrompt.messageToolHints().some((hint: string) => hint.includes("`dialogs`")));
  });
});
