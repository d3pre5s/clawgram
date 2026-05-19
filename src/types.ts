import { GramJsClientManager } from './gramjs-client';

export type RuntimeMap = Map<string, GramJsClientManager>;

export type GroupPolicy = "open" | "mention";

export type GroupConfig = {
  enabled: boolean;
  groupPolicy: GroupPolicy;
  allowFrom: string[];
};

export type PluginConfig = {
  apiId: number;
  apiHash: string;
  sessionString: string;
  allowFrom: string[];
  groups: Record<string, GroupConfig>;
  accountId?: string;
  enabled?: boolean;
};

export type ChatType = "direct" | "group" | "channel";

export type NormalizedInbound = {
  channel: "telegram-userbot";
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
