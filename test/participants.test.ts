import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  PARTICIPANTS_DEFAULT_LIMIT,
  PARTICIPANTS_MAX_LIMIT,
  parseListParticipantsParams,
  normalizeParticipants,
} from "../src/history";
import { buildParticipantsQuery } from "../src/gramjs-client";

describe("parseListParticipantsParams", () => {
  test("requires a chat id", () => {
    assert.throws(() => parseListParticipantsParams({}), /requires a chatId/);
    assert.throws(() => parseListParticipantsParams({ chatId: "" }), /requires a chatId/);
    assert.throws(() => parseListParticipantsParams({ chatId: "   " }), /requires a chatId/);
    // A numeric id is expected as a string, exactly like history reading wants it.
    assert.throws(() => parseListParticipantsParams({ chatId: -1001 }), /requires a chatId/);
  });

  test("accepts the same target aliases as history reading", () => {
    for (const key of ["chatId", "target", "to", "chat"]) {
      assert.equal(parseListParticipantsParams({ [key]: " -1001 " }).target, "-1001");
    }
  });

  test("names are opt-in and off by default", () => {
    assert.equal(parseListParticipantsParams({ chatId: "-1001" }).includeNames, false);
    assert.equal(parseListParticipantsParams({ chatId: "-1001", includeNames: true }).includeNames, true);
    assert.equal(parseListParticipantsParams({ chatId: "-1001", includeNames: "true" }).includeNames, true);
    // Anything else stays off: personal data is not enabled by a typo.
    assert.equal(parseListParticipantsParams({ chatId: "-1001", includeNames: "yes" }).includeNames, false);
    assert.equal(parseListParticipantsParams({ chatId: "-1001", includeNames: 1 }).includeNames, false);
  });

  test("defaults the limit when it is absent or blank", () => {
    assert.equal(parseListParticipantsParams({ chatId: "-1001" }).limit, PARTICIPANTS_DEFAULT_LIMIT);
    assert.equal(parseListParticipantsParams({ chatId: "-1001", limit: "" }).limit, PARTICIPANTS_DEFAULT_LIMIT);
    assert.equal(parseListParticipantsParams({ chatId: "-1001", limit: null }).limit, PARTICIPANTS_DEFAULT_LIMIT);
  });

  test("clamps the limit so a large group cannot become an unbounded response", () => {
    assert.equal(
      parseListParticipantsParams({ chatId: "-1001", limit: PARTICIPANTS_MAX_LIMIT + 500 }).limit,
      PARTICIPANTS_MAX_LIMIT,
    );
  });

  test("floors a fractional limit and accepts numeric strings", () => {
    assert.equal(parseListParticipantsParams({ chatId: "-1001", limit: 12.9 }).limit, 12);
    assert.equal(parseListParticipantsParams({ chatId: "-1001", limit: "25" }).limit, 25);
  });

  test("rejects a limit that is not a positive number", () => {
    for (const limit of [0, -5, "abc", Number.NaN, Number.POSITIVE_INFINITY]) {
      assert.throws(
        () => parseListParticipantsParams({ chatId: "-1001", limit }),
        /positive number/,
        `limit ${String(limit)} should be rejected`,
      );
    }
  });

  // "Answer only the admins of this chat" is a standing instruction, so the
  // list of admins has to be re-readable rather than copied out once by hand.
  test("reads everyone unless the admins are asked for", () => {
    assert.equal(parseListParticipantsParams({ chatId: "-1001" }).filter, "all");
    assert.equal(parseListParticipantsParams({ chatId: "-1001", filter: "admins" }).filter, "admins");
    assert.equal(parseListParticipantsParams({ chatId: "-1001", admins: true }).filter, "admins");
    assert.equal(parseListParticipantsParams({ chatId: "-1001", filter: "all" }).filter, "all");
  });

  test("refuses a filter it does not implement instead of silently reading everyone", () => {
    assert.throws(
      () => parseListParticipantsParams({ chatId: "-1001", filter: "owners" }),
      /participants filter must be/,
    );
  });
});

/**
 * The filter has to reach Telegram as a TL object; a string named "admins"
 * would be accepted by `getParticipants` and quietly ignored, returning the
 * whole chat under a name that says otherwise.
 */
describe("buildParticipantsQuery", () => {
  test("asks for everyone by default", () => {
    const query = buildParticipantsQuery({ target: "-1001", limit: 200, includeNames: false, filter: "all" });

    assert.deepEqual(Object.keys(query).sort(), [ "limit" ]);
    assert.equal(query.limit, 200);
  });

  test("asks Telegram for admins with the constructor it expects", () => {
    const query = buildParticipantsQuery({ target: "-1001", limit: 200, includeNames: false, filter: "admins" });

    assert.equal(query.limit, 200);
    assert.equal((query.filter as any)?.className, "ChannelParticipantsAdmins");
  });
});

/**
 * Telegram moved usernames into a `usernames[]` array once an account could
 * hold more than one (multiple or collectible handles). For such an account the
 * legacy `username` field arrives EMPTY, and reading only that field is how the
 * owner of this deployment showed up in every generated table as "(без тэга)"
 * next to a bare numeric id — the single participant without a handle in chats
 * of 23, 9, 7 and 3 people.
 */
describe("normalizeParticipants", () => {
  test("reads the plain username when the account has just one", () => {
    const people = normalizeParticipants([
      { id: 890975818, username: "Rus9jke", bot: false },
    ], { includeNames: false });

    assert.deepEqual(people, [ { userId: "890975818", username: "Rus9jke", isBot: false } ]);
  });

  test("finds the handle of a multi-username account, where the plain field is empty", () => {
    const people = normalizeParticipants([
      {
        id: 116847835,
        username: null,
        usernames: [ { username: "top1ceo", active: true, editable: true } ],
        bot: false,
      },
    ], { includeNames: false });

    assert.equal(people[ 0 ].username, "top1ceo");
  });

  test("takes the active handle, not merely the first one listed", () => {
    const people = normalizeParticipants([
      {
        id: 1,
        usernames: [
          { username: "retired_handle", active: false },
          { username: "top1ceo", active: true },
        ],
      },
    ], { includeNames: false });

    assert.equal(people[ 0 ].username, "top1ceo");
  });

  test("an account with no handle at all stays without one", () => {
    const people = normalizeParticipants([ { id: 42, usernames: [] } ], { includeNames: false });

    assert.equal(people[ 0 ].username, undefined);
    assert.equal(people[ 0 ].userId, "42");
  });

  test("names stay opt-in and bots stay marked", () => {
    const raw = [ { id: 7, username: "helper", bot: true, firstName: "Хелпер", lastName: "Ботов" } ];

    assert.equal(normalizeParticipants(raw, { includeNames: false })[ 0 ].firstName, undefined);
    assert.equal(normalizeParticipants(raw, { includeNames: true })[ 0 ].firstName, "Хелпер");
    assert.equal(normalizeParticipants(raw, { includeNames: true })[ 0 ].lastName, "Ботов");
    assert.equal(normalizeParticipants(raw, { includeNames: false })[ 0 ].isBot, true);
  });

  test("skips entries without an id and tolerates junk", () => {
    assert.deepEqual(normalizeParticipants([ undefined, null, {}, { username: "ghost" } ] as unknown[], { includeNames: false }), []);
    assert.deepEqual(normalizeParticipants(undefined, { includeNames: false }), []);
  });
});
