/**
 * Which chats this account is actually in.
 *
 * Everything else here answers questions about a chat the caller can already
 * name. Nothing answered "where am I now" — the assistant learned that from a
 * service message Telegram sends when somebody adds it, and large supergroups
 * do not send one. A chat could therefore hold the account for weeks while
 * every message from it was dropped as "group not present in groups config",
 * with no trace anywhere that the account was even a member.
 *
 * Discovery is metadata only — id, title, type — and never direct chats: a
 * personal account also sits in family and one-to-one conversations, and
 * enumerating those is the surveillance the read scope exists to prevent.
 * It stays off until the account sets `discoverChats`.
 */
import { toStringId } from "./normalize.js";

export const DIALOGS_DEFAULT_LIMIT = 100;
export const DIALOGS_MAX_LIMIT = 500;

export type DialogChatType = "group" | "supergroup" | "channel";

export type DialogSummary = {
  /** Marked id, exactly as the config and the allowlists spell it. */
  chatId: string;
  title?: string;
  type: DialogChatType;
  /** Only ever true; a chat without topics says so by omission. */
  isForum?: boolean;
};

export type DialogsParams = {
  limit: number;
  query?: string;
};

export function parseDialogsParams(params: Record<string, unknown>): DialogsParams {
  const rawQuery = params.query ?? params.search ?? params.title;
  const trimmedQuery = typeof rawQuery === "string" ? rawQuery.trim() : "";
  const query = trimmedQuery.length > 0 ? trimmedQuery : undefined;

  const rawLimit = params.limit;
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") {
    return { limit: DIALOGS_DEFAULT_LIMIT, query };
  }

  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("clawgram: dialogs limit must be a positive number");
  }

  return { limit: Math.min(Math.floor(parsed), DIALOGS_MAX_LIMIT), query };
}

/** Chat discovery is off unless the account asks for it. */
export function isChatDiscoveryEnabled(discoverChats: unknown): boolean {
  return discoverChats === true;
}

function resolveDialogType(dialog: Record<string, unknown>): DialogChatType | undefined {
  if (dialog.isUser === true) return undefined;
  const entity = (dialog.entity ?? {}) as Record<string, unknown>;

  if (dialog.isChannel === true) {
    // Telegram models supergroups and broadcast channels with one constructor;
    // `megagroup` is what separates "a group with history" from "a feed".
    return entity.megagroup === true ? "supergroup" : "channel";
  }

  return dialog.isGroup === true ? "group" : undefined;
}

function matchesQuery(title: string | undefined, query?: string): boolean {
  if (!query) return true;
  if (!title) return false;
  return title.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

export function normalizeDialogs(
  raw: unknown,
  options: { query?: string } = {},
): DialogSummary[] {
  if (!Array.isArray(raw)) return [];

  const dialogs: DialogSummary[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;

    const dialog = entry as Record<string, unknown>;
    const type = resolveDialogType(dialog);
    if (!type) continue;

    const chatId = toStringId(dialog.id);
    if (!chatId) continue;

    const entity = (dialog.entity ?? {}) as Record<string, unknown>;
    const rawTitle = dialog.title ?? entity.title;
    const title = typeof rawTitle === "string" && rawTitle.length > 0 ? rawTitle : undefined;
    if (!matchesQuery(title, options.query)) continue;

    const summary: DialogSummary = { chatId, type };
    if (title !== undefined) summary.title = title;
    if (entity.forum === true) summary.isForum = true;

    dialogs.push(summary);
  }

  return dialogs;
}
