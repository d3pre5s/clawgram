/**
 * Reading a window of chat history.
 *
 * The channel could only ever send. An assistant that is expected to summarize
 * what a team wrote during a standup needs to read it, and inbound events do not
 * cover that: under `groupPolicy: "mention"` a message without a mention is
 * dropped at the gate, and nothing is buffered anywhere.
 *
 * Everything here is pure so it can be tested without a Telegram client. The
 * transport call lives in `GramJsClientManager.listMessages`.
 */

export const HISTORY_DEFAULT_LIMIT = 100;
export const HISTORY_MAX_LIMIT = 500;

export type ListMessagesParams = {
  target: string;
  limit: number;
  /** Unix seconds, inclusive. Messages older than this are dropped. */
  since?: number;
  /** Unix seconds, inclusive. Messages newer than this are dropped. */
  until?: number;
  /** Exclusive lower bound by message id — OpenClaw's `--after`. */
  minId?: number;
  /** Exclusive upper bound by message id — OpenClaw's `--before`. */
  maxId?: number;
};

export type HistoryMessage = {
  messageId: string;
  chatId?: string;
  senderId?: string;
  senderUsername?: string;
  senderDisplay?: string;
  text?: string;
  /** Unix seconds — the unit Telegram itself uses for `message.date`. */
  timestamp?: number;
  /**
   * The same instant as ISO 8601 UTC. Redundant on purpose: the consumer is a
   * language model, and epoch arithmetic is exactly the kind of step it gets
   * quietly wrong when summarizing "who wrote during the standup window".
   */
  sentAt?: string;
  replyToMessageId?: string;
  messageThreadId?: string;
  isOutgoing: boolean;
};

/**
 * Matches `normalize.ts` and `gramjs-client.ts` deliberately.
 *
 * GramJS carries ids as `big-integer` instances — plain objects whose `typeof`
 * is "object", not native `bigint`. A `typeof value === "bigint"` check misses
 * every one of them, and the failure is silent: `senderId` simply comes back
 * undefined and a standup summary loses the one field that says who wrote.
 *
 * The `[object Object]` guard catches the opposite mistake — passing a whole
 * Peer instead of the id inside it, which would otherwise produce a plausible
 * looking string.
 */
function toStringId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    const text = String(value);
    return text && text !== "[object Object]" ? text : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Accepts Unix seconds or anything `Date` can parse (ISO 8601 in practice).
 *
 * Milliseconds are converted rather than rejected: a caller reading OpenClaw
 * metadata has millisecond timestamps at hand, and silently treating 1.7e12 as
 * seconds would place the window some fifty thousand years out.
 */
export function parseTimeBoundary(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;

  if (typeof value === "number" && Number.isFinite(value)) {
    if (value <= 0) throw new Error(`telegram-userbot: ${field} must be a positive timestamp`);
    return value >= 10_000_000_000 ? Math.floor(value / 1000) : Math.floor(value);
  }

  if (typeof value === "string") {
    const numeric = Number(value);
    if (Number.isFinite(numeric) && value.trim() !== "") {
      return parseTimeBoundary(numeric, field);
    }
    const parsed = Date.parse(value);
    if (Number.isNaN(parsed)) {
      throw new Error(`telegram-userbot: ${field} is not a valid date: ${value}`);
    }
    return Math.floor(parsed / 1000);
  }

  throw new Error(`telegram-userbot: ${field} must be a timestamp or an ISO 8601 date`);
}

/**
 * `limit` is clamped rather than rejected. A model asking for 10000 messages is
 * making a scale mistake, not a security one, and failing the whole call would
 * teach it nothing useful.
 */
export function parseLimit(value: unknown): number {
  if (value === undefined || value === null || value === "") return HISTORY_DEFAULT_LIMIT;

  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    throw new Error("telegram-userbot: limit must be a number");
  }
  if (numeric < 1) {
    throw new Error("telegram-userbot: limit must be at least 1");
  }
  return Math.min(Math.floor(numeric), HISTORY_MAX_LIMIT);
}

/** Message ids are integers, and confusing one with a date is the bug this exists to prevent. */
export function parseMessageId(value: unknown, field: string): number | undefined {
  if (value === undefined || value === null || value === "") return undefined;

  const numeric = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(numeric) || !Number.isInteger(numeric) || numeric < 1) {
    throw new Error(`telegram-userbot: ${field} must be a positive message id`);
  }
  return numeric;
}

export function parseListMessagesParams(params: Record<string, unknown>): ListMessagesParams {
  const rawTarget = params.chatId ?? params.target ?? params.to ?? params.chat;
  const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
  if (!target) {
    throw new Error("telegram-userbot: list requires a chatId");
  }

  // Only `since`/`until` carry dates. `before`/`after` are NOT accepted here:
  // in OpenClaw's vocabulary they are message ids, and `openclaw message read
  // --before 12345` would otherwise parse an id as a Unix timestamp and quietly
  // place the window in 1970.
  const since = parseTimeBoundary(params.since, "since");
  const until = parseTimeBoundary(params.until, "until");

  if (since !== undefined && until !== undefined && since > until) {
    throw new Error("telegram-userbot: since must not be later than until");
  }

  return {
    target,
    limit: parseLimit(params.limit),
    since,
    until,
    minId: parseMessageId(params.after, "after"),
    maxId: parseMessageId(params.before, "before"),
  };
}

