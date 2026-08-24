import { Api, TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
// Deep import, but the documented one: GramJS ships its SRP helper here and
// the package has no `exports` field to forbid it.
import { computeCheck } from "telegram/Password";
import type { PluginConfig, ResolvedTelegramTarget, SendMediaArgs, SendTextArgs, ChatType } from "./types.ts";
import { normalizeParseMode } from "./helpers";
import { renderTelegramHtml } from "./html-render";
import { buildTelegramClientOptions, describeProxy, type TelegramProxyConfig } from "./proxy-config";
import { hasUnresolvedSecretRef } from "./secret-refs";
import { buildHistoryQuery, collectHistoryWindow, normalizeParticipants, type HistoryMessage, type ListMessagesParams, type ListParticipantsParams, type Participant } from "./history";
import { normalizeForumTopics, type ForumTopic, type TopicsParams } from "./topics";
import { normalizeDialogs, type DialogSummary, type DialogsParams } from "./dialogs";
import {
  readInviteLink,
  resolveCreatedChannelId,
  summarizeMissingInvitees,
  type AdminRights,
  type InviteLinkParams,
} from "./manage";

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

/**
 * Membership query for `getParticipants`.
 *
 * The filter has to arrive as a TL constructor. `getParticipants` accepts an
 * unknown `filter` value without complaining and falls back to everyone, so a
 * plain `"admins"` string would return the whole chat under a name promising
 * otherwise — and an allowFrom rebuilt from that list would open a 1000-person
 * chat to all of it.
 */
export function buildParticipantsQuery(args: ListParticipantsParams): Record<string, unknown> {
  const query: Record<string, unknown> = { limit: args.limit };
  if (args.filter === "admins") {
    query.filter = new Api.ChannelParticipantsAdmins();
  }
  return query;
}

/**
 * Voice-message option for `sendFile`.
 *
 * GramJS branches on `voiceNote` and builds `DocumentAttributeAudio` with
 * `voice: true` itself, so the attribute must not be assembled by hand.
 * The key is omitted rather than set to `false`: this codebase already paid
 * for the lesson that a key's mere presence can flip a branch (see the MTProxy
 * note in `proxy-config.ts`).
 *
 * Telegram renders a voice bubble only for Ogg/Opus; core is responsible for
 * handing us that container, which is why the channel does not advertise
 * `transcodesAudio`.
 */
export function buildVoiceNoteParams(asVoice?: boolean): { voiceNote?: true } {
  return asVoice === true ? { voiceNote: true } : {};
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
    // Credentials may be written as SecretRefs; account start-up resolves them
    // before constructing this. Refusing here rather than trusting the caller
    // keeps an unresolved reference from being sent to Telegram as the literal
    // string "[object Object]" — which comes back as a complaint about the
    // credential, not about the secret that failed to resolve.
    if (hasUnresolvedSecretRef(config)) {
      throw new Error(
        "clawgram: account credentials still contain unresolved secret references; "
        + "they must be resolved before the client is created",
      );
    }

    const clientOptions = buildTelegramClientOptions(config.proxy);
    this.proxy = clientOptions.proxy;
    this.client = new TelegramClient(
      new StringSession(config.sessionString as string),
      config.apiId,
      config.apiHash as string,
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

  /**
   * Tears the client down for good.
   *
   * `destroy()`, not `disconnect()`. GramJS runs its update loop as
   * `while (!client._destroyed)` (telegram/client/updates.js), and only
   * `destroy()` sets that flag — `disconnect()` drops the connection and
   * leaves the loop spinning, retrying and logging `Error: TIMEOUT` forever.
   * The manager is thrown away on stop, so losing the event handlers that
   * `destroy()` clears is exactly what we want.
   *
   * This leak was invisible while a config write restarted the whole Gateway.
   * 2.17.0 made channel restarts routine, and the rate then grew by one loop
   * per restart — measured on the owner's server 2026-08-15: ~3 timeouts/min
   * before a restart, ~4.5/min after one.
   */
  async stop(): Promise<void> {
    if (!this.started) return;
    await this.client.destroy();
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

  /**
   * Reply format for this account, validated once at read time.
   * The reply pipeline has no per-call parseMode slot (2.3.1).
   */
  get replyParseMode(): "markdown" | "html" | "none" | undefined {
    return normalizeParseMode((this.config as { replyParseMode?: unknown }).replyParseMode);
  }

  async sendText(args: SendTextArgs) {
    const resolved = await this.resolvePeer(args.target, { kind: args.targetKind });
    const messageThreadId = args.messageThreadId ?? resolved.messageThreadId;
    const replyParams = buildForumReplyParams(messageThreadId, args.replyToMessageId);

    return this.client.sendMessage(resolved.peer as any, {
      // In html mode the text is rendered first: the agent writes markdown,
      // Telegram HTML, or both, and GramJS's HTML parser alone would ship
      // the markdown as literal asterisks (2026-08-12 00:13 UTC, a whole
      // monthly report of them).
      message: args.parseMode === "html" ? renderTelegramHtml(args.text) : args.text,
      // GramJS accepts "md" | "html". `false` switches parsing off — needed
      // because an *absent* mode is not plain text: GramJS then applies its
      // own default markdown parser, and always has. "none" is the honest
      // spelling of "exactly as typed".
      ...(args.parseMode === "none"
        ? { parseMode: false as any }
        : args.parseMode
          ? { parseMode: args.parseMode === "markdown" ? "md" : "html" }
          : {}),
      ...replyParams,
    });
  }

  /**
   * Reads what a chat is: title, type, member count, description, pinned
   * message.
   *
   * Telegram has no single "describe this chat" call — the full object comes
   * from a different method per chat type, and none of them accepts the other's
   * peer. The entity is resolved first precisely to find out which one to ask.
   * A failing full request is not fatal: the entity alone already carries the
   * title and the type, and a partial answer beats an error when the caller
   * only wanted to know where it is.
   */
  async getChatInfo(target: string): Promise<{ entity: unknown; full: unknown }> {
    const resolved = await this.resolvePeer(target);
    const entity = await this.client.getEntity(resolved.peer as any);

    const full = await (async () => {
      switch ((entity as any)?.className) {
        case "Channel":
          return (await this.client.invoke(new Api.channels.GetFullChannel({
            channel: entity as any,
          }))).fullChat;
        case "Chat":
          return (await this.client.invoke(new Api.messages.GetFullChat({
            chatId: (entity as any).id,
          }))).fullChat;
        case "User":
          return (await this.client.invoke(new Api.users.GetFullUser({
            id: entity as any,
          }))).fullUser;
        default:
          return undefined;
      }
    })().catch(() => undefined);

    return { entity, full };
  }

  /**
   * Which reactions a chat permits, or `undefined` when it permits all.
   *
   * Telegram models this three ways on the full chat: absent or
   * `ChatReactionsAll` means everything, `ChatReactionsSome` carries the
   * allowed list, and `ChatReactionsNone` means reactions are switched off —
   * reported here as an empty list, which callers must read as "react with
   * nothing", not as "no restriction".
   *
   * Custom emoji entries are dropped: they need a Premium account to send.
   */
  async getAllowedReactions(target: unknown): Promise<readonly string[] | undefined> {
    const resolved = await this.resolvePeer(target);
    const entity = await this.client.getEntity(resolved.peer as any);

    const full = await (async () => {
      switch ((entity as any)?.className) {
        case "Channel":
          return (await this.client.invoke(new Api.channels.GetFullChannel({
            channel: entity as any,
          }))).fullChat;
        case "Chat":
          return (await this.client.invoke(new Api.messages.GetFullChat({
            chatId: (entity as any).id,
          }))).fullChat;
        default:
          return undefined;
      }
    })();

    const available = (full as any)?.availableReactions;
    switch (available?.className) {
      case "ChatReactionsNone":
        return [];
      case "ChatReactionsSome":
        return (available.reactions ?? [])
          .map((reaction: any) => reaction?.emoticon)
          .filter((emoticon: unknown): emoticon is string => typeof emoticon === "string");
      default:
        return undefined;
    }
  }

  /**
   * Adds or clears this account's reaction on a message.
   *
   * Telegram models "no reaction" as an empty reaction list rather than a
   * separate call, so removal is the same request with nothing in it. A plain
   * account may hold only one reaction per message, which is why removing a
   * specific emoji and clearing collapse to the same thing here.
   */
  async sendReaction(args: {
    target: unknown;
    messageId: number;
    emoji: string;
    remove: boolean;
  }): Promise<void> {
    const resolved = await this.resolvePeer(args.target);

    await this.client.invoke(new Api.messages.SendReaction({
      peer: resolved.peer as any,
      msgId: args.messageId,
      reaction: args.remove ? [] : [ new Api.ReactionEmoji({ emoticon: args.emoji }) ],
    }));
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

    // A topic can be named two ways — `chatId:topic:N` in the target or a
    // `threadId` parameter beside it. The explicit parameter wins; both used to
    // be parsed and then dropped before the query was built.
    const query = buildHistoryQuery({
      ...args,
      messageThreadId: args.messageThreadId ?? resolved.messageThreadId,
    });

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

  /**
   * One message by id, for the sake of the attachment on it.
   *
   * `listMessages` reads a window and reports metadata; this reads a single
   * message and hands the raw GramJS object back, because `downloadMedia`
   * needs the message itself, not a summary of it. Telegram answers a missing
   * or deleted id with a hole in the array rather than an error, so the caller
   * gets `undefined` and says "no such message" instead of throwing something
   * that reads like a transport failure.
   */
  async getMessageById(target: string, messageId: number): Promise<{
    chatId?: string;
    message?: unknown;
  }> {
    const resolved = await this.resolvePeer(target);
    const fetched = await this.client.getMessages(resolved.peer as any, { ids: [ messageId ] } as any);
    const raw = Array.isArray(fetched) ? fetched : [];
    const message = raw.find((entry: any) => entry && entry.className !== "MessageEmpty");

    return { chatId: resolved.chatId, message };
  }

  /**
   * Chat membership, ids only. The caller needs to answer "do we share a group
   * with this person" — an id answers that and a full profile does not, so
   * names and phone numbers are deliberately left out.
   */
  async listParticipants(args: ListParticipantsParams): Promise<{
    chatId?: string;
    participants: Participant[];
    /** True when `limit` was reached, so the membership may be incomplete. */
    truncated: boolean;
  }> {
    const resolved = await this.resolvePeer(args.target);

    const fetched = await this.client.getParticipants(
      resolved.peer as any,
      buildParticipantsQuery(args) as any,
    );
    const raw = Array.isArray(fetched) ? fetched : [];

    return {
      chatId: resolved.chatId,
      participants: normalizeParticipants(raw, { includeNames: args.includeNames }),
      truncated: raw.length >= args.limit,
    };
  }

  /**
   * The group chats this account belongs to.
   *
   * Deliberately thin: `getDialogs` also returns every private conversation,
   * and `normalizeDialogs` drops them before anything else sees the list.
   */
  async listDialogs(args: DialogsParams): Promise<{
    dialogs: DialogSummary[];
    /** True when `limit` was reached, so the account may be in more chats. */
    truncated: boolean;
  }> {
    const fetched = await this.client.getDialogs({ limit: args.limit } as any);
    const raw = Array.isArray(fetched) ? fetched : [];

    return {
      dialogs: normalizeDialogs(raw, { query: args.query }),
      truncated: raw.length >= args.limit,
    };
  }

  /**
   * Topics of a forum supergroup, by name.
   *
   * `q` is passed to Telegram when the caller narrows the list, and the same
   * text is applied again to the result: the server-side search is not
   * guaranteed to be there on every layer, and a filter that silently does
   * nothing is worse than one that runs twice.
   */
  async listTopics(args: TopicsParams): Promise<{
    chatId?: string;
    topics: ForumTopic[];
    /** True when `limit` was reached, so the forum may have more topics. */
    truncated: boolean;
  }> {
    const resolved = await this.resolvePeer(args.target, { kind: "channel" });

    const result: any = await this.client.invoke(new Api.channels.GetForumTopics({
      channel: resolved.peer as any,
      ...(args.query ? { q: args.query } : {}),
      offsetDate: 0,
      offsetId: 0,
      offsetTopic: 0,
      limit: args.limit,
    }));

    const raw = Array.isArray(result?.topics) ? result.topics : [];

    return {
      chatId: resolved.chatId,
      topics: normalizeForumTopics(raw, { query: args.query }),
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

  /**
   * Runs `fn` while the chat shows "typing", and marks the message read.
   *
   * `typing: false` keeps the read receipt and drops the indicator. The two
   * are separable because they promise different things: reading is what the
   * agent did, typing is a promise that words are coming. Under
   * `groupPolicy: "open"` every message starts a turn, and most of those turns
   * end in silence — on 2026-08-17 the management chat watched «Тина
   * печатает…» for 20–26 seconds on each of four messages that were never
   * addressed to her, and nothing followed. An indicator that is not owed to
   * anyone is worse than no indicator.
   */
  async withTyping<T>(target: unknown, fn: () => Promise<T>, options?: {
    readMessageId?: number;
    messageThreadId?: number;
    typing?: boolean;
  }): Promise<T> {
    if (options?.typing === false) {
      // Still a read receipt: she did read it, and the chat may show that.
      const resolvedPeer = await this.resolvePeer(target).then((r) => r.peer).catch(() => undefined);
      if (resolvedPeer) {
        await this.markRead(resolvedPeer, options?.readMessageId, {
          messageThreadId: options?.messageThreadId,
        }).catch(() => undefined);
      }
      return await fn();
    }

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
      // Captions are agent prose too — the outbound path sends `caption ??
      // text` — so they render exactly like sendText does. Before 2.15.0
      // captions carried no mode at all, which meant GramJS's default
      // markdown pass, a third rendering behavior nobody chose.
      caption: args.parseMode === "html" && args.caption
        ? renderTelegramHtml(args.caption)
        : args.caption,
      ...(args.parseMode === "none"
        ? { parseMode: false as any }
        : args.parseMode
          ? { parseMode: args.parseMode === "markdown" ? "md" : "html" }
          : {}),
      ...replyParams,
      ...buildVoiceNoteParams(args.asVoice),
    });
  }

  // ---- Chat management (2.12.0) ----
  //
  // Transport only: parameter parsing, the manageChats gate and the readers
  // for what these calls return live in `manage.ts`, where they are tested.
  // GramJS resolves EntityLike fields itself (every request below carries a
  // `resolve()` step), so user references travel as the strings the caller
  // supplied — `@username` always works; a bare numeric id only when this
  // account has already seen the user.

  /** The account's 2FA password, if configured — needed only to transfer ownership. */
  get twoFaPassword(): string | undefined {
    const value = (this.config as { twoFaPassword?: unknown }).twoFaPassword;
    return typeof value === "string" && value.length > 0 ? value : undefined;
  }

  /** True when the resolved chat is a supergroup/channel rather than a basic group. */
  private isChannelLike(resolved: ResolvedTelegramTarget, fallback: string): boolean {
    const chatType = resolved.chatType ?? inferChatTypeFromRaw(String(resolved.chatId ?? fallback));
    return chatType === "channel";
  }

  /**
   * The id a basic-group request wants: positive, without the `-` the rest of
   * this plugin prefixes. Taken from the resolved peer when possible — that is
   * the exact value Telegram handed us.
   */
  private basicChatId(resolved: ResolvedTelegramTarget, fallback: string): unknown {
    const fromPeer = (resolved.peer as any)?.chatId;
    if (fromPeer !== undefined && fromPeer !== null) {
      return fromPeer;
    }

    return String(resolved.chatId ?? fallback).replace(/^-/, "");
  }

  /**
   * Creates a supergroup (megagroup) and invites the initial members.
   *
   * A supergroup rather than a basic group on purpose: granular admin rights,
   * bans and ownership transfer only exist there, and those are the point of
   * managing a chat. Members are added in a second call because
   * `CreateChannel` does not take them; who could not be added (privacy
   * settings) is reported, not thrown — that is an expected outcome and the
   * caller's cue to send an invite link.
   */
  async createGroup(args: { title: string; about?: string; users: string[] }): Promise<{
    chatId?: string;
    missing: string[];
  }> {
    const updates = await this.client.invoke(new Api.channels.CreateChannel({
      title: args.title,
      about: args.about ?? "",
      megagroup: true,
    }));

    const chatId = resolveCreatedChannelId(updates);
    if (args.users.length === 0) {
      return { chatId, missing: [] };
    }

    // The Channel object out of the same Updates is the most reliable handle:
    // it carries the access hash, and needs no entity-cache round trip.
    const createdEntity = ((updates as any)?.chats ?? []).find(
      (chat: any) => chat?.className === "Channel",
    );
    if (!createdEntity) {
      throw new Error("clawgram: group created, but Telegram's answer carried no channel to invite into");
    }

    const invited = await this.client.invoke(new Api.channels.InviteToChannel({
      channel: createdEntity,
      users: args.users as any,
    }));

    return { chatId, missing: summarizeMissingInvitees(invited) };
  }

  /**
   * Adds members to an existing chat. Supergroups take the whole list in one
   * call and report who was refused; basic groups only add one user per call,
   * so refusals are collected per user instead of failing the batch.
   */
  async addChatMembers(args: { target: string; users: string[] }): Promise<{
    chatId?: string;
    missing: string[];
  }> {
    const resolved = await this.resolvePeer(args.target, { kind: "group" });

    if (this.isChannelLike(resolved, args.target)) {
      const invited = await this.client.invoke(new Api.channels.InviteToChannel({
        channel: resolved.peer as any,
        users: args.users as any,
      }));

      return { chatId: resolved.chatId, missing: summarizeMissingInvitees(invited) };
    }

    const chatId = this.basicChatId(resolved, args.target);
    const missing: string[] = [];
    for (const user of args.users) {
      try {
        // fwdLimit is how much recent history the newcomer sees; 50 is
        // Telegram's own default in official clients.
        await this.client.invoke(new Api.messages.AddChatUser({
          chatId: chatId as any,
          userId: user as any,
          fwdLimit: 50,
        }));
      } catch {
        missing.push(user);
      }
    }

    return { chatId: resolved.chatId, missing };
  }

  /**
   * Removes a member. In a supergroup removal is a ban that may then be
   * lifted: lifting it (the default) leaves the person able to come back by
   * invite, keeping the ban makes the removal stick. Basic groups have no ban
   * concept, so there the two collapse into plain removal.
   */
  async removeChatMember(args: { target: string; user: string; ban: boolean }): Promise<void> {
    const resolved = await this.resolvePeer(args.target, { kind: "group" });

    if (this.isChannelLike(resolved, args.target)) {
      await this.client.invoke(new Api.channels.EditBanned({
        channel: resolved.peer as any,
        participant: args.user as any,
        bannedRights: new Api.ChatBannedRights({ untilDate: 0, viewMessages: true }),
      }));

      if (!args.ban) {
        await this.client.invoke(new Api.channels.EditBanned({
          channel: resolved.peer as any,
          participant: args.user as any,
          bannedRights: new Api.ChatBannedRights({ untilDate: 0 }),
        }));
      }

      return;
    }

    await this.client.invoke(new Api.messages.DeleteChatUser({
      chatId: this.basicChatId(resolved, args.target) as any,
      userId: args.user as any,
      revokeHistory: false,
    }));
  }

  /**
   * Grants or revokes admin rights. Supergroups take the granular set; basic
   * groups only know a boolean, so the rights collapse to `isAdmin` there.
   */
  async setChatAdmin(args: {
    target: string;
    user: string;
    isAdmin: boolean;
    rights: AdminRights;
    rank?: string;
  }): Promise<void> {
    const resolved = await this.resolvePeer(args.target, { kind: "group" });

    if (this.isChannelLike(resolved, args.target)) {
      await this.client.invoke(new Api.channels.EditAdmin({
        channel: resolved.peer as any,
        userId: args.user as any,
        adminRights: new Api.ChatAdminRights({ ...args.rights }),
        rank: args.rank ?? "",
      }));

      return;
    }

    await this.client.invoke(new Api.messages.EditChatAdmin({
      chatId: this.basicChatId(resolved, args.target) as any,
      userId: args.user as any,
      isAdmin: args.isAdmin,
    }));
  }

  /**
   * Hands the chat to a new owner. Telegram demands an SRP proof of the
   * account's 2FA password for this — the one action here that cannot be
   * softened or undone by the old owner, so the proof is the ceremony.
   *
   * The password never leaves this object: it is read from the resolved
   * account config, exchanged for the SRP check, and the check is what goes
   * to Telegram. Callers pass who and where, never the secret.
   */
  async transferChatOwnership(args: { target: string; user: string }): Promise<void> {
    const password = this.twoFaPassword;
    if (!password) {
      throw new Error("clawgram: ownership transfer requires twoFaPassword in the account config");
    }

    const resolved = await this.resolvePeer(args.target, { kind: "group" });
    if (!this.isChannelLike(resolved, args.target)) {
      throw new Error("clawgram: ownership of a basic group cannot be transferred — Telegram only supports this for supergroups");
    }

    const srp = await this.client.invoke(new Api.account.GetPassword());
    const check = await computeCheck(srp, password);

    await this.client.invoke(new Api.channels.EditCreator({
      channel: resolved.peer as any,
      userId: args.user as any,
      password: check,
    }));
  }

  /** Issues an invite link — the path for people whose privacy settings refuse a direct add. */
  async exportChatInviteLink(args: InviteLinkParams): Promise<{ link?: string }> {
    const resolved = await this.resolvePeer(args.target, { kind: "group" });

    const exported = await this.client.invoke(new Api.messages.ExportChatInvite({
      peer: resolved.peer as any,
      ...(args.expireDate !== undefined ? { expireDate: args.expireDate } : {}),
      ...(args.usageLimit !== undefined ? { usageLimit: args.usageLimit } : {}),
      ...(args.title ? { title: args.title } : {}),
      // Presence flips the flag, so the key only exists when asked for —
      // the same lesson the proxy config paid for (see MTProxy note there).
      ...(args.requestNeeded ? { requestNeeded: true } : {}),
    }));

    return { link: readInviteLink(exported) };
  }
}
