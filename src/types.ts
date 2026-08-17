import { GramJsClientManager } from './gramjs-client';
import type { RawTelegramProxyConfig } from './proxy-config';
import type { SecretRefLike } from './secret-refs';

export type RuntimeMap = Map<string, GramJsClientManager>;

export type GroupPolicy = "open" | "mention" | "tag";

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
   * configured on the account. Absent = GramJS's own default, which is
   * its markdown parser, not plain text (discovered 2.15.0); `none` is
   * the explicit way to send exactly as typed.
   */
  replyParseMode?: "markdown" | "md" | "html" | "none";
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
  /**
   * Chats the account may MANAGE (2.12.0): add and remove members, appoint
   * admins, transfer ownership, export invite links; a non-empty list also
   * unlocks `createGroup`. Opposite default to `readChats`: absent means
   * management is off, `[ "*" ]` allows every chat.
   */
  manageChats?: string[];
  /**
   * The account's Telegram 2FA (cloud) password. Needed only by
   * `transferOwnership` — Telegram demands an SRP proof for `EditCreator`.
   * Never logged; see `secret-refs.ts` for the reference form.
   */
  twoFaPassword?: string | SecretRefLike;
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
  /**
   * Outbound format. `html` renders agent markdown/HTML into Telegram HTML
   * first (2.15.0); `markdown` is GramJS's five-delimiter parser; `none`
   * disables parsing entirely — the honest "exactly as typed". Absent keeps
   * the historical GramJS default, which is its markdown parser, not plain
   * text as 2.3.0 believed.
   */
  parseMode?: "markdown" | "html" | "none";
};

export type SendMediaArgs = {
  target: unknown;
  file: string;
  caption?: string;
  /** Caption format, same semantics as {@link SendTextArgs.parseMode} (2.15.0). */
  parseMode?: "markdown" | "html" | "none";
  replyToMessageId?: number;
  messageThreadId?: number;
  /**
   * Deliver as a Telegram voice message rather than an audio document.
   * Core sets this (`asVoice`/`audioAsVoice`) for synthesized speech once the
   * channel advertises `capabilities.tts.voice.synthesisTarget: "voice-note"`.
   */
  asVoice?: boolean;
};
