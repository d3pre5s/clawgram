import assert from "node:assert/strict";
import test, { describe } from "node:test";

import {
  DEFAULT_ADMIN_RIGHTS,
  NO_ADMIN_RIGHTS,
  isChatManageable,
  isManagementEnabled,
  parseAddMembersParams,
  parseCreateGroupParams,
  parseDemoteAdminParams,
  parseInviteLinkParams,
  parsePromoteAdminParams,
  parseRemoveMemberParams,
  parseTransferOwnershipParams,
  readInviteLink,
  resolveCreatedChannelId,
  summarizeMissingInvitees,
} from "../src/manage";

describe("parseCreateGroupParams", () => {
  test("requires a title", () => {
    assert.throws(() => parseCreateGroupParams({}), /requires a title/);
    assert.throws(() => parseCreateGroupParams({ title: "   " }), /requires a title/);
    assert.throws(() => parseCreateGroupParams({ title: 42 }), /requires a title/);
  });

  test("takes the title from the usual aliases and trims it", () => {
    assert.equal(parseCreateGroupParams({ title: " Проект Альфа " }).title, "Проект Альфа");
    assert.equal(parseCreateGroupParams({ name: "Проект Бета" }).title, "Проект Бета");
  });

  test("carries an optional description", () => {
    assert.equal(parseCreateGroupParams({ title: "t" }).about, undefined);
    assert.equal(parseCreateGroupParams({ title: "t", about: " рабочий чат " }).about, "рабочий чат");
    assert.equal(parseCreateGroupParams({ title: "t", description: "чат" }).about, "чат");
  });

  test("accepts members as a list, a single entry, or nothing", () => {
    assert.deepEqual(parseCreateGroupParams({ title: "t" }).users, []);
    assert.deepEqual(parseCreateGroupParams({ title: "t", users: "@ivan" }).users, [ "@ivan" ]);
    assert.deepEqual(
      parseCreateGroupParams({ title: "t", users: [ "@ivan", 42, " @petr " ] }).users,
      [ "@ivan", "42", "@petr" ],
    );
    assert.deepEqual(parseCreateGroupParams({ title: "t", members: [ "@ivan" ] }).users, [ "@ivan" ]);
  });

  test("drops empty member entries rather than sending blanks to Telegram", () => {
    assert.deepEqual(parseCreateGroupParams({ title: "t", users: [ " ", "", "@ivan" ] }).users, [ "@ivan" ]);
  });
});

describe("parseAddMembersParams", () => {
  test("takes the chat from the usual aliases", () => {
    for (const key of [ "chatId", "target", "to", "chat" ]) {
      assert.equal(parseAddMembersParams({ [ key ]: "-100123", users: "@i" }, undefined).target, "-100123");
    }
  });

  test("falls back to the current chat from tool context", () => {
    const parsed = parseAddMembersParams({ users: "@i" }, { currentChannelId: "-100999" });

    assert.equal(parsed.target, "-100999");
  });

  test("requires a chat when neither params nor context name one", () => {
    assert.throws(() => parseAddMembersParams({ users: "@i" }, undefined), /requires a chatId/);
  });

  test("requires at least one user", () => {
    assert.throws(() => parseAddMembersParams({ chatId: "-100123" }, undefined), /requires users/);
    assert.throws(() => parseAddMembersParams({ chatId: "-100123", users: [] }, undefined), /requires users/);
    assert.throws(() => parseAddMembersParams({ chatId: "-100123", users: [ " " ] }, undefined), /requires users/);
  });

  test("accepts users under the usual aliases, single or list", () => {
    assert.deepEqual(parseAddMembersParams({ chatId: "-1", users: "@ivan" }, undefined).users, [ "@ivan" ]);
    assert.deepEqual(parseAddMembersParams({ chatId: "-1", members: [ "@a", 7 ] }, undefined).users, [ "@a", "7" ]);
    assert.deepEqual(parseAddMembersParams({ chatId: "-1", user: "@solo" }, undefined).users, [ "@solo" ]);
    assert.deepEqual(parseAddMembersParams({ chatId: "-1", userId: 42 }, undefined).users, [ "42" ]);
  });
});

describe("parseRemoveMemberParams", () => {
  test("requires a single user", () => {
    assert.throws(() => parseRemoveMemberParams({ chatId: "-1" }, undefined), /requires a user/);
    assert.throws(() => parseRemoveMemberParams({ chatId: "-1", user: "  " }, undefined), /requires a user/);
  });

  test("takes the user from the usual aliases", () => {
    assert.equal(parseRemoveMemberParams({ chatId: "-1", user: "@ivan" }, undefined).user, "@ivan");
    assert.equal(parseRemoveMemberParams({ chatId: "-1", userId: 42 }, undefined).user, "42");
    assert.equal(parseRemoveMemberParams({ chatId: "-1", member: " @p " }, undefined).user, "@p");
  });

  test("falls back to the current chat from tool context", () => {
    assert.equal(parseRemoveMemberParams({ user: "@i" }, { currentChannelId: "-100999" }).target, "-100999");
  });

  // Removal must stay reversible by default: a kicked person can be invited
  // back, a banned one cannot rejoin even by link until unbanned.
  test("kicks softly unless a ban is asked for explicitly", () => {
    assert.equal(parseRemoveMemberParams({ chatId: "-1", user: "@i" }, undefined).ban, false);
    assert.equal(parseRemoveMemberParams({ chatId: "-1", user: "@i", ban: true }, undefined).ban, true);
    assert.equal(parseRemoveMemberParams({ chatId: "-1", user: "@i", ban: "true" }, undefined).ban, true);
    // A typo must not become a ban.
    assert.equal(parseRemoveMemberParams({ chatId: "-1", user: "@i", ban: "yes" }, undefined).ban, false);
    assert.equal(parseRemoveMemberParams({ chatId: "-1", user: "@i", ban: 1 }, undefined).ban, false);
  });
});

