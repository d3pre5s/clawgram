import {
  buildChannelOutboundSessionRoute,
  createSubsystemLogger,
  jsonResult,
} from "openclaw/plugin-sdk/core";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

/** Attachments above this are left unread: a long recording or a huge image is
 *  a different conversation from a spoken line or a screenshot, and the
 *  transfer is not free. */
const INBOUND_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

/**
 * What this channel promises the Gateway.
 *
 * Annotated with core's own `ChannelCapabilities` on purpose: the shape is read
 * by core (`resolveChannelTtsVoiceDelivery` reaches straight into
 * `capabilities.tts.voice`), so a typo here would not fail — it would silently
 * fall back to a default. With the annotation the compiler checks the promise
 * against the version of OpenClaw we build against.
 */
const CHANNEL_CAPABILITIES: ChannelCapabilities = {
  chatTypes: [ "direct", "group" ],
  reactions: true,
  threads: true,
  media: true,
  nativeCommands: false,
  blockStreaming: false,
  // Without this key core resolves the default "audio-file" and delivers
  // synthesized speech as a document: a grey file card you must download
  // before you know what it is. Advertising "voice-note" makes core mark such
  // sends with `asVoice`, which the upload path honours.
  //
  // `transcodesAudio` is deliberately absent: we ship no ffmpeg and add no
  // dependencies, so core must hand us Ogg/Opus — the only container Telegram
  // renders as a voice bubble.
  tts: {
    voice: {
      synthesisTarget: "voice-note",
    },
  },
};
import { downloadInboundMediaToTempFile } from "./media";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-runtime";
import { readStringOrNumberParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import {
  dispatchInboundDirectDmWithRuntime,
  resolveInboundDirectDmAccessWithRuntime,
} from "openclaw/plugin-sdk/direct-dm";
import {
  resolveInboundMentionDecision,
} from "openclaw/plugin-sdk/channel-inbound";
import { createChannelReplyPipeline } from "openclaw/plugin-sdk/channel-reply-pipeline";
import { resolveInboundRouteEnvelopeBuilderWithRuntime } from "openclaw/plugin-sdk/inbound-envelope";
import type { ResolvedAgentRoute } from "openclaw/plugin-sdk/routing";
import type { ChannelCapabilities } from "openclaw/plugin-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { buildInboundReplyDispatchBase } from "openclaw/plugin-sdk/inbound-reply-dispatch";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { NewMessage, Raw } from "telegram/events";
import { GramJsClientManager } from "./gramjs-client";
import { normalizeTelegramEvent } from "./normalize";
import { isChatReadable, parseListMessagesParams, parseListParticipantsParams } from "./history";
import {
  appendJoinRecord,
  parseJoinEvent,
  parseJoinsParams,
  readJoinRecords,
  resolveJoinsJournalPath,
  selectJoinRecords,
} from "./joins";
import { parseReactionParams, resolveAgentReactionGuidance } from "./reactions";
import { reactToSilentMention } from "./silent-reaction";
import { describeChat, parseChatInfoParams } from "./chat-info";
import {
  applyAccountSecrets,
  collectAccountSecretRefs,
  readSecretInput,
} from "./secret-refs";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import type { PluginConfig, RuntimeMap } from "./types";
import { consumeGroupReplyAddress, rememberGroupReplyAddress, buildGroupReplyAddress } from "./group-reply-address";
import { hasRecentVisibleGroupReply, rememberVisibleGroupReply } from "./group-visible-reply-guard";
import {
  normalizeOutboundTarget,
  resolveConfiguredAccountId,
  inferOutboundTargetKind,
  routeKindFromChatType,
  buildConversationTarget,
  buildScopedGroupPeerId,
  readLatestAssistantFallbackFromTranscript,
  resolveActionTarget,
  resolveReplyToMessageIdForTarget,
  readMessageText,
  readVoiceNoteFlag,
  resolveAllowFrom,
  resolveGroups,
  resolveGroupConfig,
  resolveActiveUsername,
  isSenderAllowed,
  hasTelegramMention,
  toDisplayName,
  prefixReplyTextToAddress,
  stripSilentReplyToken,
  stripTtsDirectives,
  isSilentReplyText,
  resolveReplyTarget,
  resolveChatTarget,
  isReplyToSelfMessage,
  resolveSenderProfile,
  resolveSenderProfileWithTimeout,
  normalizeParseMode,
} from './helpers';
import { resolveProxyConfig } from './proxy-config';
import { CHANNEL_ID } from './constants';

const actionLog = createSubsystemLogger("channels/clawgram");

/** Reads the configured reaction level for an account, tolerating a missing config. */
function readAccountReactionLevel(cfg: any, accountId?: string | null): unknown {
  const resolvedAccountId = resolveConfiguredAccountId(cfg, accountId);
  if (!resolvedAccountId) {
    return undefined;
  }

  return cfg?.channels?.[ CHANNEL_ID ]?.accounts?.[ resolvedAccountId ]?.reactionLevel;
}

/**
 * Wires `reactToSilentMention` to this account's runtime, config and log.
 *
 * The decision itself lives in `silent-reaction.ts`, testable without a
 * Telegram connection; everything here is lookup. Missing pieces — no
 * connected client, no model access — resolve to no reaction rather than to
 * an error, because by this point the agent has already declined to reply.
 */
async function reactToSilentMentionForAccount(params: {
  cfg: any;
  accountId: string;
  gram?: {
    sendReaction: (args: { target: unknown; messageId: number; emoji: string; remove: boolean }) => Promise<void>;
    getAllowedReactions?: (target: unknown) => Promise<readonly string[] | undefined>;
  };
  pluginRuntime?: PluginRuntime;
  chatId: unknown;
  messageId: unknown;
  messageText?: string;
  wasMentioned: boolean;
}): Promise<void> {
  const gram = params.gram;
  const llm = params.pluginRuntime?.llm;
  if (!gram || typeof llm?.complete !== "function") {
    return;
  }

  await reactToSilentMention({
    appetite: resolveAgentReactionGuidance(readAccountReactionLevel(params.cfg, params.accountId)),
    wasMentioned: params.wasMentioned,
    chatId: params.chatId,
    messageId: params.messageId,
    messageText: params.messageText,
    deps: {
      // Bound rather than destructured: the SDK may implement this as a
      // method that needs its receiver.
      complete: (args) => llm.complete(args as any) as Promise<{ text?: string }>,
      sendReaction: (args) => gram.sendReaction(args),
      allowedReactions: gram.getAllowedReactions
        ? () => gram.getAllowedReactions!(params.chatId)
        : undefined,
      onDecision: (info) => actionLog.info("clawgram silent-mention reaction", {
        accountId: params.accountId,
        ...info,
      }),
    },
  });
}

/**
 * Read scope as configured for the account. Left `undefined` when the key is
 * absent so `isChatReadable` can tell "not configured" from "configured empty" —
 * the first means no restriction, the second denies everything.
 */
function readAccountReadChats(account: any): string[] | undefined {
  const raw = account?.readChats;
  if (raw === undefined || raw === null) return undefined;
  const entries = Array.isArray(raw) ? raw : [ raw ];
  return entries.map((entry) => String(entry).trim()).filter(Boolean);
}

function resolveAccountReadChats(cfg: any, accountId: string): string[] | undefined {
  return readAccountReadChats(cfg?.channels?.[ "clawgram" ]?.accounts?.[ accountId ]);
}

function parseOptionalThreadId(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : undefined;
  }

  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || !/^\d+$/.test(trimmed)) {
    return undefined;
  }

  const parsed = Number.parseInt(trimmed, 10);
  return Number.isFinite(parsed) ? parsed : undefined;
}


/**
 * Turns an inbound attachment into text the agent can read.
 *
 * The work is deliberately delegated: `runtime.mediaUnderstanding` already
 * knows which backend this installation uses for speech and for images, so
 * the channel stays out of that choice — a local model today, something else
 * tomorrow, without touching this file.
 *
 * Failure is not an error worth dropping the message over. An attachment that
 * could not be read still happened, and the assistant is better off saying
 * "you sent something I could not read" than staying silent, which is
 * indistinguishable from being offline.
 */
/**
 * Locates the agent directory that image understanding needs.
 *
 * Image models are called with the agent's own credentials, so the pipeline
 * refuses to run without this path — audio does not need it, which is why
 * voice notes worked before images did. The platform exposes no resolver to
 * plugins, so the documented layout is reconstructed here and checked before
 * use: a wrong guess would fail the read anyway, and returning undefined lets
 * the caller degrade instead of throwing.
 */
