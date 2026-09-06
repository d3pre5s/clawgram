import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { forgetAccount, rememberAccount } from "../src/account-registry";
import { visibleReplyText } from "../src/inbound-pipeline";

/**
 * One filter for the three reply doors (group `deliver`, direct `deliver`,
 * transcript fallback). Each used to carry its own copy of "drop the silent
 * token, drop core's telemetry", and the direct copy lacked the second check
 * until B5-01 (finding B5-13).
 */
describe("visibleReplyText", () => {
  const logged: Array<[ string, string ]> = [];
  const log = {
    info: (line: string) => logged.push([ "info", line ]),
    warn: (line: string) => logged.push([ "warn", line ]),
  };
  const call = (text: unknown, kind: "group" | "user", where: "group reply" | "direct reply" | "transcript fallback") =>
    visibleReplyText({ text, kind, where, accountId: "acc", chatId: "42", messageId: 7, log });

  test("ordinary text passes untouched", () => {
    assert.equal(call("  привет  ", "group", "group reply"), "привет");
  });

  test("empty and non-string payloads deliver nothing, silently", () => {
    logged.length = 0;
    assert.equal(call("", "group", "group reply"), undefined);
    assert.equal(call(undefined, "user", "direct reply"), undefined);
    assert.deepEqual(logged, []);
  });

  test("the silent token is dropped and logged under the door's name", () => {
    logged.length = 0;
    assert.equal(call("NO_REPLY", "group", "group reply"), undefined);
    assert.equal(call("NO_REPLY", "user", "direct reply"), undefined);
    assert.deepEqual(logged, [
      [ "info", "clawgram suppressing silent group reply" ],
      [ "info", "clawgram suppressing silent direct reply" ],
    ]);
  });

  test("core's telemetry never reaches a group, on either group door", () => {
    logged.length = 0;
    assert.equal(call("⚠️ 🛠️ Bash failed: cat /opt/openclaw-secrets/secrets.json", "group", "group reply"), undefined);
    assert.equal(call("⚠️ ✉️ message failed", "group", "transcript fallback"), undefined);
    assert.deepEqual(logged.map(([ , line ]) => line), [
      "clawgram suppressing system notice in group reply",
      "clawgram suppressing system notice in transcript fallback",
    ]);
  });

  test("in a DM the telemetry reaches the named operator and nobody else", () => {
    rememberAccount("acc", { sendChats: undefined, operatorIds: [ "42" ] });
    try {
      assert.equal(call("⚠️ 🛠️ Bash failed", "user", "direct reply"), "⚠️ 🛠️ Bash failed");
      forgetAccount("acc");
      assert.equal(call("⚠️ 🛠️ Bash failed", "user", "direct reply"), undefined);
    } finally {
      forgetAccount("acc");
    }
  });
});