describe("parsePromoteAdminParams", () => {
  test("requires a chat and a user", () => {
    assert.throws(() => parsePromoteAdminParams({ user: "@i" }, undefined), /requires a chatId/);
    assert.throws(() => parsePromoteAdminParams({ chatId: "-1" }, undefined), /requires a user/);
  });

  test("promotes with the default admin set", () => {
    const parsed = parsePromoteAdminParams({ chatId: "-1", user: "@i" }, undefined);

    assert.equal(parsed.isAdmin, true);
    assert.deepEqual(parsed.rights, DEFAULT_ADMIN_RIGHTS);
  });

  // Handing out the right to appoint further admins is escalation, not
  // administration — it must be an explicit choice, never part of the default.
  test("does not let a new admin appoint admins unless asked explicitly", () => {
    assert.equal(DEFAULT_ADMIN_RIGHTS.addAdmins, false);
    assert.equal(DEFAULT_ADMIN_RIGHTS.anonymous, false);

    const parsed = parsePromoteAdminParams({ chatId: "-1", user: "@i", rights: { addAdmins: true } }, undefined);

    assert.equal(parsed.rights.addAdmins, true);
  });

  test("merges only known boolean overrides", () => {
    const parsed = parsePromoteAdminParams({
      chatId: "-1",
      user: "@i",
      rights: { banUsers: false, unknownFlag: true, pinMessages: "true" },
    }, undefined);

    assert.equal(parsed.rights.banUsers, false);
    assert.equal((parsed.rights as Record<string, unknown>).unknownFlag, undefined);
    // A string is not a boolean; the default stays.
    assert.equal(parsed.rights.pinMessages, DEFAULT_ADMIN_RIGHTS.pinMessages);
  });

  test("carries an optional custom title", () => {
    assert.equal(parsePromoteAdminParams({ chatId: "-1", user: "@i" }, undefined).rank, undefined);
    assert.equal(parsePromoteAdminParams({ chatId: "-1", user: "@i", rank: " тимлид " }, undefined).rank, "тимлид");
    assert.equal(parsePromoteAdminParams({ chatId: "-1", user: "@i", title: "лид" }, undefined).rank, "лид");
  });
});

describe("parseDemoteAdminParams", () => {
  test("strips every admin right", () => {
    const parsed = parseDemoteAdminParams({ chatId: "-1", user: "@i" }, undefined);

    assert.equal(parsed.isAdmin, false);
    assert.deepEqual(parsed.rights, NO_ADMIN_RIGHTS);
    assert.equal(Object.values(NO_ADMIN_RIGHTS).some(Boolean), false);
  });
});

describe("parseTransferOwnershipParams", () => {
  test("requires a chat and a user", () => {
    assert.throws(() => parseTransferOwnershipParams({ user: "@i" }, undefined), /requires a chatId/);
    assert.throws(() => parseTransferOwnershipParams({ chatId: "-1" }, undefined), /requires a user/);
  });

  test("takes chat and user from the usual aliases", () => {
    const parsed = parseTransferOwnershipParams({ chatId: "-100123", userId: 42 }, undefined);

    assert.equal(parsed.target, "-100123");
    assert.equal(parsed.user, "42");
  });
});

