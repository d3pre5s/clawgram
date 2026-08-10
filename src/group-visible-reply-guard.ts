import { normalizeOutboundTarget } from "./helpers";

/** When each visible reply went out, keyed by account + chat + incoming message. */
const recentVisibleGroupReplies = new Map<string, number>();
const GROUP_VISIBLE_REPLY_TTL_MS = 10 * 60 * 1000;

/**
 * How long after the agent's own send core's delivery of the same turn's final
 * text still counts as an echo rather than as something new.
 *
 * Measured on the live incident: `handleAction send` at 12:39:02, core's
 * delivery at 12:39:09 — seven seconds, twice in a row. Work that produces
 * genuinely new information takes far longer, and the window has to stay well
 * under that: dropping a real result is worse than letting a duplicate through.
 */
const GROUP_TURN_ECHO_WINDOW_MS = 20 * 1000;

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
}, sentAt: number = Date.now()): void {
  const key = buildVisibleGroupReplyKey(input);
  if (!key) {
    return;
  }

  recentVisibleGroupReplies.set(key, sentAt + GROUP_VISIBLE_REPLY_TTL_MS);
}

/**
 * When a turn last spoke for itself, keyed the same way.
 *
 * Kept apart from `recentVisibleGroupReplies` on purpose: that map drives a
 * ten-minute suppression of repeated sends, and widening what feeds it would
 * quietly make that rule stricter. This one answers a different question —
 * did core just echo the turn that has only now finished.
 */
const lastTurnSends = new Map<string, number>();

/** Records that the agent itself put a message in the chat during this turn. */
export function rememberTurnSend(input: {
  accountId?: string | null;
  chatId: unknown;
  currentMessageId?: string | number | null;
}, sentAt: number = Date.now()): void {
  const key = buildVisibleGroupReplyKey(input);
  if (!key) {
    return;
  }

  lastTurnSends.set(key, sentAt);
}

/**
 * True when this turn already put a visible message in this chat moments ago.
 *
 * The case it exists for: the agent answers by calling `send`, then returns
 * text as well, and core delivers that text as a second message. Both are the
 * same answer — on 2026-08-10 every request in a work chat was reported twice,
 * and the reader had to work out that the two messages were one event.
 *
 * Bounded by `GROUP_TURN_ECHO_WINDOW_MS` rather than by the ten-minute TTL:
 * beyond a few seconds the assistant is coming back with something new, and
 * dropping that would lose a real result.
 */
export function hadTurnSendJustNow(input: {
  accountId?: string | null;
  chatId: unknown;
  currentMessageId?: string | number | null;
}, now: number = Date.now()): boolean {
  const key = buildVisibleGroupReplyKey(input);
  if (!key) {
    return false;
  }

  const sentAt = lastTurnSends.get(key);
  if (sentAt === undefined) {
    return false;
  }

  if (now - sentAt > GROUP_TURN_ECHO_WINDOW_MS) {
    lastTurnSends.delete(key);
    return false;
  }

  return true;
}

/** Test seam: module state must not leak between suites. */
export function resetVisibleGroupReplies(): void {
  recentVisibleGroupReplies.clear();
  lastTurnSends.clear();
}
