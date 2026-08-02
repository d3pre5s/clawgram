import {
  buildChannelOutboundSessionRoute,
  createSubsystemLogger,
  jsonResult,
} from "openclaw/plugin-sdk/core";
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-runtime";
import { readStringOrNumberParam } from "openclaw/plugin-sdk/param-readers";
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
  resolveAllowFrom,
  resolveGroups,
  resolveGroupConfig,
  resolveActiveUsername,
  isSenderAllowed,
  hasTelegramMention,
  toDisplayName,
  prefixReplyTextToAddress,
  stripSilentReplyToken,
  resolveReplyTarget,
  resolveChatTarget,
  isReplyToSelfMessage,
  resolveSenderProfile,
  resolveSenderProfileWithTimeout,
} from './helpers';
import { resolveProxyConfig } from './proxy-config';
import { CHANNEL_ID } from './constants';

const actionLog = createSubsystemLogger("channels/telegram-userbot");

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
  return readAccountReadChats(cfg?.channels?.[ "telegram-userbot" ]?.accounts?.[ accountId ]);
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

export const createChannelPlugin = (runtimes: RuntimeMap) => {
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
    id: "telegram-userbot",

    meta: {
      id: "telegram-userbot",
      label: "Telegram Userbot",
      selectionLabel: "Telegram Userbot (GramJS)",
      docsPath: "/channels/telegram-userbot",
      blurb:
        "Connect your personal Telegram account to OpenClaw via MTProto. Your AI assistant responds as you.",
      aliases: [ "tguserbot" ],
    },

    capabilities: {
      chatTypes: [ "direct", "group" ] as const,
      reactions: true,
      threads: true,
      media: true,
      nativeCommands: false,
      blockStreaming: false,
    },

    agentPrompt: {
      messageToolHints: () => [
        "Use telegram-userbot to send Telegram replies from the connected personal account.",
        "When replying in the current Telegram chat, omit `to`/`target` and telegram-userbot will send to the current conversation automatically.",
        "Explicit targets may be @username, numeric Telegram user id, phone/contact resolvable by Telegram, group chat ids, or telegram-userbot:<target>.",
        "For Telegram forum topics, send to the group chat id and pass the topic id separately as `threadId`.",
      ],
      messageToolCapabilities: () => [
        "telegram-userbot can reply in the current Telegram conversation when no explicit target is provided.",
        "telegram-userbot can send text messages to direct chats and groups from the connected personal account.",
        "telegram-userbot supports Telegram forum topics via the `threadId` parameter on group sends.",
      ],
    },

    config: {
      listAccountIds(cfg: any): string[] {
        const accounts = cfg?.channels?.[ "telegram-userbot" ]?.accounts;
        if (!accounts || typeof accounts !== "object") {
          return [];
        }

        return Object.keys(accounts);
      },

      resolveAccount(cfg: any, accountId: string): PluginConfig {
        const account = cfg?.channels?.[ "telegram-userbot" ]?.accounts?.[ accountId ];

        return {
          apiId: Number(account?.apiId),
          apiHash: String(account?.apiHash ?? ""),
          sessionString: String(account?.sessionString ?? ""),
          allowFrom: resolveAllowFrom(account?.allowFrom),
          groups: resolveGroups(account?.groups),
          readChats: readAccountReadChats(account),
          enabled: account?.enabled,
          accountId,
          proxy: resolveProxyConfig(account?.proxy),
        };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { account, accountId, channelRuntime, cfg, log } = ctx;

        if (!channelRuntime) {
          throw new Error("telegram-userbot: channelRuntime is required");
        }

        if (runtimes.has(accountId)) {
          log?.warn?.("telegram-userbot stale runtime detected, reconnecting", { accountId });
          await runtimes.get(accountId)?.stop().catch(() => undefined);
          runtimes.delete(accountId);
        }

        const gram = new GramJsClientManager(account);
        await gram.start();
        runtimes.set(accountId, gram);
        const pairing = createChannelPairingController({
          // The controller only reads core.channel.pairing, but its parameter is typed
          // as the full PluginRuntime, and ctx (hence channelRuntime) is untyped.
          core: { channel: channelRuntime } as PluginRuntime,
          channel: "telegram-userbot",
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

        log?.info?.("telegram-userbot connected ------------------------------------------", {
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
              log?.info?.("telegram-userbot raw direct-like event", {
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
                log?.info?.("telegram-userbot normalize returned null", {
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
                log?.info?.("telegram-userbot skipping outgoing direct event", {
                  accountId,
                  chatId: normalized.chatId,
                  messageId: normalized.messageId,
                  senderId: normalized.senderId,
                });
              }
              return;
            }

            if (normalized.chatType === "channel") {
              log?.info?.("telegram-userbot skipping channel inbound", {
                accountId,
                chatId: normalized.chatId,
                chatType: normalized.chatType,
                messageId: normalized.messageId,
              });
              return;
            }

            const text = normalized.text?.trim();
            if (!text) {
              log?.info?.("telegram-userbot skipping empty inbound text", {
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
              log?.info?.("telegram-userbot skipping Telegram service direct chat", {
                accountId,
                chatId: normalized.chatId,
                messageId: normalized.messageId,
                senderId,
              });
              return;
            }

            if (isSavedMessagesDirect) {
              log?.info?.("telegram-userbot skipping Saved Messages direct chat", {
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
            let lastError: unknown;

            for (const target of targets) {
              try {
                return await gram.sendText({
                  target,
                  text: args.text,
                  replyToMessageId: args.replyToMessageId,
                  messageThreadId: args.messageThreadId,
                });
              } catch (error) {
                lastError = error;
              }
            }

            throw lastError;
          };
          const accountConfig =
            cfg?.channels?.[ "telegram-userbot" ]?.accounts?.[ accountId ] ??
            cfg?.channels?.[ "telegram-userbot" ] ??
            {};
          const directAllowFrom = resolveAllowFrom(accountConfig?.allowFrom ?? account?.allowFrom);
          const groups = resolveGroups(accountConfig?.groups ?? account?.groups);
          const dmPolicy = "open";

            if (normalized.chatType === "group") {
              const groupConfig = resolveGroupConfig(groups, normalized.chatId);
              if (!groupConfig) {
                log?.info?.("telegram-userbot skipping group not present in groups config", {
                  accountId,
                  chatId: normalized.chatId,
                  messageId: normalized.messageId,
                });
                return;
              }

              if (groupConfig.enabled === false) {
                log?.info?.("telegram-userbot skipping disabled group", {
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
                log?.info?.("telegram-userbot blocking inbound group sender by allowFrom", {
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
                channel: "telegram-userbot",
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

              log?.info?.("telegram-userbot group mention gate", {
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
                log?.info?.("telegram-userbot skipping group message without mention", {
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
                Surface: "telegram-userbot",
                MessageSid: normalized.messageId,
                MessageSidFull: normalized.messageId,
                Timestamp: normalized.timestamp,
                ReplyToId: normalized.replyToMessageId,
                MessageThreadId: normalized.messageThreadId,
                NativeChannelId: normalized.chatId,
                OriginatingChannel: "telegram-userbot",
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
                log?.info?.("telegram-userbot dispatching group reply", {
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
                    log?.info?.("telegram-userbot failed to update group last route", {
                      accountId,
                      chatId: normalized.chatId,
                      messageId: normalized.messageId,
                      error: String(err),
                    });
                  },
                });

                const dispatchBase = buildInboundReplyDispatchBase({
                  cfg,
                  channel: "telegram-userbot",
                  accountId: route.accountId ?? accountId,
                  route,
                  storePath,
                  ctxPayload,
                  core: { channel: channelRuntime },
                });
                const { onModelSelected, ...replyPipeline } = createChannelReplyPipeline({
                  cfg,
                  agentId: route.agentId,
                  channel: "telegram-userbot",
                  accountId: route.accountId ?? accountId,
                });
                const dispatchResult = await dispatchBase.dispatchReplyWithBufferedBlockDispatcher({
                  ctx: ctxPayload,
                  cfg,
                  dispatcherOptions: {
                    ...replyPipeline,
                    deliver: async (payload) => {
                      const outboundText = typeof payload.text === "string" ? payload.text.trim() : "";
                      log?.info?.("telegram-userbot deliver group payload", {
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
                        log?.info?.("telegram-userbot suppressing silent group reply", {
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
                      log?.error?.("telegram-userbot failed to dispatch group reply", {
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

                log?.info?.("telegram-userbot group dispatch completed", {
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
                  const fallbackText = readLatestAssistantFallbackFromTranscript(route.sessionKey, storePath);
                  // A suppressed silent reply legitimately delivers nothing, so
                  // this fallback fires right after it. Without the same check
                  // the token would be read back from the transcript and sent.
                  const visibleFallbackText = fallbackText ? stripSilentReplyToken(fallbackText) : "";
                  if (fallbackText && !visibleFallbackText) {
                    log?.info?.("telegram-userbot skipping silent transcript fallback", {
                      accountId,
                      chatId: normalized.chatId,
                      messageId: normalized.messageId,
                      routeSessionKey: route.sessionKey,
                    });
                  } else if (visibleFallbackText) {
                    log?.warn?.("telegram-userbot using transcript fallback reply", {
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
                  } else {
                    log?.warn?.("telegram-userbot transcript fallback unavailable", {
                      accountId,
                      chatId: normalized.chatId,
                      messageId: normalized.messageId,
                      routeSessionKey: route.sessionKey,
                    });
                  }
                }
              }, {
                readMessageId: Number(normalized.messageId),
                messageThreadId,
              });

              log?.info?.("telegram-userbot group inbound handled", {
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
              log?.info?.("telegram-userbot direct allowFrom mismatch", {
                accountId,
                senderId,
                senderUsername: normalized.senderUsername,
                allowFrom: directAllowFrom,
              });
              return;
            }

            const access = await resolveInboundDirectDmAccessWithRuntime({
              cfg,
              channel: "telegram-userbot",
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
              log?.info?.("telegram-userbot blocking inbound direct message", {
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
                  log?.info?.("telegram-userbot pairing reply failed", {
                    accountId,
                    chatId: normalized.chatId,
                    senderId,
                    error: String(err),
                  });
                },
              });

              log?.info?.("telegram-userbot pairing required for inbound direct message", {
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
                channel: "telegram-userbot",
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
                surface: "telegram-userbot",
                originatingChannel: "telegram-userbot",
                originatingTo: senderId,
                extraContext: {
                  SenderUsername: normalized.senderUsername,
                  SenderName: normalized.senderDisplay,
                  ReplyToId: normalized.replyToMessageId,
                  NativeChannelId: normalized.chatId,
                },
                deliver: async (payload) => {
                  const outboundText = typeof payload.text === "string" ? payload.text.trim() : "";
                  if (!outboundText) {
                    return;
                  }

                  const visibleText = stripSilentReplyToken(outboundText);
                  if (!visibleText) {
                    log?.info?.("telegram-userbot suppressing silent direct reply", {
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
                  log?.info?.("telegram-userbot failed to record inbound session", {
                    accountId,
                    chatId: normalized.chatId,
                    messageId: normalized.messageId,
                    error: String(err),
                  })
                },
                onDispatchError: (err, info) => {
                  log?.info?.("telegram-userbot failed to dispatch reply", {
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

            log?.info?.("telegram-userbot inbound handled", {
              accountId,
              chatId: normalized.chatId,
              messageId: normalized.messageId,
              senderId,
              senderLabel,
            });

          } catch (error) {
            const rawMessage = (event as any)?.message;
            log?.error?.("telegram-userbot inbound handling failed", {
              accountId,
              chatId: String(rawMessage?.chatId ?? rawMessage?.peerId?.userId ?? rawMessage?.peerId?.chatId ?? rawMessage?.peerId?.channelId ?? ""),
              messageId: String(rawMessage?.id ?? ""),
              error: String(error),
            });
            log?.info?.("telegram-userbot inbound preflight failed", {
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
            log?.info?.("telegram-userbot join observed", {
              accountId,
              chatId: join.chatId,
              via: join.via,
              hasInviter: join.inviterId !== undefined,
            });
          } catch (error) {
            log?.warn?.("telegram-userbot join observation failed", {
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

          console.info("telegram-userbot disconnected", {
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
          actions: [ "send", "read", "participants", "joins" ],
          capabilities: [],
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
            throw new Error("telegram-userbot: no configured account found");
          }

          // Reading is not a side effect, so a dry run still answers — reporting
          // an empty window would look like a quiet chat rather than a no-op.
          if (!isChatReadable(listParams.target, resolveAccountReadChats(cfg, listAccountId))) {
            actionLog.warn("telegram-userbot list refused: chat outside read scope", {
              accountId: listAccountId,
              target: listParams.target,
            });
            throw new Error(`telegram-userbot: not-allowed-chat ${listParams.target}`);
          }

          const listGram = runtimes.get(listAccountId);
          if (!listGram) {
            throw new Error(`telegram-userbot: runtime not found for account ${listAccountId}`);
          }

          const history = await listGram.listMessages(listParams);

          // Metadata only. Message text is the user's correspondence and has no
          // business in a log that is read while debugging something else.
          actionLog.info("telegram-userbot handleAction list completed", {
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
            throw new Error("telegram-userbot: no configured account found");
          }

          if (!isChatReadable(participantsParams.target, resolveAccountReadChats(cfg, participantsAccountId))) {
            actionLog.warn("telegram-userbot participants refused: chat outside read scope", {
              accountId: participantsAccountId,
              target: participantsParams.target,
            });
            throw new Error(`telegram-userbot: not-allowed-chat ${participantsParams.target}`);
          }

          const participantsGram = runtimes.get(participantsAccountId);
          if (!participantsGram) {
            throw new Error(`telegram-userbot: runtime not found for account ${participantsAccountId}`);
          }

          const membership = await participantsGram.listParticipants(participantsParams);

          // Counts only. Member ids are personal data and have no business in a
          // log that is read while debugging something else.
          actionLog.info("telegram-userbot handleAction participants completed", {
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
            throw new Error("telegram-userbot: no configured account found");
          }

          const journalPath = resolveJoinsJournalPath(
            cfg?.channels?.[ "telegram-userbot" ]?.accounts?.[ joinsAccountId ],
            joinsAccountId,
          );
          const selected = selectJoinRecords(readJoinRecords(journalPath), joinsParams);

          actionLog.info("telegram-userbot handleAction joins completed", {
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

        if (action !== "send") {
          throw new Error(`telegram-userbot: unsupported message action ${action}`);
        }

        const rawTo = resolveActionTarget(params, toolContext);
        const targetKind = inferOutboundTargetKind(rawTo);
        const to = normalizeOutboundTarget(rawTo);
        const replyToId = readStringOrNumberParam(params, "replyToId") ?? readStringOrNumberParam(params, "replyTo");
        const threadId = readStringOrNumberParam(params, "threadId");
        const messageThreadId = parseOptionalThreadId(threadId);
        actionLog.info("telegram-userbot handleAction send", {
          requestedAccountId: accountId,
          dryRun: dryRun === true,
          rawTo,
          to,
          targetKind,
          replyToId: replyToId ?? null,
          threadId: threadId ?? null,
          toolContextCurrentChannelId: toolContext?.currentChannelId ?? null,
        });

        const resolvedAccountId = resolveRuntimeAccountId(cfg, accountId);
        if (!resolvedAccountId) {
          throw new Error("telegram-userbot: no configured account found");
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
          actionLog.warn("telegram-userbot suppressing duplicate visible group reply", {
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
        const text = prefixReplyTextToAddress(
          readMessageText(params).replaceAll("\\n", "\n"),
          groupReplyAddress,
        );
        if (!text) {
          throw new Error("telegram-userbot: message text is required");
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
          throw new Error(`telegram-userbot: runtime not found for account ${resolvedAccountId}`);
        }

        const sent = await gram.sendText({
          target: to,
          text,
          targetKind,
          replyToMessageId: resolveReplyToMessageIdForTarget(rawTo, replyToId),
          messageThreadId,
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

        actionLog.info("telegram-userbot handleAction send completed", {
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
      async resolveTarget(ctx: { accountId: string; to: string }) {
        actionLog.info("telegram-userbot outbound resolveTarget", {
          accountId: ctx.accountId,
          rawTo: ctx.to,
        });
        const gram = runtimes.get(ctx.accountId);
        if (!gram) {
          throw new Error(`telegram-userbot: runtime not found for account ${ctx.accountId}`);
        }

        const targetKind = inferOutboundTargetKind(ctx.to);
        const target = normalizeOutboundTarget(ctx.to);

        return {
          ok: true,
          to: (await gram.resolvePeer(target, { kind: targetKind })).chatId ?? target,
        };
      },

      async sendText(ctx: {
        accountId: string;
        to: string;
        text: string;
        replyToId?: string | null;
        threadId?: string | number | null;
      }) {
        actionLog.info("telegram-userbot outbound sendText", {
          accountId: ctx.accountId,
          rawTo: ctx.to,
          replyToId: ctx.replyToId ?? null,
          threadId: ctx.threadId ?? null,
          text: ctx.text,
        });
        const gram = runtimes.get(ctx.accountId);
        if (!gram) {
          throw new Error(`telegram-userbot: runtime not found for account ${ctx.accountId}`);
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
        });

        actionLog.info("telegram-userbot outbound sendText completed", {
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
      }) {
        const gram = runtimes.get(ctx.accountId);
        if (!gram) {
          throw new Error(`telegram-userbot: runtime not found for account ${ctx.accountId}`);
        }

        actionLog.info("telegram-userbot outbound sendMedia", {
          accountId: ctx.accountId,
          to: ctx.to,
          replyToId: ctx.replyToId ?? null,
          threadId: ctx.threadId ?? null,
          filePath: ctx.filePath ?? null,
          mediaUrl: ctx.mediaUrl ?? null,
          hasText: Boolean(ctx.text),
          hasCaption: Boolean(ctx.caption),
        });

        const file = ctx.filePath ?? ctx.mediaUrl;
        if (!file) {
          throw new Error("telegram-userbot: sendMedia requires filePath or mediaUrl");
        }
        const messageThreadId = parseOptionalThreadId(ctx.threadId);

        const sent = await gram.sendMedia({
          target: ctx.to,
          file,
          caption: ctx.caption ?? ctx.text,
          replyToMessageId: resolveReplyToMessageIdForTarget(ctx.to, ctx.replyToId),
          messageThreadId,
        });

        actionLog.info("telegram-userbot outbound sendMedia completed", {
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
