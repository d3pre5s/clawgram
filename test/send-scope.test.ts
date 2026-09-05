import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  forgetSendScope,
  isChatSendable,
  isPhoneNumberTarget,
  isSendScopeConfigured,
  rememberSendScope,
  sendScopeFor,
} from "../src/send-scope";

/**
 * Sending was the one capability without a declared scope.
 *
 * Reading checks `readChats`, management checks `manageChats`, and
 * `send`/`upload-file`/`react` delivered to whatever target the caller
 * named — so an injected turn could write to strangers from the owner's
 * personal account, or carry a work chat into a DM one send at a time
 * (finding A5-12).
 */
describe("send scope", () => {
  test("an absent list still allows sending", () => {
    // Flipping the default would silence every existing deployment on
    // upgrade, including scheduled digests that write to an id nobody is
    // talking to right now. The boundary is opt-in and then hard.
    assert.equal(isChatSendable("-1001234567890", undefined), true);
    assert.equal(isChatSendable("123456789", null), true);
  });

  test("a configured empty list denies, like readChats", () => {
    assert.equal(isChatSendable("123456789", []), false);
  });

  test("the wildcard allows any chat", () => {
    assert.equal(isChatSendable("-1001234567890", [ "*" ]), true);
  });

  test("a list admits only its own", () => {
    const scope = [ "-1001234567890", "@owner" ];
    assert.equal(isChatSendable("-1001234567890", scope), true);
    assert.equal(isChatSendable("owner", scope), true, "@ and case do not count");
    assert.equal(isChatSendable("999", scope), false);
  });

  test("a phone number is refused in every configuration, wildcard included", () => {
    for (const scope of [ undefined, [ "*" ], [ "+7 900 000-00-00" ] ]) {
      assert.equal(isChatSendable("+7 900 000-00-00", scope), false);
      assert.equal(isChatSendable("+79000000000", scope), false);
    }
  });

  test("a number is told apart from an id", () => {
    assert.equal(isPhoneNumberTarget("+79000000000"), true);
    assert.equal(isPhoneNumberTarget("+7 (900) 000-00-00"), true);
    assert.equal(isPhoneNumberTarget("123456789"), false, "a user id is just digits");
    assert.equal(isPhoneNumberTarget("-1001234567890"), false, "a supergroup id");
    assert.equal(isPhoneNumberTarget("@handle"), false);
    assert.equal(isPhoneNumberTarget(""), false);
  });

  test("\"not configured\" is distinguishable from \"configured empty\"", () => {
    assert.equal(isSendScopeConfigured(undefined), false);
    assert.equal(isSendScopeConfigured([]), true);
  });

  test("the registry carries the scope into outbound, which has no cfg", () => {
    forgetSendScope("acc");
    assert.equal(sendScopeFor("acc"), undefined);
    rememberSendScope("acc", [ "42" ]);
    assert.deepEqual(sendScopeFor("acc"), [ "42" ]);
    assert.equal(isChatSendable("42", sendScopeFor("acc")), true);
    assert.equal(isChatSendable("43", sendScopeFor("acc")), false);
    forgetSendScope("acc");
    assert.equal(isChatSendable("43", sendScopeFor("acc")), true,
      "a forgotten account behaves like an unconfigured one");
  });
});
