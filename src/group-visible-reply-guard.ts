import { normalizeOutboundTarget } from "./helpers";

const recentVisibleGroupReplies = new Map<string, number>();
const GROUP_VISIBLE_REPLY_TTL_MS = 10 * 60 * 1000;

function buildVisibleGroupReplyKey(input: {
  accountId?: string | null;
  chatId: unknown;
  currentMessageId?: string | number | null;
}): string | undefined {
  const chatId = normalizeOutboundTarget(String(input.chatId ?? "").trim());
  const currentMessageId = input.currentMessageId === null || input.currentMessageId === undefined
    ? ""
    : String(input.currentMessageId).trim();
  if (!chatId || !currentMessageId) {
    return undefined;
  }

  return [ input.accountId ?? "", chatId, currentMessageId ].join("\n");
}

function pruneExpiredEntries(now: number): void {
  for (const [ key, expiresAt ] of recentVisibleGroupReplies.entries()) {
    if (expiresAt <= now) {
      recentVisibleGroupReplies.delete(key);
    }
  }
}

export function hasRecentVisibleGroupReply(input: {
  accountId?: string | null;
  chatId: unknown;
  currentMessageId?: string | number | null;
}): boolean {
  const now = Date.now();
  pruneExpiredEntries(now);

  const key = buildVisibleGroupReplyKey(input);
  if (!key) {
    return false;
  }

  const expiresAt = recentVisibleGroupReplies.get(key);
  if (!expiresAt) {
    return false;
  }

  if (expiresAt <= now) {
    recentVisibleGroupReplies.delete(key);
    return false;
  }

  return true;
}

export function rememberVisibleGroupReply(input: {
  accountId?: string | null;
  chatId: unknown;
  currentMessageId?: string | number | null;
}): void {
  const key = buildVisibleGroupReplyKey(input);
  if (!key) {
    return;
  }

  recentVisibleGroupReplies.set(key, Date.now() + GROUP_VISIBLE_REPLY_TTL_MS);
}
