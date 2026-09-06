#!/usr/bin/env node
/**
 * Behavioural probe for `handleAction`.
 *
 * Drives every action spelling through the built channel against recording
 * fake runtimes — the same shape the unit tests use — over three account
 * configurations, and records each outcome: the parsed result or the error
 * message, plus every runtime call the action made. The recorded matrix is
 * `action-probe.snapshot.json`; a refactor of `channel.ts` is behaviour-
 * neutral when this script reports zero differences against it.
 *
 * 2.22.0 claimed "354 outcomes, zero differences" for its split of the
 * channel, and the claim could not be checked: the probe lived on one
 * machine (finding D2-05). It lives here now.
 *
 *   npm run build
 *   node scripts/verify/action-probe.cjs            # compare with snapshot
 *   node scripts/verify/action-probe.cjs --write    # (re)record snapshot
 *
 * No Telegram, no credentials, no network. The fakes answer canned data.
 */
"use strict";

const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const SNAPSHOT = path.join(__dirname, "action-probe.snapshot.json");
const WRITE = process.argv.includes("--write");

const { createChannelPlugin } = require(path.join(ROOT, "dist", "channel.js"));

/** Every call reaches the record; the answer is canned and stable. */
function fakeRuntime(record, overrides = {}) {
  const canned = {
    sendText: { id: 1001 },
    sendMedia: { id: 1002 },
    sendReaction: undefined,
    listMessages: { messages: [], chatId: "-1001234" },
    getMessageById: { message: null, chatId: "-1001234" },
    listParticipants: { participants: [], count: 0 },
    listDialogs: { dialogs: [] },
    listTopics: { topics: [] },
    getChatInfo: { entity: { id: 1234, title: "probe", className: "Channel" }, full: {} },
    getAllowedReactions: [ "👍" ],
    createGroup: { chatId: "-1009999", missing: [] },
    addChatMembers: { chatId: "-1001234", missing: [] },
    removeChatMember: undefined,
    setChatAdmin: undefined,
    transferChatOwnership: undefined,
    exportChatInviteLink: { link: "https://t.me/+probe" },
    markRead: undefined,
    resolvePeer: { id: 1234 },
  };
  const runtime = {};
  for (const [ method, answer ] of Object.entries(canned)) {
    runtime[ method ] = async (...args) => {
      record.push({ method, args });
      return answer;
    };
  }
  runtime.getClient = () => {
    record.push({ method: "getClient", args: [] });
    return {};
  };
  return Object.assign(runtime, overrides);
}

/** Three accounts: unrestricted, scoped to one chat, and closed. */
const ACCOUNTS = {
  open: {},
  scoped: {
    readChats: [ "-1001234" ],
    sendChats: [ "-1001234", "42" ],
    manageChats: [ "-1001234" ],
    discoverChats: false,
    operatorIds: [ "42" ],
    twoFaPassword: "probe",
  },
  closed: {
    readChats: [],
    sendChats: [],
    manageChats: [],
  },
};

const IN_SCOPE = "-1001234";
const OUT_OF_SCOPE = "-1005678";

