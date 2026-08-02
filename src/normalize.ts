import type { ChatType, NormalizedInbound } from "./types.js";

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

  const text =
    typeof msg.message === "string"
      ? msg.message
      : typeof msg.text === "string"
        ? msg.text
        : undefined;

  const chatType = inferTelegramChatType(msg, chatId);
  const senderUsername =
    typeof msg.sender?.username === "string"
      ? msg.sender.username
      : typeof msg._sender?.username === "string"
        ? msg._sender.username
        : undefined;

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
    channel: "telegram-userbot",
    accountId,
    chatId,
    messageThreadId,
    senderId,
    senderUsername,
    senderDisplay: senderDisplay || undefined,
    messageId,
    text,
    replyToMessageId,
    chatType,
    timestamp: toTimestamp(msg.date),
    isOutgoing: Boolean(msg.out),
    replyTarget,
    raw: event
  };
}
