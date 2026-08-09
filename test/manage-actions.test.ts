import assert from "node:assert/strict";
import test, { describe, beforeEach } from "node:test";

import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";

/**
 * Dispatch tests for the chat-management actions. The GramJS transport is
 * faked: what is under test is the wiring — parameter parsing, the
 * `manageChats` gate, `dryRun`, and which client method is reached with what.
 *
 * The gate matters more than the plumbing: these are the first actions that
 * change a chat rather than write into it, and every one of them must be
 * impossible until the account's config says otherwise.
 */

type Call = { method: string; args: Record<string, unknown> };

function makeFakeGram(overrides?: { twoFaPassword?: string }) {
  const calls: Call[] = [];
  const record = (method: string) => (args: Record<string, unknown>) => {
    calls.push({ method, args });
    switch (method) {
      case "createGroup":
        return Promise.resolve({ chatId: "-100555", missing: [] as string[] });
      case "addChatMembers":
        return Promise.resolve({ chatId: "-100123", missing: [ "42" ] });
      case "exportChatInviteLink":
        return Promise.resolve({ link: "https://t.me/+abcdef" });
      default:
        return Promise.resolve(undefined);
    }
  };

  return {
    calls,
    twoFaPassword: overrides?.twoFaPassword,
    createGroup: record("createGroup"),
    addChatMembers: record("addChatMembers"),
    removeChatMember: record("removeChatMember"),
    setChatAdmin: record("setChatAdmin"),
    transferChatOwnership: record("transferChatOwnership"),
    exportChatInviteLink: record("exportChatInviteLink"),
  };
}

const parse = (result: unknown) => JSON.parse(
  typeof result === "string" ? result : (result as any).content?.[ 0 ]?.text ?? "{}",
);

function makeChannel(gram: ReturnType<typeof makeFakeGram>, account: Record<string, unknown>) {
  const runtimes = new Map([ [ "default", gram ] ]) as unknown as RuntimeMap;
  const channel = createChannelPlugin(runtimes) as any;
  const cfg = { channels: { clawgram: { accounts: { default: account } } } };

  const act = (action: string, params: Record<string, unknown>, dryRun?: boolean) =>
    channel.actions.handleAction({ action, params, cfg, accountId: "default", dryRun });

  return { act };
}

describe("chat management is opt-in", () => {
  let gram: ReturnType<typeof makeFakeGram>;
  let act: (action: string, params: Record<string, unknown>, dryRun?: boolean) => Promise<unknown>;

  beforeEach(() => {
    gram = makeFakeGram();
    ({ act } = makeChannel(gram, {}));
  });

  test("createGroup is refused while manageChats is absent", async () => {
    await assert.rejects(
      () => act("createGroup", { title: "Проект" }),
      /management is not enabled/,
    );
    assert.equal(gram.calls.length, 0);
  });

  test("member and admin actions are refused while manageChats is absent", async () => {
    for (const [ action, params ] of [
      [ "addMembers", { chatId: "-100123", users: "@ivan" } ],
      [ "removeMember", { chatId: "-100123", user: "@ivan" } ],
      [ "promoteAdmin", { chatId: "-100123", user: "@ivan" } ],
      [ "demoteAdmin", { chatId: "-100123", user: "@ivan" } ],
      [ "transferOwnership", { chatId: "-100123", user: "@ivan" } ],
      [ "inviteLink", { chatId: "-100123" } ],
    ] as Array<[ string, Record<string, unknown> ]>) {
      await assert.rejects(() => act(action, params), /not-managed-chat/, `${action} should be gated`);
    }
    assert.equal(gram.calls.length, 0);
  });

  test("a chat outside the configured scope is refused", async () => {
    ({ act } = makeChannel(gram, { manageChats: [ "-100123" ] }));

    await assert.rejects(
      () => act("addMembers", { chatId: "-100999", users: "@ivan" }),
      /not-managed-chat/,
    );
    assert.equal(gram.calls.length, 0);
  });
});

