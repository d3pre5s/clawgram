import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  JOINS_DEFAULT_LIMIT,
  JOINS_MAX_LIMIT,
  type JoinEvent,
  appendJoinRecord,
  parseJoinEvent,
  parseJoinsParams,
  readJoinRecords,
  resolveJoinsJournalPath,
  selectJoinRecords,
} from "../src/joins";

const SELF = "1000000001";
const INVITER = "1000000002";

function serviceMessage(action: any, extra: Record<string, unknown> = {}) {
  return {
    id: 42,
    date: 1_785_000_000,
    peerId: { channelId: "2000000001" },
    fromId: { userId: INVITER },
    action,
    ...extra,
  };
}

describe("parseJoinEvent", () => {
  test("recognises being added by someone", () => {
    const event = parseJoinEvent(
      serviceMessage({ className: "MessageActionChatAddUser", users: [SELF, "111"] }),
      SELF,
    );
    assert.equal(event?.via, "added");
    assert.equal(event?.inviterId, INVITER);
    assert.equal(event?.chatId, "-1002000000001");
    assert.equal(event?.messageId, "42");
    assert.equal(event?.at, new Date(1_785_000_000 * 1000).toISOString());
  });

  test("ignores other people being added", () => {
    const event = parseJoinEvent(
      serviceMessage({ className: "MessageActionChatAddUser", users: ["111", "222"] }),
      SELF,
    );
    assert.equal(event, undefined);
  });

  test("recognises joining by invite link, taking the inviter from the action", () => {
    const event = parseJoinEvent(
      serviceMessage(
        { className: "MessageActionChatJoinedByLink", inviterId: INVITER },
        { fromId: { userId: SELF } },
      ),
      SELF,
    );
    assert.equal(event?.via, "link");
    assert.equal(event?.inviterId, INVITER);
  });

  test("ignores someone else joining by link", () => {
    const event = parseJoinEvent(
      serviceMessage({ className: "MessageActionChatJoinedByLink", inviterId: INVITER }),
      SELF,
    );
    assert.equal(event, undefined);
  });

  test("recognises a chat created with this account in it", () => {
    const event = parseJoinEvent(
      serviceMessage({ className: "MessageActionChatCreate", users: [SELF] }, { peerId: { chatId: "500" } }),
      SELF,
    );
    assert.equal(event?.via, "created");
    assert.equal(event?.chatId, "-500");
  });

  test("ignores ordinary messages and unknown service actions", () => {
    assert.equal(parseJoinEvent({ id: 1, message: "hello" }, SELF), undefined);
    assert.equal(parseJoinEvent(serviceMessage({ className: "MessageActionPinMessage" }), SELF), undefined);
    assert.equal(parseJoinEvent(undefined, SELF), undefined);
  });

  test("without a known self id nothing is a join", () => {
    const event = parseJoinEvent(
      serviceMessage({ className: "MessageActionChatAddUser", users: [SELF] }),
      undefined,
    );
    assert.equal(event, undefined);
  });

  test("a service message without a usable date is still recorded", () => {
    const event = parseJoinEvent(
      serviceMessage({ className: "MessageActionChatAddUser", users: [SELF] }, { date: undefined }),
      SELF,
    );
    assert.ok(event);
    assert.ok(!Number.isNaN(Date.parse(event!.at)));
  });
});

describe("joins journal", () => {
  test("appends and reads back, skipping malformed lines", () => {
    const path = join(mkdtempSync(join(tmpdir(), "joins-")), "joins.jsonl");
    const event: JoinEvent = { chatId: "-1001", via: "added", at: "2026-08-02T10:00:00.000Z", inviterId: INVITER };
    appendJoinRecord(path, event);
    writeFileSync(path, readFileSync(path, "utf8") + "not json at all\n");
    appendJoinRecord(path, { ...event, chatId: "-1002" });

    const records = readJoinRecords(path);
    assert.deepEqual(records.map((entry) => entry.chatId), ["-1001", "-1002"]);
  });

  test("missing journal reads as empty, not as an error", () => {
    assert.deepEqual(readJoinRecords(join(tmpdir(), "definitely-absent-joins.jsonl")), []);
  });

  test("selects by since and keeps the most recent within the limit", () => {
    const records: JoinEvent[] = [
      { chatId: "-1", via: "added", at: "2026-08-01T00:00:00.000Z" },
      { chatId: "-2", via: "added", at: "2026-08-02T00:00:00.000Z" },
      { chatId: "-3", via: "added", at: "2026-08-03T00:00:00.000Z" },
    ];
    assert.deepEqual(
      selectJoinRecords(records, { since: "2026-08-02T00:00:00.000Z", limit: 10 }).map((entry) => entry.chatId),
      ["-2", "-3"],
    );
    assert.deepEqual(
      selectJoinRecords(records, { limit: 2 }).map((entry) => entry.chatId),
      ["-2", "-3"],
    );
  });
});

describe("parseJoinsParams", () => {
  test("defaults the limit and leaves since absent", () => {
    assert.deepEqual(parseJoinsParams({}), { since: undefined, limit: JOINS_DEFAULT_LIMIT });
  });

  test("normalises since to ISO and clamps the limit", () => {
    const parsed = parseJoinsParams({ since: "2026-08-02T00:00:00Z", limit: JOINS_MAX_LIMIT + 10 });
    assert.equal(parsed.since, "2026-08-02T00:00:00.000Z");
    assert.equal(parsed.limit, JOINS_MAX_LIMIT);
  });

  test("rejects an unparseable since and a non-positive limit", () => {
    assert.throws(() => parseJoinsParams({ since: "yesterday" }), /ISO-8601/);
    assert.throws(() => parseJoinsParams({ limit: 0 }), /positive number/);
  });
});

describe("resolveJoinsJournalPath", () => {
  test("honours an explicit path from the account config", () => {
    assert.equal(resolveJoinsJournalPath({ joinsJournalPath: " /tmp/custom.jsonl " }, "default"), "/tmp/custom.jsonl");
  });

  test("falls back to a per-account file and cannot escape its directory", () => {
    const path = resolveJoinsJournalPath({}, "weird/../id");
    // Separators are replaced, so a hostile account id stays a file name.
    assert.equal(path.endsWith("joins-weird_.._id.jsonl"), true, path);
    assert.equal(path.includes("/../"), false);
    assert.match(path, /telegram-userbot\/joins-[^/]+\.jsonl$/);
  });
});
