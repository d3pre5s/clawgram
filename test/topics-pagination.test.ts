import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { GramJsClientManager } from "../src/gramjs-client";

/**
 * `topics` accepted a limit of up to 500 and asked the server once. Telegram
 * answers with a page and waits for offsets, so everything past the first
 * page was silently lost — and `truncated` said it was not (finding A6-20).
 */
describe("listTopics pagination", () => {
  function managerWithPages(pageSize: number, total: number) {
    const asked: Array<{ offsetTopic: number; limit: number }> = [];
    const manager = Object.create(GramJsClientManager.prototype) as any;
    manager.resolvePeer = async () => ({ peer: { id: 1 }, chatId: "-100777" });
    manager.client = {
      invoke: async (request: any) => {
        const offsetTopic = Number(request.offsetTopic ?? 0);
        asked.push({ offsetTopic, limit: Number(request.limit ?? 0) });
        const topics = [];
        for (let id = offsetTopic + 1; id <= Math.min(offsetTopic + pageSize, total); id += 1) {
          topics.push({ id, title: `тема ${id}`, topMessage: id * 10, date: 1000 + id });
        }
        return { topics };
      },
    };
    return { manager, asked };
  }

  test("more than one page is collected, not silently dropped", async () => {
    const { manager, asked } = managerWithPages(100, 250);

    const result = await manager.listTopics({ target: "-100777", limit: 250 });

    assert.equal(result.topics.length, 250, "all requested topics arrived");
    assert.ok(asked.length >= 3, "which took several pages");
    assert.equal(asked[1].offsetTopic, 100, "each page continues from the last topic");
  });

  test("a forum with fewer topics than asked is not reported as truncated", async () => {
    const { manager } = managerWithPages(100, 40);

    const result = await manager.listTopics({ target: "-100777", limit: 250 });

    assert.equal(result.topics.length, 40);
    assert.equal(result.truncated, false, "the forum said it had no more");
  });

  test("truncated means exactly what it says: the limit was reached first", async () => {
    const { manager } = managerWithPages(100, 1000);

    const result = await manager.listTopics({ target: "-100777", limit: 150 });

    assert.equal(result.topics.length, 150);
    assert.equal(result.truncated, true);
  });

  test("a page that does not advance the offset ends the loop", async () => {
    // Иначе один и тот же ответ запрашивался бы вечно.
    const manager = Object.create(GramJsClientManager.prototype) as any;
    manager.resolvePeer = async () => ({ peer: { id: 1 }, chatId: "-100777" });
    let calls = 0;
    manager.client = {
      invoke: async () => {
        calls += 1;
        return { topics: [ { id: 7, title: "та же тема", topMessage: 70, date: 1 } ] };
      },
    };

    const result = await manager.listTopics({ target: "-100777", limit: 100 });

    assert.equal(calls, 2, "the second page repeated the offset and the loop stopped");
    assert.equal(result.topics.length, 2);
  });
});
