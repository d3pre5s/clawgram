import { strict as assert } from "node:assert";
import { test } from "node:test";
import { addressWaitMs, NearbyConversation, readNearbyConversation, NEARBY_GUIDANCE } from "../src/nearby-conversation";

test("complete social addresses are not treated as an unfinished task or a bare tag", async () => {
  const nearby = new NearbyConversation({ bareMs: 100, quietMs: 1, windowMs: 1_000 });
  const key = nearby.key("-1", undefined, "42");
  const greeting = "Тина с возвращением в мир живых";
  assert.equal(await nearby.collect(key, greeting, true), greeting);
  assert.equal(nearby.has(key), false);
  assert.match(NEARBY_GUIDANCE, /уже законченное обращение/);
  assert.match(NEARBY_GUIDANCE, /коротко ответь по-человечески/);
  nearby.close();
});

test("a bare tag waits longer than a short request; a detailed request proceeds immediately", () => {
  assert.equal(addressWaitMs("@assistant_bot 👋"), 60_000);
  assert.equal(addressWaitMs("[изображение] профиль пользователя"), 60_000);
  assert.equal(addressWaitMs("@assistant_bot убери его из рекомендаций"), 6_000);
  assert.equal(addressWaitMs("@assistant_bot Посмотри список участников проекта и подготовь подробный отчёт о том какие задачи остались открытыми"), 0);
});

test("tag, image description and task become one turn, superseding older timers", async () => {
  const nearby = new NearbyConversation({ bareMs: 100, quietMs: 10, windowMs: 1_000 });
  const key = nearby.key("-1", "9", "42");
  const tag = nearby.collect(key, "@assistant_bot", true);
  assert.equal(nearby.has(key), true);
  const image = nearby.collect(key, "[изображение] профиль @example_user", false);
  const task = nearby.collect(key, "Убери его из рекомендаций", false);
  assert.equal(await tag, undefined);
  assert.equal(await image, undefined);
  assert.equal(await task, "@assistant_bot\n\n[изображение] профиль @example_user\n\nУбери его из рекомендаций");
  assert.equal(nearby.has(key), false);
  nearby.close();
});

test("continuations cannot cross author, chat, or forum topic; shutdown cancels a pending turn", async () => {
  const nearby = new NearbyConversation({ bareMs: 100, quietMs: 10, windowMs: 1_000 });
  const key = nearby.key("-1", "9", "42");
  const tag = nearby.collect(key, "@assistant_bot", true);
  for (const foreign of [ nearby.key("-2", "9", "42"), nearby.key("-1", "10", "42"), nearby.key("-1", "9", "43") ]) {
    assert.equal(nearby.has(foreign), false);
    assert.equal(await nearby.collect(foreign, "Удали", false), undefined);
  }
  nearby.close();
  assert.equal(await tag, undefined);
  assert.equal(await nearby.collect(key, "@assistant_bot", true), undefined);
});

test("bare tag still admits a later explanation but only within the original window", async () => {
  const nearby = new NearbyConversation({ bareMs: 1, quietMs: 1, windowMs: 25 });
  const key = nearby.key("-1", undefined, "42");
  assert.equal(await nearby.collect(key, "@assistant_bot", true), "@assistant_bot");
  assert.equal(nearby.has(key), true);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(nearby.has(key), false);
  assert.equal(await nearby.collect(key, "Удали", false), undefined);
  nearby.close();
});

test("a photo after the tag keeps the address alive until the task arrives", async () => {
  const nearby = new NearbyConversation({ bareMs: 1, quietMs: 1, windowMs: 1_000 });
  const key = nearby.key("-1", undefined, "42");
  await nearby.collect(key, "@assistant_bot", true);
  assert.equal(await nearby.collect(key, "[изображение] профиль", false), "@assistant_bot\n\n[изображение] профиль");
  assert.equal(nearby.has(key), true);
  assert.equal(await nearby.collect(key, "Убери его", false), "@assistant_bot\n\n[изображение] профиль\n\nУбери его");
  assert.equal(nearby.has(key), false);
  nearby.close();
});

test("nearby history respects read scope and keeps media ids and authors inside the current topic", async () => {
  const queries: unknown[] = [];
  const gram = { listMessages: async (query: unknown) => {
    queries.push(query);
    return { messages: [
      { messageId: "12", chatId: "-1", messageThreadId: "9", senderId: "42", text: "Продолжение", isOutgoing: false },
      { messageId: "11", chatId: "-1", messageThreadId: "9", senderId: "42", media: { kind: "photo" as const }, isOutgoing: false },
      { messageId: "10", chatId: "-1", messageThreadId: "8", text: "Другая тема", isOutgoing: false },
      { messageId: "13", chatId: "-2", messageThreadId: "9", text: "Другой чат", isOutgoing: false },
    ] };
  } };
  const params = { gram, chatId: "-1", messageId: "9", threadId: 9, timestamp: Date.now() };
  assert.equal(await readNearbyConversation({ ...params, readChats: [] }), undefined);
  assert.equal(queries.length, 0);
  const rows = JSON.parse((await readNearbyConversation({ ...params, readChats: [ "-1" ] }))!);
  assert.deepEqual(rows.map((row: any) => row.messageId), [ "11", "12" ]);
  assert.equal(rows[0].senderId, "42");
  assert.equal(rows[0].media.kind, "photo");
  assert.equal((queries[0] as any).limit, 100);
  assert.equal((queries[0] as any).messageThreadId, 9);
});

test("nearby history includes the ten-minute boundary and more than twelve messages", async () => {
  const anchor = Math.floor(Date.now() / 1000);
  const source = Array.from({ length: 20 }, (_, i) => ({
    messageId: String(i + 1), chatId: "-1", messageThreadId: "9",
    senderId: "42", timestamp: anchor - 600 + i, text: `Context ${i}`, isOutgoing: false,
  }));
  source.unshift({ ...source[0], messageId: "100", timestamp: anchor - 601 });
  const gram = { listMessages: async (query: any) => ({
    messages: source.filter((m) => m.timestamp >= query.since && m.timestamp <= query.until).slice(-query.limit),
  }) };
  const rows = JSON.parse((await readNearbyConversation({ gram, chatId: "-1", threadId: 9, messageId: "99", timestamp: anchor * 1000, readChats: [ "-1" ] }))!);
  assert.equal(rows.length, 20);
  assert.equal(rows[0].messageId, "1");
  assert.equal(rows.at(-1).messageId, "20");
});
