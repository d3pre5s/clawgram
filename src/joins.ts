/**
 * "Someone added this account to a chat" — the one event an assistant needs to
 * learn where it is expected to work, and who put it there.
 *
 * Telegram delivers it as a service message, which the `NewMessage` subscription
 * deliberately drops, so it is recognised here from raw updates instead. Only
 * additions of THIS account are recorded: who else joins a chat is none of our
 * business and would turn the journal into surveillance.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import { toPeerChannelId, toPeerChatId, toStringId } from "./normalize.js";

export const JOINS_DEFAULT_LIMIT = 50;
export const JOINS_MAX_LIMIT = 500;
/** The journal answers "recently", not "since the beginning of time". */
export const JOINS_JOURNAL_MAX_RECORDS = 2000;

export type JoinEvent = {
  chatId: string;
  /** Who put the account here. Absent when Telegram does not say. */
  inviterId?: string;
  /** `added` — someone added us; `link` — we joined by invite link; `created` — the chat was created with us in it. */
  via: "added" | "link" | "created";
  /** ISO-8601 UTC. */
  at: string;
  messageId?: string;
};

function chatIdOf(rawMessage: any): string | undefined {
  return toStringId(rawMessage?.chatId) ??
    toPeerChannelId(rawMessage?.peerId?.channelId) ??
    toPeerChatId(rawMessage?.peerId?.chatId);
}

function atOf(rawMessage: any): string {
  const seconds = Number(rawMessage?.date);
  if (Number.isFinite(seconds) && seconds > 0) {
    return new Date(seconds * 1000).toISOString();
  }
  // A service message without a usable date is still a real event; it is
  // stamped on arrival rather than dropped.
  return new Date().toISOString();
}

function containsId(users: unknown, selfId: string): boolean {
  if (!Array.isArray(users)) return false;
  return users.some((entry) => toStringId(entry) === selfId);
}

/**
 * Returns the join event when THIS account was added, otherwise undefined.
 * Everything is read defensively: raw updates arrive untyped and malformed
 * input must not take the channel down.
 */
export function parseJoinEvent(rawMessage: any, selfId: string | undefined): JoinEvent | undefined {
  if (!selfId) return undefined;

  const action = rawMessage?.action;
  const className = typeof action?.className === "string" ? action.className : undefined;
  if (!className) return undefined;

  const chatId = chatIdOf(rawMessage);
  if (!chatId) return undefined;

  const base = {
    chatId,
    at: atOf(rawMessage),
    messageId: toStringId(rawMessage?.id),
  };
  const fromId = toStringId(rawMessage?.fromId?.userId) ?? toStringId(rawMessage?.senderId);

  if (className === "MessageActionChatAddUser") {
    if (!containsId(action?.users, selfId)) return undefined;
    return { ...base, via: "added", inviterId: fromId };
  }

  if (className === "MessageActionChatJoinedByLink") {
    // The same message is emitted when other people join by link, so it only
    // concerns us when we are the one who joined.
    if (fromId !== undefined && fromId !== selfId) return undefined;
    return { ...base, via: "link", inviterId: toStringId(action?.inviterId) };
  }

  if (className === "MessageActionChatCreate") {
    if (!containsId(action?.users, selfId)) return undefined;
    return { ...base, via: "created", inviterId: fromId };
  }

  return undefined;
}

export function resolveJoinsJournalPath(accountCfg: any, accountId: string): string {
  const configured = accountCfg?.joinsJournalPath;
  if (typeof configured === "string" && configured.trim().length > 0) {
    return configured.trim();
  }
  const safeAccount = accountId.replace(/[^A-Za-z0-9._-]/g, "_");
  return join(homedir(), ".openclaw", "state", "telegram-userbot", `joins-${safeAccount}.jsonl`);
}

export function readJoinRecords(path: string): JoinEvent[] {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => {
      try {
        return JSON.parse(line) as JoinEvent;
      } catch {
        return undefined;
      }
    })
    .filter((entry): entry is JoinEvent => entry !== undefined);
}

/**
 * Appends one event, keeping the journal bounded. A repeated add to the same
 * chat is kept: being re-added after a removal is itself information.
 */
export function appendJoinRecord(path: string, event: JoinEvent): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, JSON.stringify(event) + "\n");

  const records = readJoinRecords(path);
  if (records.length > JOINS_JOURNAL_MAX_RECORDS) {
    const kept = records.slice(records.length - JOINS_JOURNAL_MAX_RECORDS);
    writeFileSync(path, kept.map((entry) => JSON.stringify(entry)).join("\n") + "\n");
  }
}

export function selectJoinRecords(records: JoinEvent[], args: { since?: string; limit: number }): JoinEvent[] {
  const filtered = args.since
    ? records.filter((entry) => typeof entry.at === "string" && entry.at >= args.since!)
    : records;
  return filtered.slice(Math.max(0, filtered.length - args.limit));
}

export function parseJoinsParams(params: Record<string, unknown>): { since?: string; limit: number } {
  const rawSince = params.since;
  let since: string | undefined;
  if (rawSince !== undefined && rawSince !== null && rawSince !== "") {
    if (typeof rawSince !== "string" || Number.isNaN(Date.parse(rawSince))) {
      throw new Error("telegram-userbot: joins since must be an ISO-8601 timestamp");
    }
    since = new Date(rawSince).toISOString();
  }

  const rawLimit = params.limit;
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") {
    return { since, limit: JOINS_DEFAULT_LIMIT };
  }

  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("telegram-userbot: joins limit must be a positive number");
  }

  return { since, limit: Math.min(Math.floor(parsed), JOINS_MAX_LIMIT) };
}