/**
 * Builds the GramJS query for a window.
 *
 * `offsetDate` is Unix seconds (`DateLike = number`) and Telegram documents it
 * exclusive — "messages previous to this date". `until` here is inclusive, so
 * the bound is shifted by a second and the exact bound is re-applied by
 * `isWithinWindow` afterwards. There is no server-side lower bound in this
 * call, which is why `limit` is the real guard: `since` can only be enforced
 * after the fact.
 */
export function buildHistoryQuery(
  args: { limit: number; until?: number; minId?: number; maxId?: number },
): Record<string, unknown> {
  const query: Record<string, unknown> = { limit: args.limit };
  if (args.until !== undefined) {
    query.offsetDate = args.until + 1;
  }
  if (args.minId !== undefined) {
    query.minId = args.minId;
  }
  if (args.maxId !== undefined) {
    query.maxId = args.maxId;
  }
  return query;
}

function normalizeChatKey(value: unknown): string {
  return String(value ?? "").trim().replace(/^@/, "").toLowerCase();
}

/**
 * Read scope for the account, checked before any history call.
 *
 * Sending is gated by whoever asks; reading is not, so the scope has to be
 * declared. This account belongs to a person, not a bot: it sits in family
 * chats and private conversations alongside the work ones, and a model that
 * has been talked into reading the wrong chat pulls that correspondence into
 * a prompt — and from there into whatever it publishes next.
 *
 * An absent list means "no restriction", which keeps the plugin generally
 * usable; a deployment that cares sets `readChats` and gets a hard boundary
 * rather than a sentence in a prompt that a model may be argued out of.
 */
export function isChatReadable(target: unknown, readChats?: unknown): boolean {
  if (readChats === undefined || readChats === null) return true;

  const entries = (Array.isArray(readChats) ? readChats : [ readChats ])
    .map(normalizeChatKey)
    .filter(Boolean);

  // An empty list is a configured empty list — deny, rather than silently
  // reading everything because someone left brackets behind.
  if (entries.length === 0) return false;
  if (entries.includes("*")) return true;

  return entries.includes(normalizeChatKey(target));
}

export function isWithinWindow(timestamp: number | undefined, since?: number, until?: number): boolean {
  // A message without a date cannot be placed in the window. Keeping it only
  // when the window is open avoids silently widening a bounded request.
  if (timestamp === undefined) return since === undefined && until === undefined;
  if (since !== undefined && timestamp < since) return false;
  if (until !== undefined && timestamp > until) return false;
  return true;
}

function readSender(msg: any, key: string): string | undefined {
  const value = msg?.sender?.[key] ?? msg?._sender?.[key];
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function resolveSenderDisplay(msg: any): string | undefined {
  const first = readSender(msg, "firstName");
  const last = readSender(msg, "lastName");
  const joined = [ first, last ].filter(Boolean).join(" ").trim();
  if (joined) return joined;
  return readSender(msg, "title") ?? readSender(msg, "username");
}

/**
 * Deliberately drops `raw`. Inbound events carry it because the runtime may need
 * the original object; history is read straight into a model's context, where an
 * unbounded GramJS structure is both expensive and a way for internals to leak
 * into a prompt.
 */
export function normalizeHistoryMessage(msg: any, fallbackChatId?: string): HistoryMessage | null {
  const messageId = toStringId(msg?.id);
  if (!messageId) return null;

  const text =
    typeof msg?.message === "string" ? msg.message :
    typeof msg?.text === "string" ? msg.text :
    undefined;

  const rawDate = msg?.date;
  let timestamp: number | undefined;
  if (rawDate instanceof Date) {
    timestamp = Math.floor(rawDate.getTime() / 1000);
  } else if (typeof rawDate === "number" && Number.isFinite(rawDate)) {
    timestamp = rawDate >= 10_000_000_000 ? Math.floor(rawDate / 1000) : Math.floor(rawDate);
  }

  return {
    messageId,
    chatId: toStringId(msg?.chatId) ?? fallbackChatId,
    senderId: toStringId(msg?.senderId) ?? toStringId(msg?.fromId?.userId) ?? toStringId(msg?.fromId?.channelId),
    senderUsername: readSender(msg, "username"),
    senderDisplay: resolveSenderDisplay(msg),
    text,
    timestamp,
    sentAt: timestamp === undefined ? undefined : new Date(timestamp * 1000).toISOString(),
    replyToMessageId: toStringId(msg?.replyTo?.replyToMsgId) ?? toStringId(msg?.replyToMsgId),
    messageThreadId: toStringId(msg?.replyTo?.replyToTopId) ?? toStringId(msg?.replyToTopId),
    isOutgoing: msg?.out === true,
  };
}

/**
 * Normalizes, drops what falls outside the window, and returns oldest first —
 * reading order, which is what a summary needs. Telegram hands back newest
 * first, so an unsorted result would have the model reconstruct a conversation
 * backwards.
 */
export function collectHistoryWindow(
  messages: unknown[],
  options: { since?: number; until?: number; fallbackChatId?: string } = {},
): HistoryMessage[] {
  const collected: HistoryMessage[] = [];

  for (const raw of messages ?? []) {
    const normalized = normalizeHistoryMessage(raw, options.fallbackChatId);
    if (!normalized) continue;
    if (!isWithinWindow(normalized.timestamp, options.since, options.until)) continue;
    collected.push(normalized);
  }

  return collected.sort((a, b) => {
    const byTime = (a.timestamp ?? 0) - (b.timestamp ?? 0);
    if (byTime !== 0) return byTime;
    return Number(a.messageId) - Number(b.messageId);
  });
}