/** Parameter sets per canonical action; each spelling runs every set. */
const PARAM_SETS = {
  send: [
    {},
    { to: IN_SCOPE },
    { to: IN_SCOPE, text: "probe" },
    { to: OUT_OF_SCOPE, text: "probe" },
    { to: `${IN_SCOPE}:5`, text: "probe" },
    { to: "user:42", text: "probe" },
    { to: "+79990000000", text: "probe" },
    { to: IN_SCOPE, text: "NO_REPLY" },
    { to: IN_SCOPE, text: "probe", replyToId: 7 },
    { to: IN_SCOPE, text: "probe", threadId: 5 },
    { to: IN_SCOPE, text: "probe", filePath: "/nonexistent/probe.png" },
    { to: IN_SCOPE, text: "probe", mediaUrl: "https://example.invalid/probe.png" },
  ],
  read: [
    {},
    { chatId: IN_SCOPE },
    { target: IN_SCOPE, limit: 5 },
    { chatId: OUT_OF_SCOPE },
    { chatId: `${IN_SCOPE}:5` },
    { chatId: `clawgram:${IN_SCOPE}:topic:5` },
  ],
  react: [
    {},
    { chatId: IN_SCOPE },
    { chatId: IN_SCOPE, messageId: 7 },
    { chatId: IN_SCOPE, messageId: 7, emoji: "👍" },
    { chatId: IN_SCOPE, messageId: 7, remove: true },
    { chatId: OUT_OF_SCOPE, messageId: 7, emoji: "👍" },
  ],
  joins: [ {}, { limit: 3 } ],
  "upload-file": [
    {},
    { to: IN_SCOPE },
    { to: IN_SCOPE, filePath: "/nonexistent/probe.png" },
    { to: IN_SCOPE, filePath: "/nonexistent/probe.png", caption: "probe" },
    { to: OUT_OF_SCOPE, filePath: "/nonexistent/probe.png" },
    { to: IN_SCOPE, mediaUrl: "https://example.invalid/probe.png" },
  ],
  "fetch-media": [
    {},
    { chatId: IN_SCOPE },
    { chatId: IN_SCOPE, messageId: 7 },
    { chatId: OUT_OF_SCOPE, messageId: 7 },
  ],
  participants: [ {}, { chatId: IN_SCOPE }, { chatId: OUT_OF_SCOPE }, { chatId: IN_SCOPE, limit: 3 } ],
  topics: [ {}, { chatId: IN_SCOPE }, { chatId: OUT_OF_SCOPE } ],
  dialogs: [ {}, { limit: 3 } ],
  chatInfo: [ {}, { chatId: IN_SCOPE }, { chatId: OUT_OF_SCOPE } ],
  createGroup: [ {}, { title: "probe" }, { title: "probe", users: [ "42" ] } ],
  addMembers: [ {}, { chatId: IN_SCOPE }, { chatId: IN_SCOPE, users: [ "42" ] }, { chatId: OUT_OF_SCOPE, users: [ "42" ] } ],
  removeMember: [ {}, { chatId: IN_SCOPE }, { chatId: IN_SCOPE, user: "42" }, { chatId: OUT_OF_SCOPE, user: "42" } ],
  promoteAdmin: [ {}, { chatId: IN_SCOPE, user: "42" }, { chatId: OUT_OF_SCOPE, user: "42" } ],
  demoteAdmin: [ {}, { chatId: IN_SCOPE, user: "42" }, { chatId: OUT_OF_SCOPE, user: "42" } ],
  transferOwnership: [ {}, { chatId: IN_SCOPE, user: "42" }, { chatId: OUT_OF_SCOPE, user: "42" } ],
  inviteLink: [ {}, { chatId: IN_SCOPE }, { chatId: OUT_OF_SCOPE } ],
  unknown: [ {}, { to: IN_SCOPE, text: "probe" } ],
};

/** Every spelling the dispatcher accepts, grouped by what it resolves to. */
const SPELLINGS = {
  send: [ "send" ],
  read: [ "read", "list" ],
  react: [ "react" ],
  joins: [ "joins" ],
  "upload-file": [ "upload-file", "sendAttachment" ],
  "fetch-media": [ "fetch-media", "fetchMedia", "download-media", "downloadMedia", "getMedia", "download-file" ],
  participants: [ "participants", "members", "member-info" ],
  topics: [ "topics", "forumTopics", "thread-list" ],
  dialogs: [ "dialogs", "chats", "channel-list" ],
  chatInfo: [ "chatInfo", "getChatInfo", "channel-info", "chatMetadata", "getChatMetadata" ],
  createGroup: [ "createGroup", "createChat", "create-group", "channel-create" ],
  addMembers: [ "addMembers", "addMember", "add-members", "addParticipant" ],
  removeMember: [ "removeMember", "removeMembers", "remove-member", "kick" ],
  promoteAdmin: [ "promoteAdmin", "promote", "promote-admin", "setAdmin", "role-add" ],
  demoteAdmin: [ "demoteAdmin", "demote", "demote-admin", "role-remove" ],
  transferOwnership: [ "transferOwnership", "transferOwner", "transfer-ownership" ],
  inviteLink: [ "inviteLink", "exportInviteLink", "invite-link" ],
  unknown: [ "no-such-action" ],
};