function resolveAgentDirForMedia(cfg: any): string | undefined {
  const stateDir = typeof process.env.OPENCLAW_STATE_DIR === "string" && process.env.OPENCLAW_STATE_DIR.trim()
    ? process.env.OPENCLAW_STATE_DIR.trim()
    : path.join(os.homedir(), ".openclaw");
  const configuredId = cfg?.agents?.defaults?.id;
  const agentId = typeof configuredId === "string" && configuredId.trim() ? configuredId.trim() : "main";
  const dir = path.join(stateDir, "agents", agentId, "agent");
  return existsSync(dir) ? dir : undefined;
}

async function readInboundAttachment(params: {
  gram: any;
  event: any;
  cfg: any;
  runtime?: PluginRuntime;
  log?: any;
  accountId: string;
  chatId: string;
  messageId: string;
}): Promise<{ text: string; understanding: "transcript" | "description" } | undefined> {
  const media = params.runtime?.mediaUnderstanding;
  const message = params.event?.message;
  if (!media || !message) {
    return undefined;
  }

  let downloaded: Awaited<ReturnType<typeof downloadInboundMediaToTempFile>>;
  try {
    downloaded = await downloadInboundMediaToTempFile({
      client: params.gram.getClient() as any,
      message,
      maxBytes: INBOUND_MEDIA_MAX_BYTES,
      tmpDir: os.tmpdir(),
    });
  } catch (err) {
    params.log?.info?.("clawgram attachment download failed", {
      accountId: params.accountId,
      chatId: params.chatId,
      messageId: params.messageId,
      error: String(err),
    });
    return undefined;
  }

  if (!downloaded) {
    return undefined;
  }

  try {
    const result = downloaded.understanding === "transcript"
      ? await media.transcribeAudioFile({
        filePath: downloaded.path,
        cfg: params.cfg,
        mime: downloaded.mimeType,
      })
      : await media.describeImageFile({
        filePath: downloaded.path,
        cfg: params.cfg,
        mime: downloaded.mimeType,
        agentDir: resolveAgentDirForMedia(params.cfg),
      });
    const read = typeof result?.text === "string" ? result.text.trim() : "";
    if (!read) {
      params.log?.info?.("clawgram attachment read empty", {
        accountId: params.accountId,
        chatId: params.chatId,
        messageId: params.messageId,
        understanding: downloaded.understanding,
      });
      return undefined;
    }
    params.log?.info?.("clawgram attachment read", {
      accountId: params.accountId,
      chatId: params.chatId,
      messageId: params.messageId,
      understanding: downloaded.understanding,
      characters: read.length,
    });
    return { text: read, understanding: downloaded.understanding };
  } catch (err) {
    params.log?.info?.("clawgram attachment read failed", {
      accountId: params.accountId,
      chatId: params.chatId,
      messageId: params.messageId,
      understanding: downloaded.understanding,
      error: String(err),
    });
    return undefined;
  } finally {
    void (async () => {
      try {
        const { rm } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await rm(dirname(downloaded!.path), { recursive: true, force: true });
      } catch {
        // Leaving a temp file behind is not worth failing a delivered message.
      }
    })();
  }
}

