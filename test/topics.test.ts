import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";
import {
  TOPICS_DEFAULT_LIMIT,
  TOPICS_MAX_LIMIT,
  normalizeForumTopics,
  parseTopicsParams,
} from "../src/topics";

describe("parseTopicsParams", () => {
  test("requires a chat id", () => {
    assert.throws(() => parseTopicsParams({}), /requires a chatId/);
    assert.throws(() => parseTopicsParams({ chatId: "   " }), /requires a chatId/);
    assert.throws(() => parseTopicsParams({ chatId: -1001 }), /requires a chatId/);
  });

  test("accepts the same target aliases as the other read actions", () => {
    for (const key of [ "chatId", "target", "to", "chat" ]) {
      assert.equal(parseTopicsParams({ [ key ]: " -1001 " }).target, "-1001");
    }
  });

  test("clamps the limit the way history and participants do", () => {
    assert.equal(parseTopicsParams({ chatId: "-1001" }).limit, TOPICS_DEFAULT_LIMIT);
    assert.equal(parseTopicsParams({ chatId: "-1001", limit: 5 }).limit, 5);
    assert.equal(parseTopicsParams({ chatId: "-1001", limit: 100000 }).limit, TOPICS_MAX_LIMIT);
    assert.throws(() => parseTopicsParams({ chatId: "-1001", limit: 0 }), /positive number/);
    assert.throws(() => parseTopicsParams({ chatId: "-1001", limit: "many" }), /positive number/);
  });

  test("carries an optional title query for narrowing a long topic list", () => {
    assert.equal(parseTopicsParams({ chatId: "-1001" }).query, undefined);
    assert.equal(parseTopicsParams({ chatId: "-1001", query: "  Визитка " }).query, "Визитка");
    // An empty query is no query, not a search for the empty string.
    assert.equal(parseTopicsParams({ chatId: "-1001", query: "   " }).query, undefined);
  });
});

/**
 * Shapes mirror what GramJS returns from `channels.getForumTopics`: raw TL
 * objects carrying `className`, with ids that may arrive as `big-integer`
 * rather than as numbers.
 */
describe("normalizeForumTopics", () => {
  test("names a topic, which is the whole point of the action", () => {
    const topics = normalizeForumTopics([
      {
        className: "ForumTopic",
        id: 15009,
        title: "Визитка - представление",
        topMessage: 20070,
        closed: false,
        hidden: false,
        pinned: true,
      },
    ]);

    assert.deepEqual(topics, [
      {
        topicId: "15009",
        title: "Визитка - представление",
        topMessageId: "20070",
        closed: false,
        hidden: false,
        pinned: true,
      },
    ]);
  });

  test("keeps the General topic, which Telegram numbers 1 and often leaves untitled", () => {
    const topics = normalizeForumTopics([
      { className: "ForumTopic", id: 1, title: "General" },
    ]);

    assert.equal(topics.length, 1);
    assert.equal(topics[ 0 ].topicId, "1");
    assert.equal(topics[ 0 ].title, "General");
    // Flags Telegram did not send stay absent rather than being invented as false.
    assert.equal(topics[ 0 ].closed, undefined);
    assert.equal(topics[ 0 ].pinned, undefined);
  });

  test("drops deleted topics: an id with no title cannot be addressed by name", () => {
    const topics = normalizeForumTopics([
      { className: "ForumTopicDeleted", id: 42 },
      { className: "ForumTopic", id: 43, title: "Живой топик" },
    ]);

    assert.deepEqual(topics.map((topic) => topic.topicId), [ "43" ]);
  });

  test("survives big-integer ids and junk entries", () => {
    const topics = normalizeForumTopics([
      { className: "ForumTopic", id: { toString: () => "15009" }, title: "Большой id" },
      undefined,
      null,
      { className: "ForumTopic", title: "Без id" },
    ] as unknown[]);

    assert.deepEqual(topics.map((topic) => topic.topicId), [ "15009" ]);
  });

  test("returns nothing for a chat that is not a forum", () => {
    assert.deepEqual(normalizeForumTopics(undefined), []);
    assert.deepEqual(normalizeForumTopics([]), []);
  });
});

describe("topic search", () => {
  test("matches by substring, case- and space-insensitively", () => {
    const raw = [
      { className: "ForumTopic", id: 2, title: "Правила" },
      { className: "ForumTopic", id: 15009, title: "Визитка - представление" },
    ];

    assert.deepEqual(
      normalizeForumTopics(raw, { query: "визитка" }).map((topic) => topic.topicId),
      [ "15009" ],
    );
    assert.deepEqual(normalizeForumTopics(raw, { query: "нет такого" }), []);
  });
});

/**
 * Dispatch. The GramJS transport is faked: under test is the wiring — that the
 * action is offered, that it obeys the same read scope as history, and that the
 * parsed parameters reach the client.
 */
describe("the topics action", () => {
  const makeGram = () => {
    const calls: Array<Record<string, unknown>> = [];
    return {
      calls,
      listTopics: (args: Record<string, unknown>) => {
        calls.push(args);
        return Promise.resolve({
          chatId: "-1004428871220",
          topics: [ { topicId: "15009", title: "Визитка - представление" } ],
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
        action: "topics",
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

    assert.ok(described.actions.includes("topics"));
  });

  // An action the agent is never told about is an action it never takes: the
  // send hint already talks about `threadId` without saying where an id comes
  // from, which is how a named topic stayed unreachable.
  test("is announced in the hints and capabilities", () => {
    const { channel } = makeChannel(makeGram(), {});

    assert.ok(channel.agentPrompt.messageToolHints().some((hint: string) => hint.includes("`topics`")));
    assert.ok(channel.agentPrompt.messageToolCapabilities().some((line: string) => line.includes("topics")));
    // Reading one topic is the other half: knowing the id is useless if `read`
    // still returns every topic interleaved.
    assert.ok(channel.agentPrompt.messageToolHints().some(
      (hint: string) => hint.includes("`read`") && hint.includes("threadId"),
    ));
  });

  // Topic titles describe what a chat is doing, so the scope that gates
  // reading messages gates reading topics too.
  test("refuses a chat outside the configured read scope", async () => {
    const gram = makeGram();
    const { act } = makeChannel(gram, { readChats: [ "-100123" ] });

    await assert.rejects(() => act({ chatId: "-1004428871220" }), /not-allowed-chat/);
    assert.equal(gram.calls.length, 0);
  });

  test("passes the parsed target, limit and query to the client", async () => {
    const gram = makeGram();
    const { act } = makeChannel(gram, { readChats: [ "-1004428871220" ] });

    const payload = parse(await act({ chatId: "-1004428871220", query: "Визитка", limit: 10 }));

    assert.deepEqual(gram.calls, [ { target: "-1004428871220", limit: 10, query: "Визитка" } ]);
    assert.equal(payload.count, 1);
    assert.deepEqual(payload.topics, [ { topicId: "15009", title: "Визитка - представление" } ]);
  });
});
