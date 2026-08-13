/**
 * Chat metadata — what a chat *is*, as opposed to what was said in it.
 *
 * Without this the assistant can read a chat and list its members but cannot
 * say which chat it is standing in: the title, whether it is a work supergroup
 * or a one-to-one conversation, whether replies must be addressed to a forum
 * topic. That had to come from a hand-maintained allowlist, which goes stale
 * the moment a chat is renamed.
 *
 * Telegram splits this across two objects — the entity carries the title and
 * the type flags, the full object carries the description, the member count
 * and the pinned message — so both are taken and merged here. Parsing is pure
 * so it can be tested without a Telegram client; the transport lives in
 * `GramJsClientManager.getChatInfo`.
 */

import { resolveActiveUsername } from "./helpers";

export type ChatInfoType = "direct" | "group" | "supergroup" | "channel" | "unknown";

export type ChatInfo = {
  chatId?: string;
  type: ChatInfoType;
  /** Group or channel title; for a direct chat, the person's name. */
  title?: string;
  username?: string;
  /** Absent for direct chats, where it has no meaning. */
  memberCount?: number;
  about?: string;
  /** Forum supergroups address replies by topic, so this changes how to reply. */
  isForum?: boolean;
  /** Pinned messages are where a chat keeps its standing agreements. */
  pinnedMessageId?: string;
  /** Direct chats only. A bot on the other side is not a colleague. */
  isBot?: boolean;
};

export type ChatInfoParams = {
  target: string;
};

export type ChatInfoToolContext = {
  currentChannelId?: string;
} | undefined;

export function parseChatInfoParams(
  params: Record<string, unknown>,
  toolContext: ChatInfoToolContext,
): ChatInfoParams {
  const rawTarget = params.chatId ?? params.target ?? params.to ?? params.chat ?? toolContext?.currentChannelId;
  const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
  if (!target) {
    throw new Error("clawgram: chatInfo requires a chatId");
  }

  return { target };
}

/**
 * GramJS carries ids and counts as `big-integer` objects as often as native
 * numbers — the shape that once made `senderId` come back silently undefined.
 */
function readNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

function readId(value: unknown): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const asString = String(value).trim();
  return asString === "" || asString === "[object Object]" ? undefined : asString;
}

function resolveType(entity: any): ChatInfoType {
  switch (entity?.className) {
    case "User":
      return "direct";
    case "Chat":
      return "group";
    case "Channel":
      return entity.broadcast === true ? "channel" : "supergroup";
    default:
      return "unknown";
  }
}

/** A user has no title, so the displayed name is assembled from what exists. */
function resolveUserTitle(entity: any): string | undefined {
  const parts = [ readString(entity?.firstName), readString(entity?.lastName) ].filter(Boolean);
  return parts.length > 0 ? parts.join(" ") : undefined;
}

export function describeChat(entity: unknown, full: unknown): ChatInfo {
  const raw = entity as any;
  const fullChat = full as any;
  const type = resolveType(raw);

  const info: ChatInfo = {
    chatId: readId(raw?.id),
    type,
    title: type === "direct" ? resolveUserTitle(raw) : readString(raw?.title),
    // Not `raw.username`: an account or chat holding more than one handle keeps
    // them in `usernames[]` and leaves the legacy field empty.
    username: resolveActiveUsername(raw),
    about: readString(fullChat?.about),
    pinnedMessageId: readId(fullChat?.pinnedMsgId),
  };

  if (type === "direct") {
    // Member count is meaningless for a two-person conversation, and reporting
    // "1" or "2" would invite a reader to treat it as a group of that size.
    return { ...info, isBot: raw?.bot === true };
  }

  if (type === "supergroup" || type === "channel") {
    info.isForum = raw?.forum === true;
  }

  // The full object is fetched now; the entity may come from a cache that
  // predates the last few joins, so prefer the fresher number.
  info.memberCount = readNumber(fullChat?.participantsCount) ?? readNumber(raw?.participantsCount);

  return info;
}