describe("parseInviteLinkParams", () => {
  test("requires a chat", () => {
    assert.throws(() => parseInviteLinkParams({}, undefined), /requires a chatId/);
  });

  test("falls back to the current chat from tool context", () => {
    assert.equal(parseInviteLinkParams({}, { currentChannelId: "-100999" }).target, "-100999");
  });

  test("accepts an expiry as unix seconds or as an ISO date", () => {
    assert.equal(parseInviteLinkParams({ chatId: "-1" }, undefined).expireDate, undefined);
    assert.equal(parseInviteLinkParams({ chatId: "-1", expireDate: 1770000000 }, undefined).expireDate, 1770000000);
    assert.equal(parseInviteLinkParams({ chatId: "-1", expireDate: "1770000000" }, undefined).expireDate, 1770000000);
    assert.equal(
      parseInviteLinkParams({ chatId: "-1", expireDate: "2026-09-01T00:00:00Z" }, undefined).expireDate,
      Math.floor(Date.parse("2026-09-01T00:00:00Z") / 1000),
    );
  });

  test("refuses an expiry it cannot read rather than issuing an eternal link", () => {
    assert.throws(() => parseInviteLinkParams({ chatId: "-1", expireDate: "завтра" }, undefined), /expireDate/);
  });

  test("accepts a usage limit as a positive integer", () => {
    assert.equal(parseInviteLinkParams({ chatId: "-1" }, undefined).usageLimit, undefined);
    assert.equal(parseInviteLinkParams({ chatId: "-1", usageLimit: 5 }, undefined).usageLimit, 5);
    assert.equal(parseInviteLinkParams({ chatId: "-1", usageLimit: "3" }, undefined).usageLimit, 3);
    assert.throws(() => parseInviteLinkParams({ chatId: "-1", usageLimit: 0 }, undefined), /usageLimit/);
    assert.throws(() => parseInviteLinkParams({ chatId: "-1", usageLimit: -2 }, undefined), /usageLimit/);
  });

  test("carries a title and an approval requirement", () => {
    const parsed = parseInviteLinkParams({
      chatId: "-1",
      title: " для новичков ",
      requestNeeded: true,
    }, undefined);

    assert.equal(parsed.title, "для новичков");
    assert.equal(parsed.requestNeeded, true);
    assert.equal(parseInviteLinkParams({ chatId: "-1" }, undefined).requestNeeded, false);
  });
});

/**
 * Management is opt-in, unlike reading: an absent `readChats` means "read
 * anywhere", but an absent `manageChats` must mean "manage nothing". Reading
 * is what the plugin is for; rearranging chats and kicking people is not
 * something a fresh install should be able to do because nobody said no.
 */
describe("isChatManageable", () => {
  test("denies everything when the scope is absent", () => {
    assert.equal(isChatManageable("-100123", undefined), false);
    assert.equal(isChatManageable("-100123", null), false);
    assert.equal(isChatManageable("-100123", []), false);
  });

  test("allows a listed chat and refuses an unlisted one", () => {
    assert.equal(isChatManageable("-100123", [ "-100123" ]), true);
    assert.equal(isChatManageable("-100999", [ "-100123" ]), false);
  });

  test("supports the wildcard", () => {
    assert.equal(isChatManageable("-100123", [ "*" ]), true);
  });

  test("matches the same way read scope does: trimmed, case-insensitive, @-insensitive", () => {
    assert.equal(isChatManageable("@Team_Chat", [ " team_chat " ]), true);
  });
});

describe("isManagementEnabled", () => {
  test("is off until the scope has at least one entry", () => {
    assert.equal(isManagementEnabled(undefined), false);
    assert.equal(isManagementEnabled([]), false);
    assert.equal(isManagementEnabled([ " " ]), false);
    assert.equal(isManagementEnabled([ "-100123" ]), true);
    assert.equal(isManagementEnabled([ "*" ]), true);
  });
});

/**
 * Shapes below mirror what GramJS returns: `className` plus raw TL fields.
 */
describe("resolveCreatedChannelId", () => {
  test("finds the created supergroup in the updates", () => {
    const chatId = resolveCreatedChannelId({
      className: "Updates",
      chats: [ { className: "Channel", id: 123, megagroup: true } ],
    });

    assert.equal(chatId, "-100123");
  });

  test("skips non-channel chats and tolerates an empty answer", () => {
    assert.equal(resolveCreatedChannelId({ chats: [ { className: "Chat", id: 5 } ] }), undefined);
    assert.equal(resolveCreatedChannelId({}), undefined);
    assert.equal(resolveCreatedChannelId(undefined), undefined);
  });

  test("reads a big-integer id the same as a native number", () => {
    const chatId = resolveCreatedChannelId({
      chats: [ { className: "Channel", id: { toString: () => "456" } } ],
    });

    assert.equal(chatId, "-100456");
  });
});

describe("summarizeMissingInvitees", () => {
  test("lists the user ids Telegram refused to add", () => {
    const missing = summarizeMissingInvitees({
      className: "messages.InvitedUsers",
      missingInvitees: [ { userId: 42 }, { userId: { toString: () => "77" } } ],
    });

    assert.deepEqual(missing, [ "42", "77" ]);
  });

  test("reports nothing missing when everyone was added", () => {
    assert.deepEqual(summarizeMissingInvitees({ missingInvitees: [] }), []);
    assert.deepEqual(summarizeMissingInvitees({}), []);
    assert.deepEqual(summarizeMissingInvitees(undefined), []);
  });
});

describe("readInviteLink", () => {
  test("reads the exported link", () => {
    assert.equal(
      readInviteLink({ className: "ChatInviteExported", link: "https://t.me/+abcdef" }),
      "https://t.me/+abcdef",
    );
  });

  test("returns nothing for a shape without a link", () => {
    assert.equal(readInviteLink({}), undefined);
    assert.equal(readInviteLink(undefined), undefined);
    assert.equal(readInviteLink({ link: "   " }), undefined);
  });
});
