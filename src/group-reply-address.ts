import { normalizeOutboundTarget } from "./helpers";

const groupReplyAddresses = new Map<string, { address: string; expiresAt: number }>();
const GROUP_REPLY_ADDRESS_TTL_MS = 10 * 60 * 1000;


function normalizeGroupReplyTarget(rawTarget: unknown): string {
  if (typeof rawTarget !== "string") {
    return String(rawTarget ?? "").trim();
  }

  return normalizeOutboundTarget(rawTarget) || rawTarget.trim();
}

function buildGroupReplyAddressKey(input: {
  accountId?: string | null;
  chatId: unknown;
  replyToId?: string | number | null;
}): string | undefined {
  const chatId = normalizeGroupReplyTarget(input.chatId);
  const replyToId = input.replyToId === null || input.replyToId === undefined ? "" : String(input.replyToId).trim();
  if (!chatId || !replyToId) {
    return undefined;
  }

  return [ input.accountId ?? "", chatId, replyToId ].join("\n");
}

export function rememberGroupReplyAddress(input: {
  accountId?: string | null;
  chatId: unknown;
  replyToId?: string | number | null;
  address?: string;
}): void {
  if (!input.address) {
    return;
  }

  const key = buildGroupReplyAddressKey(input);
  if (!key) {
    return;
  }

  groupReplyAddresses.set(key, {
    address: input.address,
    expiresAt: Date.now() + GROUP_REPLY_ADDRESS_TTL_MS,
  });
}

/**
 * The address remembered for one specific incoming message.
 *
 * There used to be a `__latest__` entry as well, so that a send carrying no
 * `replyToId` still greeted somebody. In a chat where requests interleave that
 * "somebody" is whoever spoke last, which on 2026-08-10 put the owner's report
 * out as "@colleague, готово": the colleague read a result they had not asked
 * for, and the owner's own request looked unanswered. Recency is not an answer
 * to "who am I replying to", so the fallback is gone — callers pass the message
 * the turn is actually answering, and no message means no greeting.
 */
export function consumeGroupReplyAddress(input: {
  accountId?: string | null;
  chatId: unknown;
  replyToId?: string | number | null;
}): string | undefined {
  const key = buildGroupReplyAddressKey(input);
  if (!key) {
    return undefined;
  }

  const stored = groupReplyAddresses.get(key);
  if (!stored) {
    return undefined;
  }

  groupReplyAddresses.delete(key);
  if (stored.expiresAt < Date.now()) {
    return undefined;
  }

  return stored.address;
}

/** Test seam: the map is module state, and suites must not leak into each other. */
export function resetGroupReplyAddresses(): void {
  groupReplyAddresses.clear();
}

export function buildGroupReplyAddress(input: {
  senderUsername?: string;
  senderDisplay?: string;
  senderId?: string;
}): string | undefined {
  const username = input.senderUsername?.replace(/^@/, "").trim();
  if (username) {
    return `@${username}`;
  }

  const display = input.senderDisplay?.trim();
  if (display && display !== "Telegram") {
    return display;
  }

  return input.senderId;
}
