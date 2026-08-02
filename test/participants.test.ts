import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  PARTICIPANTS_DEFAULT_LIMIT,
  PARTICIPANTS_MAX_LIMIT,
  parseListParticipantsParams,
} from "../src/history";

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
});