export const createChannelPlugin = (runtimes: RuntimeMap, pluginRuntime?: PluginRuntime) => {
  const resolveRuntimeAccountId = (cfg: any, preferred?: string | null): string | undefined => {
    const configured = resolveConfiguredAccountId(cfg, preferred);
    if (configured && runtimes.has(configured)) {
      return configured;
    }

    if (preferred?.trim()) {
      return preferred.trim();
    }

    return configured ?? runtimes.keys().next().value;
  };

  return {
    id: "clawgram",

    meta: {
      id: "clawgram",
      label: "Clawgram",
      selectionLabel: "Clawgram (GramJS)",
      docsPath: "/channels/clawgram",
      blurb:
        "Connect your personal Telegram account to OpenClaw via MTProto. Your AI assistant responds as you.",
      aliases: [ "tguserbot" ],
    },

    capabilities: CHANNEL_CAPABILITIES,

    agentPrompt: {
      // Nothing here steers reactions, and that is deliberate. 2.8.0 added a
      // `reactionGuidance` hook and 2.9.0 moved the same text onto these
      // hints; instrumentation then showed both hooks logging zero
      // invocations across live turns while the assembled prompt stayed
      // byte-identical at 44 266 chars. Core resolves the channel for prompt
      // assembly from `params.messageChannel ?? params.messageProvider`,
      // which is empty on this path, so nothing this channel contributes to
      // the prompt reaches the agent at all. Reactions are decided in code
      // instead — see `reactToSilentMention`. Do not re-add prompt text here
      // expecting it to arrive.
      messageToolHints: () => [
        "Use clawgram to send Telegram replies from the connected personal account.",
        "When replying in the current Telegram chat, omit `to`/`target` and clawgram will send to the current conversation automatically.",
        "Explicit targets may be @username, numeric Telegram user id, phone/contact resolvable by Telegram, group chat ids, or clawgram:<target>.",
        "For Telegram forum topics, send to the group chat id and pass the topic id separately as `threadId`.",
        "Use the `react` action to acknowledge a message with an emoji instead of sending a reply; pass an empty `emoji` (or `remove: true`) to take the reaction back.",
        "Use the `chatInfo` action to learn what a chat is — title, type, member count, description, pinned message — instead of guessing from its id.",
      ],
      messageToolCapabilities: () => [
        "clawgram can reply in the current Telegram conversation when no explicit target is provided.",
        "clawgram can send text messages to direct chats and groups from the connected personal account.",
        "clawgram supports Telegram forum topics via the `threadId` parameter on group sends.",
        "clawgram can add and clear emoji reactions on messages. A plain Telegram account holds one reaction per message, so a new emoji replaces the previous one.",
        "clawgram can describe a chat via `chatInfo`: title, type (direct/group/supergroup/channel), member count, description, whether it is a forum, and the pinned message id.",
      ],
    },

    config: {
      listAccountIds(cfg: any): string[] {
        const accounts = cfg?.channels?.[ "clawgram" ]?.accounts;
        if (!accounts || typeof accounts !== "object") {
          return [];
        }

        return Object.keys(accounts);
      },

      resolveAccount(cfg: any, accountId: string): PluginConfig {
        const account = cfg?.channels?.[ "clawgram" ]?.accounts?.[ accountId ];

        return {
          apiId: Number(account?.apiId),
          apiHash: readSecretInput(account?.apiHash),
          sessionString: readSecretInput(account?.sessionString),
          allowFrom: resolveAllowFrom(account?.allowFrom),
          groups: resolveGroups(account?.groups),
          readChats: readAccountReadChats(account),
          enabled: account?.enabled,
          accountId,
          proxy: resolveProxyConfig(account?.proxy),
          // Field-by-field construction means every new account setting has to
          // be listed here as well: 2.3.1 shipped replyParseMode read by the
          // client from a config object this function had already stripped it
          // from, so the setting validated, deployed and did nothing.
          replyParseMode: account?.replyParseMode,
        };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { account, accountId, channelRuntime, cfg, log } = ctx;

        if (!channelRuntime) {
          throw new Error("clawgram: channelRuntime is required");
        }

        if (runtimes.has(accountId)) {
          log?.warn?.("clawgram stale runtime detected, reconnecting", { accountId });
          await runtimes.get(accountId)?.stop().catch(() => undefined);
          runtimes.delete(accountId);
        }

        // Credentials may be SecretRefs rather than literals. Resolve them here,
        // once per account start, and hand the client only resolved values.
        // Failing loudly beats starting with a blank credential and getting an
        // authentication error that says nothing about the real cause.
        const secretRefs = collectAccountSecretRefs(account);
        let resolvedAccount = account;
        if (secretRefs.length > 0) {
          // `source` is whatever the config says; OpenClaw validates it and
          // reports an unknown source better than a local check would.
          const values = await resolveSecretRefValues(secretRefs as SecretRef[], {
            config: cfg,
            env: process.env,
          });
          const applied = applyAccountSecrets(account, values);
          if (applied.missing.length > 0) {
            // Field names only. The value is what we are protecting, and the
            // reference itself names a location in the secret store.
            throw new Error(
              `clawgram: could not resolve secret references for ${applied.missing.join(", ")}`,
            );
          }

          log?.info?.("clawgram resolved secret references", {
            accountId,
            fields: secretRefs.length,
          });
          resolvedAccount = applied.account;
        }

        const gram = new GramJsClientManager(resolvedAccount);
        await gram.start();
        runtimes.set(accountId, gram);
        const pairing = createChannelPairingController({
          // The controller only reads core.channel.pairing, but its parameter is typed
          // as the full PluginRuntime, and ctx (hence channelRuntime) is untyped.
          core: { channel: channelRuntime } as PluginRuntime,
          channel: "clawgram",
          accountId,
        });

  const me = await gram.getMe();
  const selfId = me?.id ? String(me.id) : undefined;
  const selfUsername = resolveActiveUsername(me);
  const selfLabel = toDisplayName({
    username: selfUsername,
    firstName: typeof (me as any)?.firstName === "string" ? (me as any).firstName : undefined,
    lastName: typeof (me as any)?.lastName === "string" ? (me as any).lastName : undefined,
    fallback: selfId,
        });

        log?.info?.("clawgram connected ------------------------------------------", {
          accountId,
          selfId,
          username: selfUsername,
          proxy: gram.getProxySummary(),
        });

        const client = gram.getClient();
        const eventBuilder = new NewMessage({});
        const eventHandler = async (event: unknown) => {
          try {
            const rawMessage = (event as any)?.message;
            const rawPeerUserId = rawMessage?.peerId?.userId;
            const rawPeerChatId = rawMessage?.peerId?.chatId;
            const rawPeerChannelId = rawMessage?.peerId?.channelId;
            const directLike = rawPeerUserId !== undefined ||
              (typeof rawMessage?.chatId === "number" && rawMessage.chatId > 0);
            if (directLike) {
              log?.info?.("clawgram raw direct-like event", {
                accountId,
                messageId: String(rawMessage?.id ?? ""),
                chatId: String(rawMessage?.chatId ?? ""),
                peerUserId: String(rawPeerUserId ?? ""),
                peerChatId: String(rawPeerChatId ?? ""),
                peerChannelId: String(rawPeerChannelId ?? ""),
                senderId: String(rawMessage?.senderId ?? rawMessage?.fromId?.userId ?? ""),
                out: rawMessage?.out === true,
                textLength: typeof rawMessage?.message === "string" ? rawMessage.message.length : typeof rawMessage?.text === "string" ? rawMessage.text.length : 0,
              });
            }
            const normalized = normalizeTelegramEvent(event, accountId);
            if (!normalized) {
              if (directLike) {
                log?.info?.("clawgram normalize returned null", {
                  accountId,
                  messageId: String(rawMessage?.id ?? ""),
                  chatId: String(rawMessage?.chatId ?? ""),
                  peerUserId: String(rawPeerUserId ?? ""),
                });
              }
              return;
            }

            const directReplyTarget = normalized.chatType === "direct"
              ? undefined
              : await resolveReplyTarget(rawMessage);
            const senderProfile = normalized.chatType === "direct"
              ? await resolveSenderProfileWithTimeout(rawMessage, {
                  senderId: normalized.senderId,
                  client,
                }, 1500)
              : await resolveSenderProfile(rawMessage, {
                  senderId: normalized.senderId,
                  client,
                });

            const replyTarget =
              normalized.chatType === "direct"
                ? normalized.chatId
                : await resolveChatTarget(rawMessage);

            if (replyTarget) {
              normalized.replyTarget = replyTarget;
            }

            if (!normalized.senderUsername && senderProfile.username) {
              normalized.senderUsername = senderProfile.username;
            }

            if (!normalized.senderDisplay && senderProfile.display) {
              normalized.senderDisplay = senderProfile.display;
            }

            if (normalized.isOutgoing) {
              if (normalized.chatType === "direct") {
                log?.info?.("clawgram skipping outgoing direct event", {
                  accountId,
                  chatId: normalized.chatId,
                  messageId: normalized.messageId,
                  senderId: normalized.senderId,
                });
              }
              return;
            }

            if (normalized.chatType === "channel") {
              log?.info?.("clawgram skipping channel inbound", {
                accountId,
                chatId: normalized.chatId,
                chatType: normalized.chatType,
                messageId: normalized.messageId,
              });
              return;
            }

            let text = normalized.text?.trim();

            // An attachment carries no text of its own, and dropping it as
            // "empty" is how the assistant used to go silent on being spoken
            // to or shown something. Read it into the body instead: for a
            // voice note and a screenshot alike, the attachment *is* the
            // message. A caption is kept and the reading appended, because
            // "look at this" plus the picture is one thought, not two.
            const attachment = await readInboundAttachment({
              gram,
              event,
              cfg,
              runtime: pluginRuntime,
              log,
              accountId,
              chatId: normalized.chatId,
              messageId: normalized.messageId,
            });
            if (attachment) {
              const marker = attachment.understanding === "transcript" ? "голосовое" : "изображение";
              const read = `[${marker}] ${attachment.text}`;
              text = text ? `${text}\n\n${read}` : read;
            }

            if (!text) {
              log?.info?.("clawgram skipping empty inbound text", {
                accountId,
                chatId: normalized.chatId,
                messageId: normalized.messageId,
              });
              return;
            }

            const senderId = normalized.senderId ?? normalized.chatId;
            const isTelegramServiceDirect = normalized.chatType === "direct" &&
              (normalized.chatId === "777000" || senderId === "777000");
            const isSavedMessagesDirect = normalized.chatType === "direct" &&
              Boolean(selfId) &&
              normalized.chatId === selfId &&
              senderId === selfId;

            if (isTelegramServiceDirect) {
              log?.info?.("clawgram skipping Telegram service direct chat", {
                accountId,
                chatId: normalized.chatId,
                messageId: normalized.messageId,
                senderId,
              });
              return;
            }

            if (isSavedMessagesDirect) {
              log?.info?.("clawgram skipping Saved Messages direct chat", {
                accountId,
                chatId: normalized.chatId,
                messageId: normalized.messageId,
                senderId,
                selfId,
              });
              return;
            }

            const senderUsername = normalized.senderUsername;
            const senderLabel = normalized.senderDisplay || normalized.senderUsername || senderId;
            const conversationTarget = normalized.chatType === "direct"
              ? normalized.chatId
              : normalized.replyTarget ?? normalized.chatId;
            const conversationFallbackTargets = [
              normalized.chatType === "direct" ? directReplyTarget : undefined,
              normalized.chatType === "direct" ? normalized.replyTarget : undefined,
              normalized.chatType === "direct" && normalized.senderUsername ? `@${normalized.senderUsername}` : undefined,
              normalized.chatId,
            ].filter((target, index, items): target is string | unknown => {
              if (!target || target === conversationTarget) {
                return false;
              }

              return items.findIndex((candidate) => candidate === target) === index;
            });
          const sendTextToConversation = async (args: {
            text: string;
            replyToMessageId?: number;
            messageThreadId?: number;
          }) => {
            const targets = [ conversationTarget, ...conversationFallbackTargets ];
            // Replies have no per-call parseMode slot — the format is an
            // account setting (2.3.1); absent keeps plain text.
            const replyParseMode = gram.replyParseMode;
            let lastError: unknown;

            for (const target of targets) {
              try {
                return await gram.sendText({
                  target,
                  text: args.text,
                  replyToMessageId: args.replyToMessageId,
                  messageThreadId: args.messageThreadId,
                  parseMode: replyParseMode,
                });
              } catch (error) {
                lastError = error;
              }
            }

            throw lastError;
          };
          const accountConfig =
            cfg?.channels?.[ "clawgram" ]?.accounts?.[ accountId ] ??
            cfg?.channels?.[ "clawgram" ] ??
            {};
          const directAllowFrom = resolveAllowFrom(accountConfig?.allowFrom ?? account?.allowFrom);
          const groups = resolveGroups(accountConfig?.groups ?? account?.groups);
          const dmPolicy = "open";

            if (normalized.chatType === "group") {
              const groupConfig = resolveGroupConfig(groups, normalized.chatId);
              if (!groupConfig) {
                log?.info?.("clawgram skipping group not present in groups config", {
                  accountId,
                  chatId: normalized.chatId,
                  messageId: normalized.messageId,
                });
                return;
              }

              if (groupConfig.enabled === false) {
                log?.info?.("clawgram skipping disabled group", {
                  accountId,
                  chatId: normalized.chatId,
                  messageId: normalized.messageId,
                });
                return;
              }

              if (!isSenderAllowed({
                allowFrom: groupConfig.allowFrom,
                senderId,
                senderUsername: normalized.senderUsername,
              })) {
                log?.info?.("clawgram blocking inbound group sender by allowFrom", {
                  accountId,
                  chatId: normalized.chatId,
                  messageId: normalized.messageId,
                  senderId,
                  username: normalized.senderUsername,
                  allowFrom: groupConfig.allowFrom,
                });
                return;
              }

              const scopedGroupPeerId = buildScopedGroupPeerId(accountId, normalized.chatId);
              const { route: inboundRoute, buildEnvelope } = resolveInboundRouteEnvelopeBuilderWithRuntime({
                cfg,
                channel: "clawgram",
                accountId,
                peer: {
                  kind: "group",
                  id: scopedGroupPeerId,
                },
                runtime: channelRuntime,
                sessionStore: cfg?.session?.store,
              });
              // channelRuntime comes from the untyped ctx, so the generic route type falls
              // back to the minimal RouteLike. The runtime value is a ResolvedAgentRoute.
              const route = inboundRoute as ResolvedAgentRoute;
              const wasMentioned = hasTelegramMention({
                cfg,
                agentId: route.agentId,
                selfUsername,
                text,
                message: rawMessage,
              });
              const wasReplyToSelf = await isReplyToSelfMessage(rawMessage, selfId);
              const mentionDecision = resolveInboundMentionDecision({
                facts: {
                  canDetectMention: true,
                  wasMentioned,
                  hasAnyMention: /(^|\s)@[a-zA-Z0-9_]{5,}\b/.test(text),
                },
                policy: {
                  isGroup: true,
                  requireMention: groupConfig.groupPolicy === "mention",
                  allowTextCommands: false,
                  hasControlCommand: false,
                  commandAuthorized: true,
                },
              });

              log?.info?.("clawgram group mention gate", {
                accountId,
                chatId: normalized.chatId,
                messageId: normalized.messageId,
                selfUsername,
                mentionedFlag: rawMessage?.mentioned === true,
                hasEntities: Array.isArray(rawMessage?.entities) ? rawMessage.entities.length : 0,
                wasMentioned,
                wasReplyToSelf,
                shouldSkip: mentionDecision.shouldSkip,
                text,
              });

              if (groupConfig.groupPolicy === "mention" && mentionDecision.shouldSkip && !wasReplyToSelf) {
                log?.info?.("clawgram skipping group message without mention", {
                  accountId,
                  chatId: normalized.chatId,
                  messageId: normalized.messageId,
                  senderId,
                });
                return;
              }

              const { storePath, body } = buildEnvelope({
                channel: "Telegram",
                from: senderLabel,
                body: text,
                timestamp: normalized.timestamp,
              });
              const conversationRouteTarget = buildConversationTarget(normalized.chatId);
              const ctxPayload = channelRuntime.reply.finalizeInboundContext({
                Body: body,
                BodyForAgent: text,
                RawBody: text,
                CommandBody: text,
                From: conversationRouteTarget,
                To: conversationRouteTarget,
                SessionKey: route.sessionKey,
                AccountId: route.accountId ?? accountId,
                ChatType: "group",
                ConversationLabel: senderLabel,
                SenderId: senderId,
                SenderUsername: normalized.senderUsername,
                SenderName: normalized.senderDisplay,
                GroupId: normalized.chatId,
                GroupSubject: normalized.chatId,
                WasMentioned: mentionDecision.effectiveWasMentioned || wasReplyToSelf,
                WasReplyToSelf: wasReplyToSelf,
                Provider: "telegram",
                Surface: "clawgram",
                MessageSid: normalized.messageId,
                MessageSidFull: normalized.messageId,
                Timestamp: normalized.timestamp,
                ReplyToId: normalized.replyToMessageId,
                // Core renders these itself as `[Replying to: "…"]` ahead of the
                // user body — it keys off Provider being "telegram", which is set
                // below. Without them a highlighted reply reaches the agent as
                // bare text, and the fragment the person pointed at is lost.
                ReplyToQuoteText: normalized.replyQuoteText,
                ReplyToIsQuote: normalized.replyIsQuote,
                MessageThreadId: normalized.messageThreadId,
                NativeChannelId: normalized.chatId,
                OriginatingChannel: "clawgram",
                OriginatingTo: conversationRouteTarget,
              });
              const groupReplyAddress = buildGroupReplyAddress({
                senderUsername: normalized.senderUsername,
                senderDisplay: normalized.senderDisplay,
                senderId,
              });
              rememberGroupReplyAddress({
                accountId: route.accountId ?? accountId,
                chatId: normalized.chatId,
                replyToId: normalized.messageId,
                address: groupReplyAddress,
              });

              const messageThreadId = parseOptionalThreadId(normalized.messageThreadId);
              const groupTypingTarget = normalized.chatId;

              await gram.withTyping(groupTypingTarget, async () => {
                log?.info?.("clawgram dispatching group reply", {
                  accountId,
                  chatId: normalized.chatId,
                  messageId: normalized.messageId,
                  routeSessionKey: route.sessionKey,
                  storePath,
                });

                await channelRuntime.session.recordInboundSession({
                  storePath,
                  sessionKey: ctxPayload.SessionKey ?? route.sessionKey,
                  ctx: ctxPayload,
                  updateLastRoute: {
                    sessionKey: route.sessionKey,
                    channel: CHANNEL_ID,
                    to: conversationRouteTarget,
                    accountId: route.accountId ?? accountId,
                  },
                  onRecordError: (err) => {
                    log?.info?.("clawgram failed to update group last route", {
                      accountId,
                      chatId: normalized.chatId,
                      messageId: normalized.messageId,
                      error: String(err),
                    });
                  },
                });

                const dispatchBase = buildInboundReplyDispatchBase({
                  cfg,
                  channel: "clawgram",
                  accountId: route.accountId ?? accountId,
                  route,
                  storePath,
                  ctxPayload,
                  core: { channel: channelRuntime },
                });
                const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
                  cfg,
                  agentId: route.agentId,
                  channel: "clawgram",
                  accountId: route.accountId ?? accountId,
                });
                // Boundary for the transcript fallback below: only replies
                // written after this instant may be salvaged. Same clock as
                // the transcript writer — both live in this process.
                const dispatchStartedAt = Date.now();
                const dispatchResult = await dispatchBase.dispatchReplyWithBufferedBlockDispatcher({
                  ctx: ctxPayload,
                  cfg,
                  dispatcherOptions: {
                    ...replyPipeline,
                    deliver: async (payload) => {
                      const outboundText = typeof payload.text === "string" ? payload.text.trim() : "";
                      log?.info?.("clawgram deliver group payload", {
                        accountId,
                        chatId: normalized.chatId,
                        messageId: normalized.messageId,
                        payloadText: outboundText,
                        payloadReplyToId: payload.replyToId ?? null,
                      });
                      if (!outboundText) {
                        return;
                      }

                      // The agent may decline to answer by returning the shared
                      // silent token. Drop it before addressing: otherwise the
                      // reply-address prefix turns it into a visible message.
                      const visibleText = stripSilentReplyToken(outboundText);
                      if (!visibleText) {
                        log?.info?.("clawgram suppressing silent group reply", {
                          accountId,
                          chatId: normalized.chatId,
                          messageId: normalized.messageId,
                        });
                        return;
                      }

                      const replyToMessageId = payload.replyToId ? Number(payload.replyToId) : Number(normalized.messageId);
                      const rememberedAddress = consumeGroupReplyAddress({
                        accountId: route.accountId ?? accountId,
                        chatId: normalized.chatId,
                        replyToId: payload.replyToId ?? normalized.messageId,
                      });

                      await sendTextToConversation({
                        text: prefixReplyTextToAddress(visibleText, rememberedAddress ?? groupReplyAddress),
                        replyToMessageId,
                        messageThreadId,
                      });
                    },
                    onError: (err, info) => {
                      log?.error?.("clawgram failed to dispatch group reply", {
                        accountId,
                        chatId: normalized.chatId,
                        messageId: normalized.messageId,
                        kind: info.kind,
                        error: String(err),
                      });
                    },
                  },
                  replyOptions: {
                    onModelSelected,
                  },
                });

                log?.info?.("clawgram group dispatch completed", {
                  accountId,
                  chatId: normalized.chatId,
                  messageId: normalized.messageId,
                  queuedFinal: dispatchResult?.queuedFinal ?? null,
                  counts: dispatchResult?.counts ?? null,
                });

                const dispatchCounts = dispatchResult?.counts ?? { tool: 0, block: 0, final: 0 };
                const nothingDelivered = dispatchResult?.queuedFinal !== true &&
                  (dispatchCounts.tool ?? 0) === 0 &&
                  (dispatchCounts.block ?? 0) === 0 &&
                  (dispatchCounts.final ?? 0) === 0;

                if (nothingDelivered) {
                  const fallbackText = readLatestAssistantFallbackFromTranscript(route.sessionKey, storePath, dispatchStartedAt);
                  // A suppressed silent reply legitimately delivers nothing, so
                  // this fallback fires right after it. Without the same check
                  // the token would be read back from the transcript and sent.
                  //
                  // TTS markup needs the same treatment for the same reason:
                  // core strips it on the normal reply path, but this text comes
                  // straight out of the transcript. On 2026-08-08 a group got
                  // `[[tts:text]]Привет, Вася!…[[/tts:text]]` verbatim. The
                  // spoken words are kept — a synthesis that did not happen
                  // should degrade to readable text, not to markup.
                  const visibleFallbackText = fallbackText
                    ? stripTtsDirectives(stripSilentReplyToken(fallbackText))
                    : "";
                  if (!visibleFallbackText) {
                    if (fallbackText) {
                      log?.info?.("clawgram skipping silent transcript fallback", {
                        accountId,
                        chatId: normalized.chatId,
                        messageId: normalized.messageId,
                        routeSessionKey: route.sessionKey,
                      });
                    } else {
                      log?.warn?.("clawgram transcript fallback unavailable", {
                        accountId,
                        chatId: normalized.chatId,
                        messageId: normalized.messageId,
                        routeSessionKey: route.sessionKey,
                      });
                    }

                    // Named, and nothing came back: leave a reaction so the
                    // decision is visible instead of reading as her ignoring
                    // people. The condition is her silence, not the shape of
                    // the transcript — a turn that wrote no entry at all is
                    // just as silent as one that wrote the NO_REPLY token.
                    //
                    // Never allowed to disturb the turn: the reply is already
                    // settled by this point, so a failure here stays silent.
                    await reactToSilentMentionForAccount({
                      cfg,
                      accountId,
                      gram: runtimes.get(accountId),
                      pluginRuntime,
                      chatId: normalized.chatId,
                      messageId: normalized.messageId,
                      messageText: normalized.text,
                      // Same sense of "addressed" the agent was given for this
                      // turn on line 817: a reply to her own message counts as
                      // being spoken to, mention or not.
                      wasMentioned: mentionDecision.effectiveWasMentioned || wasReplyToSelf,
                    }).catch((err) => {
                      log?.info?.("clawgram silent-mention reaction failed", {
                        accountId,
                        chatId: normalized.chatId,
                        messageId: normalized.messageId,
                        error: String(err),
                      });
                    });
                  } else {
                    log?.warn?.("clawgram using transcript fallback reply", {
                      accountId,
                      chatId: normalized.chatId,
                      messageId: normalized.messageId,
                      routeSessionKey: route.sessionKey,
                      fallbackText: visibleFallbackText,
                    });

                    await sendTextToConversation({
                      text: prefixReplyTextToAddress(visibleFallbackText, groupReplyAddress),
                      replyToMessageId: Number(normalized.messageId),
                      messageThreadId,
                    });
                  }
                }
              }, {
                readMessageId: Number(normalized.messageId),
                messageThreadId,
              });

              log?.info?.("clawgram group inbound handled", {
                accountId,
                chatId: normalized.chatId,
                messageId: normalized.messageId,
                senderId,
                senderLabel,
                wasMentioned: mentionDecision.effectiveWasMentioned,
                wasReplyToSelf,
              });
              return;
            }

            if (!isSenderAllowed({
              allowFrom: directAllowFrom,
              senderId,
              senderUsername: normalized.senderUsername,
            })) {
              log?.info?.("clawgram direct allowFrom mismatch", {
                accountId,
                senderId,
                senderUsername: normalized.senderUsername,
                allowFrom: directAllowFrom,
              });
              return;
            }

            const access = await resolveInboundDirectDmAccessWithRuntime({
              cfg,
              channel: "clawgram",
              accountId,
              dmPolicy,
              allowFrom: directAllowFrom,
              senderId,
              rawBody: text,
              runtime: channelRuntime.commands,
              isSenderAllowed: (_candidateSenderId, allowEntries) => isSenderAllowed({
                allowFrom: allowEntries,
                senderId,
                senderUsername,
              }),
              readStoreAllowFrom: pairing.readStoreForDmPolicy,
            });

            if (access.access.decision === "block") {
              log?.info?.("clawgram blocking inbound direct message", {
                accountId,
                chatId: normalized.chatId,
                messageId: normalized.messageId,
                senderId,
                reason: access.access.reason,
                reasonCode: access.access.reasonCode,
              });
              return;
            }

            if (access.access.decision === "pairing") {
              await pairing.issueChallenge({
                senderId,
                senderIdLine: `Your Telegram user id: ${senderId}`,
                meta: {
                  username: normalized.senderUsername,
                  name: normalized.senderDisplay,
                },
                sendPairingReply: async (pairingText) => {
                  await sendTextToConversation({
                    text: pairingText,
                  });
                },
                onReplyError: (err) => {
                  log?.info?.("clawgram pairing reply failed", {
                    accountId,
                    chatId: normalized.chatId,
                    senderId,
                    error: String(err),
                  });
                },
              });

              log?.info?.("clawgram pairing required for inbound direct message", {
                accountId,
                chatId: normalized.chatId,
                messageId: normalized.messageId,
                senderId,
              });
              return;
            }

            await gram.withTyping(conversationTarget, async () => {
              await dispatchInboundDirectDmWithRuntime({
                cfg,
                runtime: { channel: channelRuntime },
                channel: "clawgram",
                channelLabel: "Telegram",
                accountId,
                peer: {
                  kind: "direct",
                  id: senderId,
                },
                senderId,
                senderAddress: `telegram:${senderId}`,
                recipientAddress: selfId ? `telegram:${selfId}` : `telegram:${accountId}`,
                conversationLabel: senderLabel,
                rawBody: text,
                messageId: normalized.messageId,
                timestamp: normalized.timestamp,
                commandAuthorized: access.commandAuthorized,
                provider: "telegram",
                surface: "clawgram",
                originatingChannel: "clawgram",
                originatingTo: senderId,
                extraContext: {
                  SenderUsername: normalized.senderUsername,
                  SenderName: normalized.senderDisplay,
                  ReplyToId: normalized.replyToMessageId,
                  // Same reason as the group path: highlighted replies happen in
                  // direct messages too, and the fragment is not part of the text.
                  ReplyToQuoteText: normalized.replyQuoteText,
                  ReplyToIsQuote: normalized.replyIsQuote,
                  NativeChannelId: normalized.chatId,
                },
                deliver: async (payload) => {
                  const outboundText = typeof payload.text === "string" ? payload.text.trim() : "";
                  if (!outboundText) {
                    return;
                  }

                  const visibleText = stripSilentReplyToken(outboundText);
                  if (!visibleText) {
                    log?.info?.("clawgram suppressing silent direct reply", {
                      accountId,
                      chatId: normalized.chatId,
                      messageId: normalized.messageId,
                    });
                    return;
                  }

                  await sendTextToConversation({
                    text: visibleText,
                    replyToMessageId: payload.replyToId ? Number(payload.replyToId) : undefined,
                  });
                },
                onRecordError: (err) => {
                  log?.info?.("clawgram failed to record inbound session", {
                    accountId,
                    chatId: normalized.chatId,
                    messageId: normalized.messageId,
                    error: String(err),
                  })
                },
                onDispatchError: (err, info) => {
                  log?.info?.("clawgram failed to dispatch reply", {
                    accountId,
                    chatId: normalized.chatId,
                    messageId: normalized.messageId,
                    kind: info.kind,
                    error: String(err),
                  });
                },
              });
            }, {
              readMessageId: Number(normalized.messageId),
            });

            log?.info?.("clawgram inbound handled", {
              accountId,
              chatId: normalized.chatId,
              messageId: normalized.messageId,
              senderId,
              senderLabel,
            });

          } catch (error) {
            const rawMessage = (event as any)?.message;
            log?.error?.("clawgram inbound handling failed", {
              accountId,
              chatId: String(rawMessage?.chatId ?? rawMessage?.peerId?.userId ?? rawMessage?.peerId?.chatId ?? rawMessage?.peerId?.channelId ?? ""),
              messageId: String(rawMessage?.id ?? ""),
              error: String(error),
            });
            log?.info?.("clawgram inbound preflight failed", {
              accountId,
              chatId: String(rawMessage?.chatId ?? rawMessage?.peerId?.userId ?? rawMessage?.peerId?.chatId ?? rawMessage?.peerId?.channelId ?? ""),
              messageId: String(rawMessage?.id ?? ""),
              error: String(error),
            });
          }
        };
        client.addEventHandler(eventHandler, eventBuilder);

        // Being added to a chat arrives as a service message, which `NewMessage`
        // drops — so joins are observed on the raw update stream instead. Only
        // additions of this account are journalled; who else joins is not ours
        // to record.
        const joinsJournalPath = resolveJoinsJournalPath(account, accountId);
        const joinEventHandler = async (update: unknown) => {
          try {
            const join = parseJoinEvent((update as any)?.message, selfId);
            if (!join) {
              return;
            }
            appendJoinRecord(joinsJournalPath, join);
            // Ids of people stay out of the log; the chat and the fact are enough
            // to debug, and the journal itself holds the detail.
            log?.info?.("clawgram join observed", {
              accountId,
              chatId: join.chatId,
              via: join.via,
              hasInviter: join.inviterId !== undefined,
            });
          } catch (error) {
            log?.warn?.("clawgram join observation failed", {
              accountId,
              error: String(error),
            });
          }
        };
        const joinEventBuilder = new Raw({});
        client.addEventHandler(joinEventHandler, joinEventBuilder);

        await waitUntilAbort(ctx.abortSignal, async () => {
          client.removeEventHandler(eventHandler, eventBuilder);
          client.removeEventHandler(joinEventHandler, joinEventBuilder);

          const runtime = runtimes.get(accountId);
          if (!runtime) {
            return;
          }

          await runtime.stop();
          runtimes.delete(accountId);

          console.info("clawgram disconnected", {
            accountId,
            selfLabel,
          });
        });
      },
    },

    messaging: {
      targetPrefixes: [ CHANNEL_ID, "tguserbot", "telegram", "tg" ] as const,

      normalizeTarget(raw: string) {
        const normalized = normalizeOutboundTarget(raw);
        return normalized || undefined;
      },

      inferTargetChatType(params: {
        to: string;
      }) {
        const kind = inferOutboundTargetKind(params.to);
        if (kind === "group" || kind === "channel") {
          return kind;
        }
        if (kind === "user") {
          return "direct";
        }
        return undefined;
      },

      targetResolver: {
        looksLikeId(raw: string, normalized?: string) {
          const candidate = (normalized?.trim() || normalizeOutboundTarget(raw)).trim();
          if (!candidate) {
            return false;
          }

          if (candidate === "me" || candidate === "self" || candidate === "saved") {
            return true;
          }

          if (candidate.startsWith("@")) {
            return true;
          }

          return /^-?\d+$/.test(candidate);
        },

        async resolveTarget(params: {
          cfg: any;
          accountId?: string | null;
          input: string;
          normalized: string;
          preferredKind?: "user" | "group" | "channel";
        }) {
          const target = params.normalized?.trim() || normalizeOutboundTarget(params.input);
          if (!target) {
            return null;
          }

          const inferredKind = inferOutboundTargetKind(params.input, params.preferredKind);
          const accountId = resolveRuntimeAccountId(params.cfg, params.accountId);
          const gram = accountId ? runtimes.get(accountId) : undefined;
          const resolved = gram ? await gram.resolvePeer(target, { kind: inferredKind }).catch(() => undefined) : undefined;
          const kind = resolved?.chatType === "group" || inferredKind === "group"
            ? "group"
            : resolved?.chatType === "channel" || inferredKind === "channel"
              ? "channel"
              : "user";

          return {
            to: resolved?.chatId ?? target,
            kind,
            source: "normalized" as const,
          };
        },
      },

      async resolveOutboundSessionRoute(params: {
        cfg: any;
        agentId: string;
        accountId?: string | null;
        target: string;
        resolvedTarget?: {
          to: string;
          kind: "user" | "group" | "channel";
          display?: string;
          source: "normalized" | "directory";
        };
        threadId?: string | number | null;
      }) {
        const rawTarget = params.resolvedTarget?.to ?? params.target;
        const targetKind = inferOutboundTargetKind(rawTarget, params.resolvedTarget?.kind);
        const target = normalizeOutboundTarget(rawTarget);
        if (!target) {
          return null;
        }

        const accountId = resolveRuntimeAccountId(params.cfg, params.accountId);
        const gram = accountId ? runtimes.get(accountId) : undefined;
        const resolved = gram ? await gram.resolvePeer(target, { kind: targetKind }).catch(() => undefined) : undefined;
        const peerId = resolved?.chatId ?? target;
        const chatType = resolved?.chatType === "group" || targetKind === "group"
          ? "group"
          : resolved?.chatType === "channel" || targetKind === "channel"
            ? "channel"
            : "direct";
        const scopedPeerId = chatType === "group" || chatType === "channel"
          ? buildScopedGroupPeerId(accountId, peerId)
          : peerId;

        return buildChannelOutboundSessionRoute({
          cfg: params.cfg,
          agentId: params.agentId,
          channel: CHANNEL_ID,
          accountId,
          peer: {
            kind: routeKindFromChatType(chatType),
            id: scopedPeerId,
          },
          chatType,
          from: accountId ?? "default",
          to: target,
          threadId: params.threadId ?? undefined,
        });
      },

      formatTargetDisplay(params: {
        target: string;
        display?: string;
        kind?: "user" | "group" | "channel";
      }) {
        const display = params.display?.trim();
        if (display) {
          return display;
        }

        const target = normalizeOutboundTarget(params.target);
        return target.startsWith("@") ? target : `telegram:${target}`;
      },
    },

    actions: {
      describeMessageTool: ({ cfg, accountId }: { cfg: any; accountId?: string | null }) => {
        const resolvedAccountId = resolveRuntimeAccountId(cfg, accountId);
        if (!resolvedAccountId) {
          return null;
        }

        return {
          // `upload-file` is what core dispatches when an agent has an
          // attachment to deliver — a generated image is the common case.
          // Leaving it out does not degrade to a text send: the agent simply
          // never sees a way to send the file, announces it in words, and the
          // file stays on disk. That is exactly what happened on 2026-08-07.
          actions: [ "send", "read", "participants", "joins", "react", "chatInfo", "upload-file" ],
          capabilities: [],
          mediaSourceParams: {
            "upload-file": [ "filePath", "path", "media" ],
          },
        };
      },

      extractToolSend: ({ args }: { args: Record<string, unknown> }) => extractToolSend(args, "sendMessage"),

      handleAction: async ({ action, params, cfg, accountId, dryRun, toolContext }: {
        action: string;
        params: Record<string, unknown>;
        cfg: any;
        accountId?: string | null;
        dryRun?: boolean;
        toolContext?: {
          currentChannelId?: string;
          currentMessageId?: string | number;
        };
      }) => {
        // `read` is what OpenClaw core dispatches (`openclaw message read`,
        // MCP `messages_read`). `list` is accepted as a synonym so a caller that
        // guessed the other obvious name is not silently refused.
        if (action === "read" || action === "list") {
          const listParams = parseListMessagesParams(params);
          const listAccountId = resolveRuntimeAccountId(cfg, accountId);
          if (!listAccountId) {
            throw new Error("clawgram: no configured account found");
          }

          // Reading is not a side effect, so a dry run still answers — reporting
          // an empty window would look like a quiet chat rather than a no-op.
          if (!isChatReadable(listParams.target, resolveAccountReadChats(cfg, listAccountId))) {
            actionLog.warn("clawgram list refused: chat outside read scope", {
              accountId: listAccountId,
              target: listParams.target,
            });
            throw new Error(`clawgram: not-allowed-chat ${listParams.target}`);
          }

          const listGram = runtimes.get(listAccountId);
          if (!listGram) {
            throw new Error(`clawgram: runtime not found for account ${listAccountId}`);
          }

          const history = await listGram.listMessages(listParams);

          // Metadata only. Message text is the user's correspondence and has no
          // business in a log that is read while debugging something else.
          actionLog.info("clawgram handleAction list completed", {
            accountId: listAccountId,
            target: listParams.target,
            limit: listParams.limit,
            since: listParams.since ?? null,
            until: listParams.until ?? null,
            returned: history.messages.length,
            truncated: history.truncated,
          });

          return jsonResult({
            ok: true,
            accountId: listAccountId,
            chatId: history.chatId ?? listParams.target,
            count: history.messages.length,
            truncated: history.truncated,
            messages: history.messages,
          });
        }

        // Membership is a read, so the same `readChats` scope that gates history
        // gates it too: this cannot become a way to enumerate chats the account
        // was never allowed to read.
        if (action === "participants" || action === "members") {
          const participantsParams = parseListParticipantsParams(params);
          const participantsAccountId = resolveRuntimeAccountId(cfg, accountId);
          if (!participantsAccountId) {
            throw new Error("clawgram: no configured account found");
          }

          if (!isChatReadable(participantsParams.target, resolveAccountReadChats(cfg, participantsAccountId))) {
            actionLog.warn("clawgram participants refused: chat outside read scope", {
              accountId: participantsAccountId,
              target: participantsParams.target,
            });
            throw new Error(`clawgram: not-allowed-chat ${participantsParams.target}`);
          }

          const participantsGram = runtimes.get(participantsAccountId);
          if (!participantsGram) {
            throw new Error(`clawgram: runtime not found for account ${participantsAccountId}`);
          }

          const membership = await participantsGram.listParticipants(participantsParams);

          // Counts only. Member ids are personal data and have no business in a
          // log that is read while debugging something else.
          actionLog.info("clawgram handleAction participants completed", {
            accountId: participantsAccountId,
            target: participantsParams.target,
            limit: participantsParams.limit,
            returned: membership.participants.length,
            truncated: membership.truncated,
          });

          return jsonResult({
            ok: true,
            accountId: participantsAccountId,
            chatId: membership.chatId ?? participantsParams.target,
            count: membership.participants.length,
            truncated: membership.truncated,
            participants: membership.participants,
          });
        }

        // Where this account was recently added, and by whom. Reading the journal
        // has no scope check of its own: it only ever contains chats this account
        // was put into, which is exactly what the caller is allowed to learn.
        if (action === "joins") {
          const joinsParams = parseJoinsParams(params);
          const joinsAccountId = resolveRuntimeAccountId(cfg, accountId);
          if (!joinsAccountId) {
            throw new Error("clawgram: no configured account found");
          }

          const journalPath = resolveJoinsJournalPath(
            cfg?.channels?.[ "clawgram" ]?.accounts?.[ joinsAccountId ],
            joinsAccountId,
          );
          const selected = selectJoinRecords(readJoinRecords(journalPath), joinsParams);

          actionLog.info("clawgram handleAction joins completed", {
            accountId: joinsAccountId,
            since: joinsParams.since ?? null,
            limit: joinsParams.limit,
            returned: selected.length,
          });

          return jsonResult({
            ok: true,
            accountId: joinsAccountId,
            count: selected.length,
            joins: selected,
          });
        }

        // Describing a chat is a read, so the same `readChats` scope that gates
        // history gates it too — this must not become a way to learn the title
        // and size of a chat the account was never allowed to read.
        if (
          action === "chatInfo" || action === "getChatInfo"
          || action === "chatMetadata" || action === "getChatMetadata"
        ) {
          const chatInfoParams = parseChatInfoParams(params, toolContext);
          const chatInfoAccountId = resolveRuntimeAccountId(cfg, accountId);
          if (!chatInfoAccountId) {
            throw new Error("clawgram: no configured account found");
          }

          if (!isChatReadable(chatInfoParams.target, resolveAccountReadChats(cfg, chatInfoAccountId))) {
            actionLog.warn("clawgram chatInfo refused: chat outside read scope", {
              accountId: chatInfoAccountId,
              target: chatInfoParams.target,
            });
            throw new Error(`clawgram: not-allowed-chat ${chatInfoParams.target}`);
          }

          const chatInfoGram = runtimes.get(chatInfoAccountId);
          if (!chatInfoGram) {
            throw new Error(`clawgram: runtime not found for account ${chatInfoAccountId}`);
          }

          const { entity, full } = await chatInfoGram.getChatInfo(chatInfoParams.target);
          const info = describeChat(entity, full);

          // Type and size only. The title of a private chat is as personal as
          // its contents and has no business in a debugging log.
          actionLog.info("clawgram handleAction chatInfo completed", {
            accountId: chatInfoAccountId,
            type: info.type,
            memberCount: info.memberCount ?? null,
            isForum: info.isForum ?? null,
          });

          return jsonResult({
            ok: true,
            accountId: chatInfoAccountId,
            chat: { ...info, chatId: info.chatId ?? chatInfoParams.target },
          });
        }

        // A reaction is an outbound act on someone else's message, so it is
        // gated like sending rather than like reading — and it respects
        // `dryRun`, which reading does not need to.
        if (action === "react") {
          const reactionParams = parseReactionParams(params, toolContext);
          const reactionAccountId = resolveRuntimeAccountId(cfg, accountId);
          if (!reactionAccountId) {
            throw new Error("clawgram: no configured account found");
          }

          actionLog.info("clawgram handleAction react", {
            accountId: reactionAccountId,
            dryRun: dryRun === true,
            target: reactionParams.target,
            messageId: reactionParams.messageId,
            remove: reactionParams.remove,
          });

          if (dryRun === true) {
            return jsonResult({
              ok: true,
              dryRun: true,
              accountId: reactionAccountId,
              chatId: reactionParams.target,
              messageId: reactionParams.messageId,
              removed: reactionParams.remove,
            });
          }

          const reactionGram = runtimes.get(reactionAccountId);
          if (!reactionGram) {
            throw new Error(`clawgram: runtime not found for account ${reactionAccountId}`);
          }

          await reactionGram.sendReaction(reactionParams);

          return jsonResult({
            ok: true,
            accountId: reactionAccountId,
            chatId: reactionParams.target,
            messageId: reactionParams.messageId,
            removed: reactionParams.remove,
          });
        }

        // Core normalizes whichever of these it filled in to a local path (see
        // `mediaSourceParams` above); `mediaUrl` stays a URL, which GramJS
        // accepts as well.
        const attachedFile =
          readStringParam(params, "filePath")
          ?? readStringParam(params, "path")
          ?? readStringParam(params, "media")
          ?? readStringParam(params, "mediaUrl");

        // Core dispatches `upload-file`; `sendAttachment` is its legacy alias
        // and arrives from older callers. A plain `send` carrying a file lands
        // here too — `openclaw message send --media` does exactly that, and
        // routing it to the text path dropped the file without a word.
        if (action === "upload-file" || action === "sendAttachment" || (action === "send" && attachedFile)) {
          const rawUploadTo = resolveActionTarget(params, toolContext);
          const uploadTo = normalizeOutboundTarget(rawUploadTo);
          const uploadAccountId = resolveRuntimeAccountId(cfg, accountId);
          if (!uploadAccountId) {
            throw new Error("clawgram: no configured account found");
          }

          const file = attachedFile;
          if (!file) {
            throw new Error("clawgram: upload-file requires filePath, path, media, or mediaUrl");
          }

          const captionText = readMessageText(params) || (readStringParam(params, "caption") ?? "");
          // A caption is optional, but the silent-reply sentinel must never
          // reach Telegram as one — same reasoning as the `send` path below.
          const caption = captionText.trim() && isSilentReplyText(captionText)
            ? ""
            : captionText.replaceAll("\\n", "\n");
          const uploadReplyToId = readStringOrNumberParam(params, "replyToId") ?? readStringOrNumberParam(params, "replyTo");
          const uploadThreadId = readStringOrNumberParam(params, "threadId");
          const asVoice = readVoiceNoteFlag(params);

          actionLog.info("clawgram handleAction upload-file", {
            accountId: uploadAccountId,
            dryRun: dryRun === true,
            to: uploadTo,
            hasCaption: Boolean(caption),
            replyToId: uploadReplyToId ?? null,
            threadId: uploadThreadId ?? null,
            asVoice,
          });

          if (dryRun === true) {
            return jsonResult({
              ok: true,
              dryRun: true,
              to: uploadTo,
              accountId: uploadAccountId,
            });
          }

          const uploadGram = runtimes.get(uploadAccountId);
          if (!uploadGram) {
            throw new Error(`clawgram: runtime not found for account ${uploadAccountId}`);
          }

          const uploaded = await uploadGram.sendMedia({
            target: uploadTo,
            file,
            caption: caption || undefined,
            replyToMessageId: resolveReplyToMessageIdForTarget(rawUploadTo, uploadReplyToId),
            messageThreadId: parseOptionalThreadId(uploadThreadId),
            asVoice,
          });

          actionLog.info("clawgram handleAction upload-file completed", {
            accountId: uploadAccountId,
            to: uploadTo,
            sentMessageId: String((uploaded as any)?.id ?? ""),
          });

          return jsonResult({
            ok: true,
            to: uploadTo,
            accountId: uploadAccountId,
            messageId: String((uploaded as any)?.id ?? ""),
          });
        }

        if (action !== "send") {
          throw new Error(`clawgram: unsupported message action ${action}`);
        }

        const rawTo = resolveActionTarget(params, toolContext);
        const targetKind = inferOutboundTargetKind(rawTo);
        const to = normalizeOutboundTarget(rawTo);
        const replyToId = readStringOrNumberParam(params, "replyToId") ?? readStringOrNumberParam(params, "replyTo");
        const threadId = readStringOrNumberParam(params, "threadId");
        const messageThreadId = parseOptionalThreadId(threadId);
        const parseMode = normalizeParseMode((params as Record<string, unknown> | undefined)?.parseMode);

        actionLog.info("clawgram handleAction send", {
          requestedAccountId: accountId,
          dryRun: dryRun === true,
          rawTo,
          to,
          targetKind,
          replyToId: replyToId ?? null,
          threadId: threadId ?? null,
          parseMode: parseMode ?? null,
          toolContextCurrentChannelId: toolContext?.currentChannelId ?? null,
        });

        const resolvedAccountId = resolveRuntimeAccountId(cfg, accountId);
        if (!resolvedAccountId) {
          throw new Error("clawgram: no configured account found");
        }
        const currentChannelId = toolContext?.currentChannelId?.trim() ?? "";
        const currentMessageId = toolContext?.currentMessageId;
        const currentChannelTarget = currentChannelId ? normalizeOutboundTarget(currentChannelId) : "";
        const sendingToCurrentGroup = Boolean(
          currentChannelTarget &&
          currentChannelTarget === to &&
          targetKind === "group",
        );

        if (
          sendingToCurrentGroup &&
          !replyToId &&
          currentMessageId !== null &&
          currentMessageId !== undefined &&
          hasRecentVisibleGroupReply({
            accountId: resolvedAccountId,
            chatId: to,
            currentMessageId,
          })
        ) {
          actionLog.warn("clawgram suppressing duplicate visible group reply", {
            accountId: resolvedAccountId,
            to,
            currentMessageId: String(currentMessageId),
            toolContextCurrentChannelId: currentChannelId || null,
          });

          return jsonResult({
            ok: true,
            suppressedDuplicate: true,
            to,
            accountId: resolvedAccountId,
          });
        }

        const groupReplyAddress = consumeGroupReplyAddress({
          accountId: resolvedAccountId,
          chatId: to,
          replyToId,
        });
        const requestedText = readMessageText(params).replaceAll("\\n", "\n");

        // `NO_REPLY` is OpenClaw's "say nothing" sentinel. The inbound pipeline
        // and core both strip it, but an explicit `message.action` call is
        // neither path — and the SDK itself prompts agents to send a message
        // and *then* answer NO_REPLY, so the two are one slip apart. Posting
        // the token into a work chat looks like the assistant malfunctioning.
        //
        // Checked before the reply-address prefix on purpose: prefixing first
        // leaves "Name: " behind, which is not empty, and the token goes out.
        // That is precisely how it once reached the inbound path.
        if (requestedText.trim() && isSilentReplyText(requestedText)) {
          actionLog.info("clawgram suppressing silent send", {
            accountId: resolvedAccountId,
            to,
          });

          return jsonResult({
            ok: true,
            skipped: "silent",
            sent: false,
            to,
            accountId: resolvedAccountId,
          });
        }

        const text = prefixReplyTextToAddress(requestedText, groupReplyAddress);
        if (!text) {
          throw new Error("clawgram: message text is required");
        }

        if (dryRun) {
          return jsonResult({
            ok: true,
            dryRun: true,
            to,
            accountId: resolvedAccountId,
          });
        }

        const gram = runtimes.get(resolvedAccountId);
        if (!gram) {
          throw new Error(`clawgram: runtime not found for account ${resolvedAccountId}`);
        }

        const sent = await gram.sendText({
          target: to,
          text,
          targetKind,
          replyToMessageId: resolveReplyToMessageIdForTarget(rawTo, replyToId),
          messageThreadId,
          parseMode,
        });

        if (
          sendingToCurrentGroup &&
          !replyToId &&
          currentMessageId !== null &&
          currentMessageId !== undefined
        ) {
          rememberVisibleGroupReply({
            accountId: resolvedAccountId,
            chatId: to,
            currentMessageId,
          });
        }

        actionLog.info("clawgram handleAction send completed", {
          accountId: resolvedAccountId,
          to,
          replyToId: replyToId ?? null,
          sentMessageId: String((sent as any)?.id ?? ""),
        });

        return jsonResult({
          ok: true,
          to,
          accountId: resolvedAccountId,
          messageId: String((sent as any)?.id ?? ""),
        });
      },
    },

    outbound: {
      // Core's agent-delivery path (`--deliver`, subagent announces) calls this
      // hook under three constraints, all learned live on 2026-08-06:
      //
      // - `to` may be undefined (no explicit target, session route yielded
      //   none), and a rejection is NOT caught: a throw here is an unhandled
      //   rejection that takes down the entire gateway process.
      // - `resolveAgentDeliveryPlanWithSessionRoute` calls it WITHOUT await.
      //   An async hook hands core a Promise, `promise.ok` reads undefined and
      //   the error branch dereferences `promise.error.message` — the crash
      //   every subagent announce died on. The hook must return a plain value;
      //   the call sites that do await are unaffected, await of a value works.
      // - In a not-ok result core reads `error.message`, so the error must be
      //   Error-like, not a bare string.
      //
      // Peer resolution deliberately does not happen here: `sendText` resolves
      // the peer itself, and doing it here would force the hook async again.
      resolveTarget(ctx: { accountId: string; to?: string }) {
        try {
          const raw = typeof ctx.to === "string" ? ctx.to.trim() : "";
          actionLog.info("clawgram outbound resolveTarget", {
            accountId: ctx.accountId,
            rawTo: raw || null,
          });
          if (!raw) {
            return { ok: false as const, error: new Error("clawgram: no delivery target — pass `to` or use a session with a bound chat") };
          }

          return { ok: true as const, to: normalizeOutboundTarget(raw) };
        } catch (err) {
          return { ok: false as const, error: err instanceof Error ? err : new Error(String(err)) };
        }
      },

      async sendText(ctx: {
        accountId: string;
        to: string;
        text: string;
        replyToId?: string | null;
        threadId?: string | number | null;
      }) {
        // Never log `text`: outbound bodies are private correspondence and the
        // channel log is a plain journald sink. Length is enough to tell an
        // empty or truncated send apart from a real one.
        actionLog.info("clawgram outbound sendText", {
          accountId: ctx.accountId,
          rawTo: ctx.to,
          replyToId: ctx.replyToId ?? null,
          threadId: ctx.threadId ?? null,
          textLength: ctx.text.length,
        });

        // Core normalizes reply payloads and drops the silent token before a
        // channel is called, so this should never see one. "Should never" is
        // what the inbound path was assumed to be too, right until it posted a
        // token — and the check costs a string comparison.
        if (ctx.text.trim() && isSilentReplyText(ctx.text)) {
          actionLog.info("clawgram suppressing silent outbound send", {
            accountId: ctx.accountId,
            rawTo: ctx.to,
          });

          return { skipped: "silent" as const };
        }

        const gram = runtimes.get(ctx.accountId);
        if (!gram) {
          throw new Error(`clawgram: runtime not found for account ${ctx.accountId}`);
        }

        const groupReplyAddress = consumeGroupReplyAddress({
          accountId: ctx.accountId,
          chatId: ctx.to,
          replyToId: ctx.replyToId,
        });
        const targetKind = inferOutboundTargetKind(ctx.to);
        const target = normalizeOutboundTarget(ctx.to);
        const messageThreadId = parseOptionalThreadId(ctx.threadId);

        const sent = await gram.sendText({
          target,
          text: prefixReplyTextToAddress(ctx.text, groupReplyAddress),
          targetKind,
          replyToMessageId: resolveReplyToMessageIdForTarget(ctx.to, ctx.replyToId),
          messageThreadId,
          parseMode: gram.replyParseMode,
        });

        actionLog.info("clawgram outbound sendText completed", {
          accountId: ctx.accountId,
          to: target,
          targetKind,
          replyToId: ctx.replyToId ?? null,
          sentMessageId: String((sent as any)?.id ?? ""),
        });

        return {
          ok: true,
          messageId: String((sent as any)?.id ?? ""),
        };
      },

      async sendMedia(ctx: {
        accountId: string;
        to: string;
        mediaUrl?: string;
        filePath?: string;
        text?: string;
        caption?: string;
        replyToId?: string | null;
        threadId?: string | number | null;
        /** Core's signal that this file is a voice note, not an audio document. */
        audioAsVoice?: boolean;
      }) {
        const gram = runtimes.get(ctx.accountId);
        if (!gram) {
          throw new Error(`clawgram: runtime not found for account ${ctx.accountId}`);
        }

        actionLog.info("clawgram outbound sendMedia", {
          accountId: ctx.accountId,
          rawTo: ctx.to,
          replyToId: ctx.replyToId ?? null,
          threadId: ctx.threadId ?? null,
          filePath: ctx.filePath ?? null,
          mediaUrl: ctx.mediaUrl ?? null,
          hasText: Boolean(ctx.text),
          hasCaption: Boolean(ctx.caption),
          asVoice: ctx.audioAsVoice === true,
        });

        const file = ctx.filePath ?? ctx.mediaUrl;
        if (!file) {
          throw new Error("clawgram: sendMedia requires filePath or mediaUrl");
        }
        const messageThreadId = parseOptionalThreadId(ctx.threadId);
        // Same normalization `sendText` does two functions up. Without it the
        // channel prefix reaches peer resolution and the send throws — which is
        // exactly how a synthesized group reply died on 2026-08-08, silently
        // enough that the transcript fallback posted it as raw text instead.
        const target = normalizeOutboundTarget(ctx.to);

        const sent = await gram.sendMedia({
          target,
          file,
          caption: ctx.caption ?? ctx.text,
          replyToMessageId: resolveReplyToMessageIdForTarget(ctx.to, ctx.replyToId),
          messageThreadId,
          asVoice: ctx.audioAsVoice === true,
        });

        actionLog.info("clawgram outbound sendMedia completed", {
          accountId: ctx.accountId,
          to: ctx.to,
          replyToId: ctx.replyToId ?? null,
          sentMessageId: String((sent as any)?.id ?? ""),
        });

        return {
          ok: true,
          messageId: String((sent as any)?.id ?? ""),
        };
      },
    },
  };
};