function parseResult(result) {
  if (typeof result === "string") return JSON.parse(result);
  const text = result?.content?.[ 0 ]?.text;
  return text === undefined ? result : JSON.parse(text);
}

/** Paths and ids vary per machine and run; the shape of the answer does not. */
function stable(value) {
  return JSON.parse(JSON.stringify(value, (_key, v) => {
    if (typeof v === "string" && v.includes(ROOT)) return v.replaceAll(ROOT, "<repo>");
    return v;
  }));
}

async function probeOne({ accountName, account, action, params, dryRun, withRuntime }) {
  const record = [];
  const runtimes = new Map(withRuntime ? [ [ "default", fakeRuntime(record) ] ] : []);
  const channel = createChannelPlugin(runtimes);
  const cfg = { channels: { clawgram: { accounts: { default: account } } } };
  const key = JSON.stringify({ accountName, action, params, dryRun: dryRun ?? null, withRuntime });
  try {
    const result = await channel.actions.handleAction({
      action, params: { ...params }, cfg, accountId: "default", dryRun,
    });
    return { key, outcome: { ok: true, result: stable(parseResult(result)), calls: stable(record) } };
  } catch (error) {
    return { key, outcome: { ok: false, error: String(error?.message ?? error), calls: stable(record) } };
  }
}

async function runMatrix() {
  const outcomes = {};
  for (const [ accountName, account ] of Object.entries(ACCOUNTS)) {
    for (const [ canonical, spellings ] of Object.entries(SPELLINGS)) {
      for (const action of spellings) {
        for (const params of PARAM_SETS[ canonical ]) {
          for (const dryRun of [ undefined, true ]) {
            for (const withRuntime of [ true, false ]) {
              // A missing runtime only matters where the call would reach it;
              // probing every dry run without one adds noise, not coverage.
              if (!withRuntime && dryRun) continue;
              const { key, outcome } = await probeOne({ accountName, account, action, params, dryRun, withRuntime });
              outcomes[ key ] = outcome;
            }
          }
        }
      }
    }
  }
  return outcomes;
}

function diffOutcomes(before, after) {
  const differences = [];
  const keys = new Set([ ...Object.keys(before), ...Object.keys(after) ]);
  for (const key of keys) {
    const a = JSON.stringify(before[ key ]);
    const b = JSON.stringify(after[ key ]);
    if (a !== b) differences.push({ key, before: before[ key ], after: after[ key ] });
  }
  return differences;
}

(async () => {
  // The channel logs through core's logger; probes are quiet.
  const silence = () => {};
  for (const level of [ "log", "info", "warn", "error", "debug" ]) console[ level ] = silence;
  const report = (line) => process.stdout.write(`${line}\n`);

  const outcomes = await runMatrix();
  const total = Object.keys(outcomes).length;
  const refused = Object.values(outcomes).filter((o) => !o.ok).length;

  if (WRITE || !fs.existsSync(SNAPSHOT)) {
    // One outcome per line: a refactor's diff of the snapshot reads as a
    // list of the outcomes it changed, not as a wall of re-indented JSON.
    const lines = Object.entries(outcomes).map(([ k, v ]) => `  ${JSON.stringify(k)}: ${JSON.stringify(v)}`);
    fs.writeFileSync(SNAPSHOT, `{\n${lines.join(",\n")}\n}\n`);
    report(`WROTE ${SNAPSHOT}: ${total} outcomes (${refused} errors, ${total - refused} answers)`);
    return;
  }

  const before = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
  const differences = diffOutcomes(before, outcomes);
  if (differences.length === 0) {
    report(`PASS ${total} outcomes identical to snapshot (${refused} errors, ${total - refused} answers)`);
    return;
  }
  for (const d of differences.slice(0, 20)) {
    report(`--- ${d.key}`);
    report(`  before: ${JSON.stringify(d.before)}`);
    report(`  after:  ${JSON.stringify(d.after)}`);
  }
  report(`FAIL ${differences.length} of ${total} outcomes differ from snapshot`
    + (differences.length > 20 ? " (first 20 shown)" : ""));
  process.exitCode = 1;
})().catch((error) => {
  process.stderr.write(`action-probe crashed: ${error?.stack ?? error}\n`);
  process.exitCode = 2;
});
