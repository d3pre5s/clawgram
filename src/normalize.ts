import type { ChatType, NormalizedInbound } from "./types.js";

import { resolveActiveUsername } from "./helpers";

export function toStringId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    return String(value);
  } catch {
    return undefined;
  }
}

function inferChatType(chatId: string): ChatType {
  if (chatId.startsWith("-100")) return "channel";
  if (chatId.startsWith("-")) return "group";
  return "direct";
}

function inferTelegramChatType(msg: any, chatId: string): ChatType {
  if (msg?.isGroup === true) return "group";
  if (msg?.isChannel === true) return "channel";
  if (chatId.startsWith("-100") && msg?.post !== true) return "group";
  return inferChatType(chatId);
}

export function toPeerChatId(value: unknown): string | undefined {
  const id = toStringId(value);
  if (!id) return undefined;
  return `-${id.replace(/^-/, "")}`;
}

export function toPeerChannelId(value: unknown): string | undefined {
  const id = toStringId(value);
  if (!id) return undefined;
  return `-100${id.replace(/^-100|-/, "")}`;
}

function toTimestamp(value: unknown): number | undefined {
  if (value instanceof Date) {
    return value.getTime();
  }

  if (typeof value === "number" && Number.isFinite(value)) {
    // GramJS message.date may arrive as a Unix timestamp in seconds.
    // OpenClaw expects millisecond timestamps for prompt/runtime metadata.
    return value < 10_000_000_000 ? value * 1000 : value;
  }

  return undefined;
}

function resolveMessageThreadId(msg: any): string | undefined {
  const isForumTopic = msg?.replyTo?.forumTopic === true || msg?.forumTopic === true;
  if (!isForumTopic) {
    return undefined;
  }

  const topId =
    toStringId(msg?.replyTo?.replyToTopId) ??
    toStringId(msg?.replyToTopId);
  if (topId) {
    return topId;
  }

  return (
    toStringId(msg?.replyTo?.replyToMsgId) ??
    toStringId(msg?.replyToMsgId)
  );
}

/**
 * The highlighted fragment of a reply, when there is one.
 *
 * Telegram sends the flag and the text separately, and clients in the wild are
 * not consistent about the flag. The text is the evidence: if `quoteText` has
 * content, a fragment was highlighted regardless of what `quote` says. Blank
 * text is treated as no highlight rather than as an empty one.
 */
function resolveReplyQuote(msg: any): { text?: string; isQuote?: boolean } {
  const raw = msg?.replyTo?.quoteText ?? msg?.quoteText;
  const text = typeof raw === "string" && raw.trim() ? raw : undefined;
  if (!text) return {};
  return { text, isQuote: true };
}

export function normalizeTelegramEvent(event: any, accountId: string): NormalizedInbound | null {
  const msg = event?.message;
  if (!msg) return null;

  const chatId =
    toStringId(msg.chatId) ??
    toStringId(event?.chatId) ??
    toPeerChannelId(msg.peerId?.channelId) ??
    toPeerChatId(msg.peerId?.chatId) ??
    toStringId(msg.peerId?.userId);

  const messageId = toStringId(msg.id);
  if (!chatId || !messageId) return null;

  const senderId =
    toStringId(msg.senderId) ??
    toStringId(msg.fromId?.userId) ??
    toStringId(msg.fromId?.channelId);

  const replyToMessageId =
    toStringId(msg.replyTo?.replyToMsgId) ??
    toStringId(msg.replyToMsgId);
  const messageThreadId = resolveMessageThreadId(msg);
  const replyQuote = resolveReplyQuote(msg);

  const text =
    typeof msg.message === "string"
      ? msg.message
      : typeof msg.text === "string"
        ? msg.text
        : undefined;

  const chatType = inferTelegramChatType(msg, chatId);
  // Not the raw field: a sender holding several handles (or a collectible one)
  // keeps them in `usernames[]` and leaves `username` empty, so an allowFrom
  // entry written as `@handle` would silently never match that person.
  const senderUsername =
    resolveActiveUsername(msg.sender) ?? resolveActiveUsername(msg._sender);

  const senderDisplay =
    typeof msg.sender?.firstName === "string"
      ? [ msg.sender.firstName, msg.sender.lastName ].filter(Boolean).join(" ").trim()
      : typeof msg._sender?.firstName === "string"
        ? [ msg._sender.firstName, msg._sender.lastName ].filter(Boolean).join(" ").trim()
        : undefined;
  const replyTarget =
    msg.inputChat ??
    msg._inputChat ??
    msg.inputSender ??
    msg._inputSender ??
    msg.peerId;

  return {
    channel: "clawgram",
    accountId,
    chatId,
    messageThreadId,
    senderId,
    senderUsername,
    senderDisplay: senderDisplay || undefined,
    messageId,
    text,
    replyToMessageId,
    replyQuoteText: replyQuote.text,
    replyIsQuote: replyQuote.isQuote,
    chatType,
    timestamp: toTimestamp(msg.date),
    isOutgoing: Boolean(msg.out),
    replyTarget,
    raw: event
  };
}
