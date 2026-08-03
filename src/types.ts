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
};

export type SendMediaArgs = {
  target: unknown;
  file: string;
  caption?: string;
  replyToMessageId?: number;
  messageThreadId?: number;
};
