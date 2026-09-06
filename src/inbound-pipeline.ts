// Входящий контур: одно событие Telegram от нормализации до ответа.
//
// Вынесено из `channel.ts` — 856 строк внутри `gateway.startAccount`, самый
// крупный кусок файла и единственный путь, по которому проходит каждое
// входящее сообщение (находка A6-11).
//
// Почему это оказалось возможно сделать безопасно. Свободных переменных у
// обработчика ровно девять, и их назвал не я, а компилятор: тело временно
// вынесли функцией без параметров и прочитали список «Cannot find name».
// Остальные два десятка имён — импорты модуля, они переехали сюда сами.
//
// Тело перенесено ДОСЛОВНО. Контекст разбирается первой строкой, чтобы
// каждая следующая осталась той же самой: это проверяется сравнением с
// исходным блоком, а не глазами.
import {
  createSubsystemLogger,
  } from "openclaw/plugin-sdk/core";
import {
  describeMedia,
  downloadInboundMediaToTempFile,
  downloadMessageMediaToFile,
  pruneFetchedMedia, assertLocalMediaWithinRoots } from "./media";
import { fetchedMediaFileName, parseFetchMediaParams } from "./fetch-media";
import { readStringOrNumberParam, readStringParam } from "openclaw/plugin-sdk/param-readers";
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
import { NewMessage, Raw } from "telegram/events";
import { TELEGRAM_SERVICE_CHAT_ID } from "./constants";
import { normalizeTelegramEvent } from "./normalize";
import { isChatReadable, parseListMessagesParams, parseListParticipantsParams } from "./history";
import { isChatSendable, isPhoneNumberTarget } from "./send-scope";
import {
  appendJoinRecord,
  parseJoinEvent,
  parseJoinsParams,
  readJoinRecords,
  resolveJoinsJournalPath,
  selectJoinRecords,
} from "./joins";
import { resolveAgentReactionGuidance } from "./reactions";
import {
  isChatManageable,
  isManagementEnabled,
  parseAddMembersParams,
  parseCreateGroupParams,
  parseDemoteAdminParams,
  parseInviteLinkParams,
  parsePromoteAdminParams,
  parseRemoveMemberParams,
  parseTransferOwnershipParams,
} from "./manage";
import { reactToSilentMention } from "./silent-reaction";
import { shouldSuppressGroupSystemNotice } from "./system-notice";
import { operatorIdsFor } from "./account-registry";
import { describeChat, parseChatInfoParams } from "./chat-info";
import { isChatDiscoveryEnabled, parseDialogsParams } from "./dialogs";
import {
  applyAccountSecrets,
  collectAccountSecretRefs,
  readSecretInput,
} from "./secret-refs";
import type { PluginConfig, RuntimeMap } from "./types";
import { consumeGroupReplyAddress, rememberGroupReplyAddress, buildGroupReplyAddress } from "./group-reply-address";
import {
  hadTurnSendJustNow,
  hasRecentVisibleGroupReply,
  rememberTurnSend,
  rememberVisibleGroupReply,
} from "./group-visible-reply-guard";
import {
  buildConversationTarget,
  buildScopedGroupPeerId,
  readLatestAssistantFallbackFromTranscript,
  resolveAccountScopes,
  resolveAddressableText,
  resolveGroupConfig,
  isSenderAllowed,
  hasTelegramMention,
  hasExplicitTelegramMention,
  prefixReplyTextToAddress,
  stripSilentReplyToken,
  stripTtsDirectives,
  resolveReplyTarget,
  resolveChatTarget,
  resolveReplyParent,
  resolveSenderProfile,
  resolveSenderProfileWithTimeout,
  parseOptionalThreadId,
  readAccountReactionLevel,
  readAccountReactionModel,
} from './helpers';
import { CHANNEL_ID } from './constants';
import { CORE_ACTION_SYNONYMS, MANAGE_ACTIONS, canonicalAction } from "./actions";
import {
  readInboundAttachment,
  } from "./attachments";

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
    model: readAccountReactionModel(params.cfg, params.accountId),
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

const actionLog = createSubsystemLogger("channels/clawgram");

/** Всё, что обработчик берёт у аккаунта. Ровно девять имён — см. шапку. */
export type InboundContext = {
  accountId: string;
  cfg: any;
  channelRuntime: any;
  gram: any;
  log: any;
  pluginRuntime?: PluginRuntime;
  runtimes: RuntimeMap;
  selfId: string | undefined;
  // Эти три компилятор назвал не сразу: в теле они стоят сокращённой записью
  // (`{ client }`), и первая проба, вынесшая тело без параметров, их не
  // показала. Свободная переменная в shorthand-свойстве — отдельный класс
  // слепого пятна, и нашёлся он только сборкой.
  client: any;
  selfUsername: string | undefined;
  selfLabel: string | undefined;
};

