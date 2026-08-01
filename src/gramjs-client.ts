import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import type { PluginConfig, ResolvedTelegramTarget, SendMediaArgs, SendTextArgs, ChatType } from "./types.ts";
import { buildTelegramClientOptions, describeProxy, type TelegramProxyConfig } from "./proxy-config";
import { buildHistoryQuery, collectHistoryWindow, type HistoryMessage, type ListMessagesParams } from "./history";

function toStringId(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined;
  try {
    return String(value);
  } catch {
    return undefined;
  }
}

function inferChatTypeFromRaw(raw: string): ChatType {
  if (raw.startsWith("-100")) return "channel";
  if (raw.startsWith("-")) return "group";
  return "direct";
}

function getChatIdFromPeer(peer: any, fallback?: string): string | undefined {
  const userId = toStringId(peer?.userId);
  if (userId) return userId;

  const chatId = toStringId(peer?.chatId);
  if (chatId) return `-${chatId.replace(/^-/, "")}`;

  const channelId = toStringId(peer?.channelId);
  if (channelId) return `-100${channelId.replace(/^-100|-/, "")}`;

  return fallback;
}

function toSafeInteger(value: string): number | undefined {
  if (!/^-?\d+$/.test(value)) {
    return undefined;
  }

  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

function uniqueCandidates(values: unknown[]): unknown[] {
  const seen = new Set<string>();
  const result: unknown[] = [];

  for (const value of values) {
    const key = typeof value === "object" ? String(value) : `${typeof value}:${String(value)}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    result.push(value);
  }

  return result;
}

function parseTargetWithThread(rawTarget: string): {
  raw: string;
  chatId: string;
  messageThreadId?: number;
} {
  const raw = rawTarget.trim();
  const topicMatch = /^(.+?):topic:(\d+)$/.exec(raw);
  if (topicMatch) {
    return {
      raw,
      chatId: topicMatch[1],
      messageThreadId: Number.parseInt(topicMatch[2], 10),
    };
  }

  const colonMatch = /^(.+):(\d+)$/.exec(raw);
  if (colonMatch && /^-?\d+$/.test(colonMatch[1])) {
    return {
      raw,
      chatId: colonMatch[1],
      messageThreadId: Number.parseInt(colonMatch[2], 10),
    };
  }

  return {
    raw,
    chatId: raw,
  };
}

function buildForumReplyParams(messageThreadId?: number, replyToMessageId?: number): {
  replyTo?: number;
  topMsgId?: number;
} {
  const normalizedThreadId = typeof messageThreadId === "number" && Number.isFinite(messageThreadId)
    ? Math.trunc(messageThreadId)
    : undefined;
  const normalizedReplyToId = typeof replyToMessageId === "number" && Number.isFinite(replyToMessageId)
    ? Math.trunc(replyToMessageId)
    : undefined;

  if (!normalizedThreadId || normalizedThreadId <= 1) {
    return normalizedReplyToId ? { replyTo: normalizedReplyToId } : {};
  }

  if (!normalizedReplyToId) {
    return {
      replyTo: normalizedThreadId,
    };
  }

  if (normalizedReplyToId === normalizedThreadId) {
    return {
      replyTo: normalizedReplyToId,
    };
  }

  return {
    replyTo: normalizedReplyToId,
    topMsgId: normalizedThreadId,
  };
}

function buildPeerCandidates(raw: string, kind?: "user" | "group" | "channel"): unknown[] {
  const candidates: unknown[] = [ raw ];
  const numeric = toSafeInteger(raw);
  if (numeric !== undefined) {
    candidates.push(numeric);
  }

  if ((kind === "group" || kind === "channel") && /^\d+$/.test(raw)) {
    const supergroupId = `-100${raw}`;
    const basicGroupId = `-${raw}`;
    candidates.push(supergroupId, toSafeInteger(supergroupId), basicGroupId, toSafeInteger(basicGroupId));
  }

  return uniqueCandidates(candidates.filter((value) => value !== undefined));
}

function collectDialogKeys(dialog: any): Set<string> {
  const keys = new Set<string>();
  const add = (value: unknown) => {
    const id = toStringId(value);
    if (id) {
      keys.add(id);
    }
  };

  add(dialog?.id);
  add(dialog?.inputEntity);
  add(dialog?.entity?.id);
  add(getChatIdFromPeer(dialog?.inputEntity));
  add(getChatIdFromPeer(dialog?.entity));

  const inputChatId = toStringId(dialog?.inputEntity?.chatId);
  if (inputChatId) {
    keys.add(inputChatId);
    keys.add(`-${inputChatId.replace(/^-/, "")}`);
  }

  const inputChannelId = toStringId(dialog?.inputEntity?.channelId);
  if (inputChannelId) {
    keys.add(inputChannelId);
    keys.add(`-100${inputChannelId.replace(/^-100|-/, "")}`);
  }

  return keys;
}

function buildTargetKeys(raw: string, kind?: "user" | "group" | "channel"): Set<string> {
  const keys = new Set<string>();
  const add = (value: unknown) => {
    const id = toStringId(value);
    if (id) {
      keys.add(id);
    }
  };

  add(raw);
  if ((kind === "group" || kind === "channel") && /^\d+$/.test(raw)) {
    add(`-100${raw}`);
    add(`-${raw}`);
  }
  if (raw.startsWith("-100")) {
    add(raw.replace(/^-100/, ""));
  } else if (raw.startsWith("-")) {
    add(raw.replace(/^-/, ""));
  }

  return keys;
}

export class GramJsClientManager {
  private client: TelegramClient;
  private proxy: TelegramProxyConfig | undefined;
  private started = false;

  constructor(private readonly config: PluginConfig) {
    const clientOptions = buildTelegramClientOptions(config.proxy);
    this.proxy = clientOptions.proxy;
    this.client = new TelegramClient(
      new StringSession(config.sessionString),
      config.apiId,
      config.apiHash,
      clientOptions
    );
  }

  /** Credential-free proxy summary (`socks4`/`socks5`) for diagnostics. */
  getProxySummary(): string | undefined {
    return describeProxy(this.proxy);
  }

  async start(): Promise<void> {
    if (this.started) return;

    await this.client.connect();

    const authorized = await this.client.checkAuthorization();
    if (!authorized) {
      throw new Error("GramJS client connected, but session is not authorized.");
    }

    this.started = true;
  }

  async stop(): Promise<void> {
    if (!this.started) return;
    await this.client.disconnect();
    this.started = false;
  }

  getClient(): TelegramClient {
    return this.client;
  }

  async getMe() {
    return this.client.getMe();
  }

  private async resolveDialogPeer(raw: string, kind?: "user" | "group" | "channel"): Promise<ResolvedTelegramTarget | undefined> {
    const targetKeys = buildTargetKeys(raw, kind);
    const dialogs = await this.client.getDialogs({ limit: 200 }).catch(() => []);

    for (const dialog of dialogs as any[]) {
      if (kind === "user" && !dialog?.isUser) {
        continue;
      }
      if ((kind === "group" || kind === "channel") && !dialog?.isGroup && !dialog?.isChannel) {
        continue;
      }

      const dialogKeys = collectDialogKeys(dialog);
      const matched = [ ...targetKeys ].some((key) => dialogKeys.has(key));
      if (!matched) {
        continue;
      }

      const chatId = getChatIdFromPeer(dialog?.inputEntity) ?? toStringId(dialog?.id) ?? raw;
      const chatType =
        kind === "group"
          ? "group"
          : kind === "channel"
            ? "channel"
            : dialog?.isGroup
              ? "group"
              : dialog?.isChannel
                ? "channel"
                : "direct";

      return {
        raw,
        peer: dialog.inputEntity,
        chatId,
        chatType,
      };
    }

    return undefined;
  }

  async resolvePeer(rawTarget: unknown, options?: {
    kind?: "user" | "group" | "channel";
  }): Promise<ResolvedTelegramTarget> {
    if (typeof rawTarget !== "string") {
      const entity = await this.client.getInputEntity(rawTarget as any).catch(() => rawTarget);

      return {
        raw: String(rawTarget ?? ""),
        peer: entity as any
      };
    }

    const parsedTarget = parseTargetWithThread(rawTarget);
    const raw = parsedTarget.raw;
    const chatLookupTarget = parsedTarget.chatId;
    const kind = options?.kind;

    if (raw === "me" || raw === "self" || raw === "saved") {
      return {
        raw,
        peer: "me",
        chatId: "me",
        messageThreadId: parsedTarget.messageThreadId,
        chatType: "direct"
      };
    }

    let entity: unknown;
    for (const candidate of buildPeerCandidates(chatLookupTarget, kind)) {
      entity = await this.client.getInputEntity(candidate as any).catch(() => undefined);
      if (entity) {
        break;
      }
    }

    if (!entity) {
      const dialogResolved = await this.resolveDialogPeer(chatLookupTarget, kind);
      if (dialogResolved) {
        dialogResolved.messageThreadId = parsedTarget.messageThreadId;
        return dialogResolved;
      }
    }

    if (!entity) {
      entity = await this.client.getInputEntity(chatLookupTarget);
    }

    const chatId = getChatIdFromPeer(entity, chatLookupTarget);

    return {
      raw,
      peer: entity as any,
      chatId,
      messageThreadId: parsedTarget.messageThreadId,
      chatType: inferChatTypeFromRaw(chatId ?? raw)
    };
  }

  async sendText(args: SendTextArgs) {
    const resolved = await this.resolvePeer(args.target, { kind: args.targetKind });
    const messageThreadId = args.messageThreadId ?? resolved.messageThreadId;
    const replyParams = buildForumReplyParams(messageThreadId, args.replyToMessageId);

    return this.client.sendMessage(resolved.peer as any, {
      message: args.text,
      ...replyParams,
    });
  }

  /**
   * Reads a window of chat history.
   *
   * Telegram returns newest first and `offsetDate` means "older than this", so
   * an upper bound is expressed by starting there. The lower bound has no
   * server-side equivalent in this call, so it is applied after the fact — which
   * is also why `limit` is the real guard: a window spanning a quiet week and a
   * window spanning a busy hour cost the same request but not the same context.
   */
  async listMessages(args: ListMessagesParams): Promise<{
    chatId?: string;
    messages: HistoryMessage[];
    /** True when `limit` was reached, so the window may be incomplete. */
    truncated: boolean;
  }> {
    const resolved = await this.resolvePeer(args.target);

    const query = buildHistoryQuery(args);

    const fetched = await this.client.getMessages(resolved.peer as any, query as any);
    const raw = Array.isArray(fetched) ? fetched : [];

    return {
      chatId: resolved.chatId,
      messages: collectHistoryWindow(raw, {
        since: args.since,
        until: args.until,
        fallbackChatId: resolved.chatId,
      }),
      truncated: raw.length >= args.limit,
    };
  }

  async markRead(target: unknown, messageId?: number, options?: {
    messageThreadId?: number;
  }): Promise<void> {
    if (!messageId || !Number.isFinite(messageId)) {
      return;
    }

    const resolved = await this.resolvePeer(target);
    const messageThreadId = options?.messageThreadId ?? resolved.messageThreadId;

    if (messageThreadId && messageThreadId > 1) {
      await this.client.invoke(new Api.messages.ReadDiscussion({
        peer: resolved.peer as any,
        msgId: messageThreadId,
        readMaxId: messageId,
      })).catch(() => undefined);
      return;
    }

    await this.client.markAsRead(resolved.peer as any, messageId).catch(() => undefined);
  }

  async withTyping<T>(target: unknown, fn: () => Promise<T>, options?: {
    readMessageId?: number;
    messageThreadId?: number;
  }): Promise<T> {
    let peer: unknown;
    let readMarked = false;
    let stopped = false;
    let activeTick: Promise<void> | undefined;

    const sendTyping = async () => {
      if (!peer) {
        peer = (await this.resolvePeer(target)).peer;
      }

      if (stopped) {
        return;
      }

      if (!readMarked) {
        readMarked = true;
        await this.markRead(peer, options?.readMessageId, {
          messageThreadId: options?.messageThreadId,
        }).catch(() => undefined);
      }

      if (stopped) {
        return;
      }

      await this.client.invoke(new Api.messages.SetTyping({
        peer: peer as any,
        topMsgId: options?.messageThreadId,
        action: new Api.SendMessageTypingAction(),
      }));
    };

    const tick = () => {
      if (stopped || activeTick) {
        return;
      }

      activeTick = sendTyping()
        .catch(() => undefined)
        .finally(() => {
          activeTick = undefined;
        });
    };
    tick();
    const interval = setInterval(tick, 4000);

    try {
      return await fn();
    } finally {
      stopped = true;
      clearInterval(interval);
      await activeTick?.catch(() => undefined);

      if (peer) {
        await this.client.invoke(new Api.messages.SetTyping({
          peer: peer as any,
          action: new Api.SendMessageCancelAction(),
        })).catch(() => undefined);
      }
    }
  }

  async sendMedia(args: SendMediaArgs) {
    const resolved = await this.resolvePeer(args.target);
    const messageThreadId = args.messageThreadId ?? resolved.messageThreadId;
    const replyParams = buildForumReplyParams(messageThreadId, args.replyToMessageId);

    return this.client.sendFile(resolved.peer as any, {
      file: args.file,
      caption: args.caption,
      ...replyParams,
    });
  }
}
