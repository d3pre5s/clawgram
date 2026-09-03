import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { isSenderAllowed, resolveAccountScopes, resolveGroupConfig } from "../src/helpers";

/**
 * Reading an inbound attachment downloads up to 25 MB and then spends a
 * transcription or vision call on it. That ran for every photo and voice note
 * from anyone in any group the account sits in, and the sender was checked
 * against `allowFrom` only afterwards — so a stranger could spend the owner's
 * model budget at will, and be refused after the bill.
 *
 * None of the checks that decide whether a sender may reach the agent depend
 * on the message text, which is why they can run first. This asserts the
 * predicate those decisions are made from, for the same config shapes the
 * inbound path builds it from.
 */
describe("whether a sender may reach the agent is decidable before any fetch", () => {
  const cfg = (channel: Record<string, unknown>) => ({ channels: { clawgram: channel } });

  const mayReach = (config: unknown, input: {
    chatType: "group" | "direct";
    chatId: string;
    senderId: string;
    senderUsername?: string;
  }) => {
    const scopes = resolveAccountScopes(config, "default");
    if (input.chatType === "group") {
      const groupConfig = resolveGroupConfig(scopes.groups, input.chatId);
      return Boolean(
        groupConfig
        && groupConfig.enabled !== false
        && isSenderAllowed({
          allowFrom: groupConfig.allowFrom,
          senderId: input.senderId,
          senderUsername: input.senderUsername,
        }),
      );
    }

    return isSenderAllowed({
      allowFrom: scopes.allowFrom,
      senderId: input.senderId,
      senderUsername: input.senderUsername,
    });
  };

  test("a stranger in a direct chat is refused before anything is fetched", () => {
    const config = cfg({ accounts: { default: { allowFrom: [ "42" ] } } });

    assert.equal(mayReach(config, { chatType: "direct", chatId: "77", senderId: "77" }), false);
    assert.equal(mayReach(config, { chatType: "direct", chatId: "42", senderId: "42" }), true);
  });

  test("a group the account merely sits in is refused", () => {
    const config = cfg({ accounts: { default: { groups: { "-1001": { enabled: true } } } } });

    assert.equal(mayReach(config, { chatType: "group", chatId: "-1002", senderId: "42" }), false);
    assert.equal(mayReach(config, { chatType: "group", chatId: "-1001", senderId: "42" }), true);
  });

  test("a disabled group is refused, and so is a sender outside its allowFrom", () => {
    assert.equal(
      mayReach(cfg({ accounts: { default: { groups: { "-1001": { enabled: false } } } } }),
        { chatType: "group", chatId: "-1001", senderId: "42" }),
      false,
    );
    assert.equal(
      mayReach(cfg({ accounts: { default: { groups: { "-1001": { enabled: true, allowFrom: [ "7" ] } } } } }),
        { chatType: "group", chatId: "-1001", senderId: "42" }),
      false,
    );
  });

  test("the wildcard group still admits, which is the ordinary work-chat case", () => {
    const config = cfg({ accounts: { default: { groups: { "*": { enabled: true } } } } });

    assert.equal(mayReach(config, { chatType: "group", chatId: "-100777", senderId: "42" }), true);
  });
});