/**
 * The text a reply may carry into a chat, after the filters every reply path
 * shares — or `undefined` when nothing should go out.
 *
 * Three doors deliver an agent's words: the group `deliver` closure, the
 * direct-message `deliver` closure and the transcript fallback. Each carried
 * its own copy of the same two checks — drop the silent token, drop core's
 * telemetry — and the copies drifted: the DM path had no notice filter at
 * all until B5-01 (audit B5-13). One function now; the log lines keep their
 * historical wording so journals stay greppable.
 */
export function visibleReplyText(params: {
  text: unknown;
  kind: "group" | "user";
  where: "group reply" | "direct reply" | "transcript fallback";
  accountId: string;
  chatId: string;
  messageId: string | number;
  log: any;
}): string | undefined {
  // Not destructured: a wiring ratchet in test/inbound-pipeline.test.ts finds
  // handleInboundEvent's own destructuring of its context by pattern, and
  // nothing shaped like it may stand in front.
  const accountId = params.accountId;
  const chatId = params.chatId;
  const messageId = params.messageId;
  const log = params.log;
  const outboundText = typeof params.text === "string" ? params.text.trim() : "";
  if (!outboundText) {
    return undefined;
  }

  // The agent may decline to answer by returning the shared silent token.
  // Dropped before addressing: otherwise the reply-address prefix turns it
  // into a visible message.
  const visibleText = stripSilentReplyToken(outboundText);
  if (!visibleText) {
    log?.info?.(`clawgram suppressing silent ${params.where}`, { accountId, chatId, messageId });
    return undefined;
  }

  // Core glues its telemetry to the turn's payload and it arrives here the
  // same way an answer does. In a group it never goes out; in a DM only the
  // named operator may receive it (A5-10, A5-11, B5-01).
  const notice = shouldSuppressGroupSystemNotice(params.kind === "group"
    ? { targetKind: "group", text: visibleText }
    : { targetKind: "user", text: visibleText, to: chatId, operatorIds: operatorIdsFor(accountId) });
  if (notice) {
    log?.warn?.(`clawgram suppressing system notice in ${params.where}`, {
      accountId, chatId, messageId, noticeKind: notice, textLength: visibleText.length,
    });
    return undefined;
  }

  return visibleText;
}

