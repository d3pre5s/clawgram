import { normalizeOutboundTarget } from "./helpers";

const groupReplyAddresses = new Map<string, { address: string; expiresAt: number }>();
const GROUP_REPLY_ADDRESS_TTL_MS = 10 * 60 * 1000;
const GROUP_REPLY_LATEST_ID = "__latest__";


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

  const latestKey = buildGroupReplyAddressKey({
    ...input,
    replyToId: GROUP_REPLY_LATEST_ID,
  });
  if (latestKey) {
    groupReplyAddresses.set(latestKey, {
      address: input.address,
      expiresAt: Date.now() + GROUP_REPLY_ADDRESS_TTL_MS,
    });
  }
}

export function consumeGroupReplyAddress(input: {
  accountId?: string | null;
  chatId: unknown;
  replyToId?: string | number | null;
}): string | undefined {
  const latestKey = buildGroupReplyAddressKey({
    ...input,
    replyToId: GROUP_REPLY_LATEST_ID,
  });
  const key = buildGroupReplyAddressKey(input) ?? latestKey;
  if (!key) {
    return undefined;
  }

  const stored = groupReplyAddresses.get(key);
  if (!stored) {
    return undefined;
  }

  groupReplyAddresses.delete(key);
  if (latestKey) {
    groupReplyAddresses.delete(latestKey);
  }
  if (stored.expiresAt < Date.now()) {
    return undefined;
  }

  return stored.address;
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