describe("createGroup", () => {
  test("creates a supergroup and reports its chat id", async () => {
    const gram = makeFakeGram();
    const { act } = makeChannel(gram, { manageChats: [ "*" ] });

    const payload = parse(await act("createGroup", {
      title: " Проект Альфа ",
      about: "рабочий чат",
      users: [ "@ivan", 42 ],
    }));

    assert.equal(payload.ok, true);
    assert.equal(payload.chatId, "-100555");
    assert.deepEqual(payload.missing, []);
    assert.deepEqual(gram.calls, [ {
      method: "createGroup",
      args: { title: "Проект Альфа", about: "рабочий чат", users: [ "@ivan", "42" ] },
    } ]);
  });

  test("honours dryRun without touching Telegram", async () => {
    const gram = makeFakeGram();
    const { act } = makeChannel(gram, { manageChats: [ "*" ] });

    const payload = parse(await act("createGroup", { title: "Проект" }, true));

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(gram.calls.length, 0);
  });

  test("answers to the createChat alias", async () => {
    const gram = makeFakeGram();
    const { act } = makeChannel(gram, { manageChats: [ "*" ] });

    const payload = parse(await act("createChat", { title: "Проект" }));

    assert.equal(payload.ok, true);
    assert.equal(gram.calls[ 0 ]?.method, "createGroup");
  });
});

describe("addMembers", () => {
  test("passes the parsed users through and surfaces who could not be added", async () => {
    const gram = makeFakeGram();
    const { act } = makeChannel(gram, { manageChats: [ "-100123" ] });

    const payload = parse(await act("addMembers", { chatId: "-100123", members: [ "@ivan", 42 ] }));

    assert.equal(payload.ok, true);
    assert.equal(payload.requested, 2);
    assert.deepEqual(payload.missing, [ "42" ]);
    assert.deepEqual(gram.calls, [ {
      method: "addChatMembers",
      args: { target: "-100123", users: [ "@ivan", "42" ] },
    } ]);
  });

  test("honours dryRun", async () => {
    const gram = makeFakeGram();
    const { act } = makeChannel(gram, { manageChats: [ "*" ] });

    const payload = parse(await act("addMember", { chatId: "-100123", users: "@ivan" }, true));

    assert.equal(payload.dryRun, true);
    assert.equal(gram.calls.length, 0);
  });
});

describe("removeMember", () => {
  test("kicks softly by default and passes an explicit ban through", async () => {
    const gram = makeFakeGram();
    const { act } = makeChannel(gram, { manageChats: [ "-100123" ] });

    const kicked = parse(await act("removeMember", { chatId: "-100123", user: "@ivan" }));
    assert.equal(kicked.ok, true);
    assert.equal(kicked.banned, false);

    const banned = parse(await act("kick", { chatId: "-100123", user: "@ivan", ban: true }));
    assert.equal(banned.banned, true);

    assert.deepEqual(gram.calls.map((call) => call.args.ban), [ false, true ]);
    assert.equal(gram.calls[ 0 ]?.method, "removeChatMember");
  });

  test("honours dryRun", async () => {
    const gram = makeFakeGram();
    const { act } = makeChannel(gram, { manageChats: [ "*" ] });

    const payload = parse(await act("removeMember", { chatId: "-100123", user: "@ivan" }, true));

    assert.equal(payload.dryRun, true);
    assert.equal(gram.calls.length, 0);
  });
});

describe("promoteAdmin / demoteAdmin", () => {
  test("promotes with the default rights and an optional title", async () => {
    const gram = makeFakeGram();
    const { act } = makeChannel(gram, { manageChats: [ "-100123" ] });

    const payload = parse(await act("promoteAdmin", { chatId: "-100123", user: "@ivan", rank: "тимлид" }));

    assert.equal(payload.ok, true);
    assert.equal(payload.isAdmin, true);
    const call = gram.calls[ 0 ];
    assert.equal(call?.method, "setChatAdmin");
    assert.equal(call?.args.isAdmin, true);
    assert.equal(call?.args.rank, "тимлид");
    assert.equal((call?.args.rights as Record<string, unknown>).banUsers, true);
    assert.equal((call?.args.rights as Record<string, unknown>).addAdmins, false);
  });

  test("demotes by stripping every right", async () => {
    const gram = makeFakeGram();
    const { act } = makeChannel(gram, { manageChats: [ "-100123" ] });

    const payload = parse(await act("demoteAdmin", { chatId: "-100123", user: "@ivan" }));

    assert.equal(payload.isAdmin, false);
    const rights = gram.calls[ 0 ]?.args.rights as Record<string, boolean>;
    assert.equal(Object.values(rights).some(Boolean), false);
  });

  test("honours dryRun", async () => {
    const gram = makeFakeGram();
    const { act } = makeChannel(gram, { manageChats: [ "*" ] });

    const payload = parse(await act("promote", { chatId: "-100123", user: "@ivan" }, true));

    assert.equal(payload.dryRun, true);
    assert.equal(gram.calls.length, 0);
  });
});