export async function handleInboundEvent(event: unknown, ctx: InboundContext) {
  const { accountId, cfg, channelRuntime, client, gram, log,
    pluginRuntime, runtimes, selfId, selfLabel, selfUsername } = ctx;

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

    // Ворота — ДО сети. До 2.25.0 на каждое сообщение из любой группы,
    // где сидит аккаунт, — включая группы вне `groups` — плагин делал
    // до семи запросов к Telegram (профиль отправителя, адрес ответа,
    // цель чата) и только потом отбрасывал сообщение как чужое.
    // Посторонний, флудящий в такой группе, тратил соединение и
    // rate-limit аккаунта (B5-04, остаток A5-06). Группа вне конфига
    // и выключенная группа заканчиваются здесь, без единого вызова.
    const earlyScopes = resolveAccountScopes(cfg, accountId);
    const earlyGroupConfig = normalized.chatType === "group"
      ? resolveGroupConfig(earlyScopes.groups, normalized.chatId)
      : undefined;
    if (normalized.chatType === "group") {
      if (!earlyGroupConfig) {
        log?.info?.("clawgram skipping group not present in groups config", {
          accountId,
          chatId: normalized.chatId,
          messageId: normalized.messageId,
        });
        return;
      }
      if (earlyGroupConfig.enabled === false) {
        log?.info?.("clawgram skipping disabled group", {
          accountId,
          chatId: normalized.chatId,
          messageId: normalized.messageId,
        });
        return;
      }
    }

    // Профиль отправителя нужен воротам только когда allowFrom
    // называет кого-то по @handle, а сообщение handle не принесло;
    // числовые id сверяются без сети.
    const gateAllowFrom = normalized.chatType === "group"
      ? earlyGroupConfig?.allowFrom
      : earlyScopes.allowFrom;
    const allowFromNeedsHandle = Array.isArray(gateAllowFrom)
      && gateAllowFrom.some((entry) => String(entry).trim().startsWith("@"));
    const needsProfile = !normalized.senderUsername && allowFromNeedsHandle;
    const senderProfile: { username?: string; display?: string } = needsProfile
      ? (normalized.chatType === "direct"
        ? await resolveSenderProfileWithTimeout(rawMessage, {
            senderId: normalized.senderId,
            client,
          }, 1500)
        : await resolveSenderProfile(rawMessage, {
            senderId: normalized.senderId,
            client,
          }))
      : {};

    if (!normalized.senderUsername && senderProfile.username) {
      normalized.senderUsername = senderProfile.username;
    }

    if (!normalized.senderDisplay && senderProfile.display) {
      normalized.senderDisplay = senderProfile.display;
    }

    let text = normalized.text?.trim();

    // Whether this sender may reach the agent at all — decided before
    // the attachment is fetched.
    //
    // Reading an attachment downloads up to 25 MB and then spends a
    // transcription or vision call on it. That used to happen for
    // every photo and voice note from anyone in any group the account
    // sits in, and only afterwards was the sender checked against
    // `allowFrom`. A stranger could therefore spend the owner's model
    // budget at will. None of these checks depend on the message text,
    // so they cost nothing to run first.
    const inboundSenderId = normalized.senderId ?? normalized.chatId;
    const inboundScopes = resolveAccountScopes(cfg, accountId);
    const inboundGroupConfig = normalized.chatType === "group"
      ? resolveGroupConfig(inboundScopes.groups, normalized.chatId)
      : undefined;
    const senderMayReachAgent = normalized.chatType === "group"
      ? Boolean(
        inboundGroupConfig
        && inboundGroupConfig.enabled !== false
        && isSenderAllowed({
          allowFrom: inboundGroupConfig.allowFrom,
          senderId: inboundSenderId,
          senderUsername: normalized.senderUsername,
        }),
      )
      : isSenderAllowed({
        allowFrom: inboundScopes.allowFrom,
        senderId: inboundSenderId,
        senderUsername: normalized.senderUsername,
      });

    // An attachment carries no text of its own, and dropping it as
    // "empty" is how the assistant used to go silent on being spoken
    // to or shown something. Read it into the body instead: for a
    // voice note and a screenshot alike, the attachment *is* the
    // message. A caption is kept and the reading appended, because
    // "look at this" plus the picture is one thought, not two.
    // Адрес ответа и цель чата — сеть, и нужны только тому, кому
    // отвечают: считаются после ворот (B5-04).
    const directReplyTarget = normalized.chatType === "direct" ? undefined
      : senderMayReachAgent ? await resolveReplyTarget(rawMessage) : undefined;
    const replyTarget = normalized.chatType === "direct"
      ? normalized.chatId
      : senderMayReachAgent ? await resolveChatTarget(rawMessage) : undefined;
    if (replyTarget) {
      normalized.replyTarget = replyTarget;
    }

    const attachment = senderMayReachAgent ? await readInboundAttachment({
      gram,
      event,
      cfg,
      runtime: pluginRuntime,
      log,
      accountId,
      chatId: normalized.chatId,
      messageId: normalized.messageId,
    }) : undefined;
    if (attachment) {
      const marker = attachment.understanding === "transcript" ? "голосовое" : "изображение";
      const read = `[${marker}] ${attachment.text}`;
      text = text ? `${text}\n\n${read}` : read;
    }

    // What the mention gate is allowed to read.
    //
    // A transcript is the sender's own speech, so "Тина, посмотри"
    // said aloud addresses the agent exactly as typing it would. A
    // description is not: it is a vision model reading somebody
    // else's content, and a screenshot of a chat where a third party
    // wrote "@tina_bot" is not an address to her. Feeding the whole
    // body to the gate made every such screenshot wake her up.
    const addressableText = resolveAddressableText({
      messageText: normalized.text,
      bodyText: text,
      understanding: attachment?.understanding,
    });

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
      (normalized.chatId === TELEGRAM_SERVICE_CHAT_ID || senderId === TELEGRAM_SERVICE_CHAT_ID);
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
    // account setting (2.3.1); absent keeps the GramJS default
    // (its markdown parser — not plain text, see 2.15.0 notes).
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
  // Resolved once, above, before the attachment fetch that depends on
  // the answer — and by the same resolver `resolveAccount` uses, so the
  // gate applied here is the one the account was started with.
  const { allowFrom: directAllowFrom } = inboundScopes;
  // Fixed, not configurable: clawgram admits a DM by `allowFrom` alone
  // (the roster) and offers no pairing challenge — a stranger cannot
  // talk their way in. Core's resolver is still called for the block
  // decision and `commandAuthorized`; with "open" it never answers
  // "pairing", so the 30-line challenge branch that once followed it
  // was unreachable and read like a barrier (audit B5-15).
  const dmPolicy = "open";

    if (normalized.chatType === "group") {
      const groupConfig = inboundGroupConfig;
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
          // Сам список — id владельца и допущенных — в журнал не идёт:
          // посторонний управлял бы числом его копий в journald (B5-09).
          allowFromCount: Array.isArray(groupConfig.allowFrom) ? groupConfig.allowFrom.length : 0,
          allowFromHasWildcard: Array.isArray(groupConfig.allowFrom) && groupConfig.allowFrom.some((e) => String(e).trim() === "*"),
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
      // Under `tag` the name is not an address: in a chat of a thousand
      // people it occurs in conversation constantly and is aimed at her
      // almost never. Only the `@` counts, and it is the same fact the
      // stricter rung of the ladder is named after.
      const wasMentioned = groupConfig.groupPolicy === "tag"
        ? hasExplicitTelegramMention({ selfUsername, text: addressableText, message: rawMessage })
        : hasTelegramMention({
          cfg,
          agentId: route.agentId,
          selfUsername,
          text: addressableText,
          message: rawMessage,
        });
      // One fetch serves two needs: the reply-to-self gate below and
      // the parent's text for the agent (ReplyToBody), which a plain
      // reply does not carry on its own.
      const replyParent = await resolveReplyParent(rawMessage, { selfId, selfLabel });
      const wasReplyToSelf = replyParent.isSelf;
      const mentionDecision = resolveInboundMentionDecision({
        facts: {
          canDetectMention: true,
          wasMentioned,
          hasAnyMention: /(^|\s)@[a-zA-Z0-9_]{5,}\b/.test(addressableText),
        },
        policy: {
          isGroup: true,
          requireMention: groupConfig.groupPolicy !== "open",
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
        groupPolicy: groupConfig.groupPolicy,
        mentionedFlag: rawMessage?.mentioned === true,
        hasEntities: Array.isArray(rawMessage?.entities) ? rawMessage.entities.length : 0,
        wasMentioned,
        wasReplyToSelf,
        shouldSkip: mentionDecision.shouldSkip,
        textLength: text.length,
      });

      if (groupConfig.groupPolicy !== "open" && mentionDecision.shouldSkip && !wasReplyToSelf) {
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
        // A plain reply has no highlight; core then falls back to the
        // parent's body, which only exists if the channel fetched it.
        ReplyToBody: replyParent.body,
        ReplyToSender: replyParent.sender,
        MessageThreadId: normalized.messageThreadId,
        NativeChannelId: normalized.chatId,
        // Trusted per-group prompt block from `groups.<id>.systemPrompt`.
        // Core normalizes it (`normalizeTrustedTextField`) and appends
        // it to the system prompt for this turn. Undefined = no block.
        GroupSystemPrompt: groupConfig.systemPrompt,
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
                payloadTextLength: outboundText.length,
                payloadReplyToId: payload.replyToId ?? null,
              });
              const visibleText = visibleReplyText({
                text: outboundText, kind: "group", where: "group reply",
                accountId, chatId: normalized.chatId, messageId: normalized.messageId, log,
              });
              if (!visibleText) {
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
            // `groups.<id>.skills` → core's per-turn skill allowlist.
            // Undefined = inherit the agent's skills; [] = none here.
            skillFilter: groupConfig.skillFilter,
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
          const rawFallback = fallbackText
            ? stripTtsDirectives(stripSilentReplyToken(fallbackText))
            : "";
          // Тот же фильтр и здесь: последняя реплика в стенограмме
          // вполне может оказаться именно уведомлением об ошибке.
          const visibleFallbackText = visibleReplyText({
            text: rawFallback, kind: "group", where: "transcript fallback",
            accountId, chatId: normalized.chatId, messageId: normalized.messageId, log,
          }) ?? "";
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
              fallbackTextLength: visibleFallbackText.length,
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
        // The indicator is a promise of an answer, and it is owed only
        // to someone who addressed her. Under `open` the turn runs on
        // every message in the chat, so without this the whole room
        // watches her "type" through conversations she is only reading.
        typing: mentionDecision.effectiveWasMentioned || wasReplyToSelf,
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
        allowFromCount: Array.isArray(directAllowFrom) ? directAllowFrom.length : 0,
        allowFromHasWildcard: Array.isArray(directAllowFrom) && directAllowFrom.some((e) => String(e).trim() === "*"),
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

    // Same fetch as the group path. In a DM the parent is as often
    // the agent's own message as the person's — the owner answers a
    // notice she sent — and neither text is available any other way.
    const replyParent = await resolveReplyParent(rawMessage, { selfId, selfLabel });

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
          ReplyToBody: replyParent.body,
          ReplyToSender: replyParent.sender,
          NativeChannelId: normalized.chatId,
        },
        deliver: async (payload) => {
          // Тот же фильтр, что у группового ответа: личный ответ идёт
          // третьим путём, и закрытие A5-11 его не покрывало (B5-01).
          const visibleText = visibleReplyText({
            text: payload.text, kind: "user", where: "direct reply",
            accountId, chatId: normalized.chatId, messageId: normalized.messageId, log,
          });
          if (!visibleText) {
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

}
