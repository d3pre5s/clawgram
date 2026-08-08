import { GramJsClientManager } from './gramjs-client';
import type { RawTelegramProxyConfig } from './proxy-config';
import type { SecretRefLike } from './secret-refs';

export type RuntimeMap = Map<string, GramJsClientManager>;

export type GroupPolicy = "open" | "mention";

export type GroupConfig = {
  enabled: boolean;
  groupPolicy: GroupPolicy;
  allowFrom: string[];
};

export type PluginConfig = {
  apiId: number;
  /**
   * Parse mode for replies (2.3.1). The `send` action takes parseMode
   * per call; the reply pipeline has no per-call slot, so the format is
   * configured on the account. Absent = plain text, as before 2.3.1.
   */
  replyParseMode?: "markdown" | "md" | "html";
  /**
   * Credentials as configured: either the literal value or a SecretRef that
   * account start-up resolves. The client is only ever handed the resolved
   * form — see `secret-refs.ts`.
   */
  apiHash: string | SecretRefLike;
  sessionString: string | SecretRefLike;
  allowFrom: string[];
  groups: Record<string, GroupConfig>;
  /**
   * Chats the account may READ with the `list` action. Absent means no
   * restriction; an empty array denies every read. Independent of `allowFrom`
   * and `groups`, which gate inbound handling, not history access.
   */
  readChats?: string[];
  accountId?: string;
  enabled?: boolean;
  proxy?: RawTelegramProxyConfig;
};

export type ChatType = "direct" | "group" | "channel";

export type NormalizedInbound = {
  channel: "clawgram";
  accountId: string;
  chatId: string;
  messageThreadId?: string;
  senderId?: string;
  senderUsername?: string;
  senderDisplay?: string;
  messageId: string;
  text?: string;
  replyToMessageId?: string;
  /**
   * The fragment the sender highlighted when replying (2.4.0). Telegram keeps
   * it out of the message text — it rides on `MessageReplyHeader.quoteText` —
   * so without lifting it here the gesture is invisible: the agent sees the
   * reply and the parent id, but not which line of the parent was pointed at.
   */
  replyQuoteText?: string;
  /** True when the reply targets a highlighted fragment rather than the whole message. */
  replyIsQuote?: boolean;
  chatType: "direct" | "group" | "channel";
  timestamp?: number;
  isOutgoing: boolean;
  replyTarget?: unknown;
  raw: unknown;
};

export type ResolvedTelegramTarget = {
  raw: string;
  peer: string | number | bigint;
  chatId?: string;
  messageThreadId?: number;
  chatType?: "direct" | "group" | "channel";
};

export type SendTextArgs = {
  target: unknown;
  text: string;
  targetKind?: "user" | "group" | "channel";
  replyToMessageId?: number;
  messageThreadId?: number;
  /** GramJS parse mode; absent = plain text, exactly as before 2.3.0. */
  parseMode?: "markdown" | "html";
};

export type SendMediaArgs = {
  target: unknown;
  file: string;
  caption?: string;
  replyToMessageId?: number;
  messageThreadId?: number;
  /**
   * Deliver as a Telegram voice message rather than an audio document.
   * Core sets this (`asVoice`/`audioAsVoice`) for synthesized speech once the
   * channel advertises `capabilities.tts.voice.synthesisTarget: "voice-note"`.
   */
  asVoice?: boolean;
};