describe("transferOwnership", () => {
  test("refuses without the account's 2FA password configured", async () => {
    const gram = makeFakeGram();
    const { act } = makeChannel(gram, { manageChats: [ "-100123" ] });

    await assert.rejects(
      () => act("transferOwnership", { chatId: "-100123", user: "@ivan" }),
      /twoFaPassword/,
    );
    assert.equal(gram.calls.length, 0);
  });

  test("transfers when the password is available to the runtime", async () => {
    const gram = makeFakeGram({ twoFaPassword: "correct horse" });
    const { act } = makeChannel(gram, { manageChats: [ "-100123" ] });

    const payload = parse(await act("transferOwner", { chatId: "-100123", userId: 42 }));

    assert.equal(payload.ok, true);
    assert.equal(payload.newOwner, "42");
    assert.deepEqual(gram.calls, [ {
      method: "transferChatOwnership",
      args: { target: "-100123", user: "42" },
    } ]);
  });

  // The password itself must never ride through the dispatch layer: the
  // runtime already holds it, and an args object is one log call away from
  // the journal.
  test("does not pass the password through the call arguments", async () => {
    const gram = makeFakeGram({ twoFaPassword: "correct horse" });
    const { act } = makeChannel(gram, { manageChats: [ "-100123" ] });

    await act("transferOwnership", { chatId: "-100123", user: "@ivan" });

    const args = gram.calls[ 0 ]?.args ?? {};
    assert.equal(Object.values(args).includes("correct horse"), false);
  });

  test("honours dryRun before demanding a password", async () => {
    const gram = makeFakeGram();
    const { act } = makeChannel(gram, { manageChats: [ "*" ] });

    const payload = parse(await act("transferOwnership", { chatId: "-100123", user: "@ivan" }, true));

    assert.equal(payload.dryRun, true);
    assert.equal(gram.calls.length, 0);
  });
});

describe("inviteLink", () => {
  test("exports a link with the parsed options", async () => {
    const gram = makeFakeGram();
    const { act } = makeChannel(gram, { manageChats: [ "-100123" ] });

    const payload = parse(await act("inviteLink", {
      chatId: "-100123",
      usageLimit: 5,
      title: "для новичков",
    }));

    assert.equal(payload.ok, true);
    assert.equal(payload.link, "https://t.me/+abcdef");
    const args = gram.calls[ 0 ]?.args as Record<string, unknown>;
    assert.equal(gram.calls[ 0 ]?.method, "exportChatInviteLink");
    assert.equal(args.usageLimit, 5);
    assert.equal(args.title, "для новичков");
  });

  test("honours dryRun", async () => {
    const gram = makeFakeGram();
    const { act } = makeChannel(gram, { manageChats: [ "*" ] });

    const payload = parse(await act("exportInviteLink", { chatId: "-100123" }, true));

    assert.equal(payload.dryRun, true);
    assert.equal(gram.calls.length, 0);
  });
});

describe("action discovery", () => {
  test("describeMessageTool lists the management actions", () => {
    const gram = makeFakeGram();
    const runtimes = new Map([ [ "default", gram ] ]) as unknown as RuntimeMap;
    const channel = createChannelPlugin(runtimes) as any;
    const cfg = { channels: { clawgram: { accounts: { default: {} } } } };

    const described = channel.actions.describeMessageTool({ cfg, accountId: "default" });

    for (const action of [
      "createGroup", "addMembers", "removeMember",
      "promoteAdmin", "demoteAdmin", "transferOwnership", "inviteLink",
    ]) {
      assert.ok(described.actions.includes(action), `missing action ${action}`);
    }
  });
});
