// Исходящий контур канала: куда уходит текст и что при этом проверяется.
//
// Вынесено из channel.ts — файла на 3009 строк при следующем по величине
// 1165 (находка A6-11). Замыкание использовало отсюда ровно две вещи:
// карту рантаймов и журнал, поэтому блок отделяется фабрикой, а не
// переписыванием.

import {
  buildChannelOutboundSessionRoute,
  createSubsystemLogger,
  jsonResult,
} from "openclaw/plugin-sdk/core";
import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";
import {
  describeMedia,
  downloadInboundMediaToTempFile,
  downloadMessageMediaToFile,
  pruneFetchedMedia, assertLocalMediaWithinRoots } from "./media";
import { fetchedMediaFileName, parseFetchMediaParams } from "./fetch-media";
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
import { TELEGRAM_SERVICE_CHAT_ID } from "./constants";
import { GramJsClientManager } from "./gramjs-client";
import { normalizeTelegramEvent } from "./normalize";
import { isChatReadable, parseListMessagesParams, parseListParticipantsParams } from "./history";
import { isChatSendable, isPhoneNumberTarget, rememberSendScope, sendScopeFor } from "./send-scope";
import {
  appendJoinRecord,
  parseJoinEvent,
  parseJoinsParams,
  readJoinRecords,
  resolveJoinsJournalPath,
  selectJoinRecords,
} from "./joins";
import { parseReactionParams, resolveAgentReactionGuidance } from "./reactions";
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
import { operatorIdsFor, rememberOperatorIds, shouldSuppressGroupSystemNotice } from "./system-notice";
import { resolveStateDir } from "./state-dir";
import { describeChat, parseChatInfoParams } from "./chat-info";
import { parseTopicsParams } from "./topics";
import { isChatDiscoveryEnabled, parseDialogsParams } from "./dialogs";
import { resolveClawgramGroupToolPolicy } from "./group-tool-policy";
import {
  applyAccountSecrets,
  collectAccountSecretRefs,
  readSecretInput,
} from "./secret-refs";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import type { PluginConfig, RuntimeMap } from "./types";
import { consumeGroupReplyAddress, peekGroupReplyAddress, rememberGroupReplyAddress, buildGroupReplyAddress } from "./group-reply-address";
import {
  hadTurnSendJustNow,
  hasRecentVisibleGroupReply,
  rememberTurnSend,
  rememberVisibleGroupReply,
} from "./group-visible-reply-guard";
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
  resolveAccountScopes,
  resolveAddressableText,
  resolveGroupConfig,
  resolveActiveUsername,
  isSenderAllowed,
  hasTelegramMention,
  hasExplicitTelegramMention,
  toDisplayName,
  prefixReplyTextToAddress,
  stripSilentReplyToken,
  stripTtsDirectives,
  isSilentReplyText,
  resolveReplyTarget,
  resolveChatTarget,
  resolveReplyParent,
  resolveSenderProfile,
  resolveSenderProfileWithTimeout,
  resolveOutboundParseMode,
  resolveDryRun,
} from './helpers';
import { resolveProxyConfig } from './proxy-config';
import { CHANNEL_ID } from './constants';
import { CORE_ACTION_SYNONYMS, MANAGE_ACTIONS, canonicalAction } from "./actions";
import {
  INBOUND_MEDIA_MAX_BYTES,
  readInboundAttachment,
  understandAttachmentFile,
} from "./attachments";
import { parseOptionalThreadId } from "./helpers";

const actionLog = createSubsystemLogger("channels/clawgram");

/** Исходящий контур для карты рантаймов канала. */
export function createOutbound(runtimes: RuntimeMap) {
  return {

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

        const target = normalizeOutboundTarget(raw);
        // Тот же барьер, что у `handleAction`: доставка ядра (`--deliver`,
        // анонсы субагентов) идёт этим путём и мимо той проверки. Отказ
        // здесь возвращается результатом, а не броском: бросок в этом хуке
        // роняет весь gateway (грабли 06.08.2026, выше).
        if (!isChatSendable(target, sendScopeFor(ctx.accountId))) {
          const reason = isPhoneNumberTarget(target)
            ? "phone-number target"
            : "chat outside send scope";
          actionLog.warn("clawgram outbound resolveTarget refused", {
            accountId: ctx.accountId,
            target,
            reason,
          });
          return { ok: false as const, error: new Error(`clawgram: not-allowed-chat ${target}`) };
        }

        return { ok: true as const, to: target };
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

      // Область отправки — и здесь. Путь доставки ядра (`--deliver`,
      // анонсы субагентов) зовёт sendText напрямую, минуя resolveTarget и
      // handleAction, где барьер уже стоял: третий из трёх исходящих путей
      // был открыт для любого адресата и телефонного номера (D2-01, A5-12).
      const scopedTarget = normalizeOutboundTarget(ctx.to);
      if (!isChatSendable(scopedTarget, sendScopeFor(ctx.accountId))) {
        actionLog.warn("clawgram outbound sendText refused", {
          accountId: ctx.accountId,
          target: scopedTarget,
          reason: isPhoneNumberTarget(scopedTarget) ? "phone-number target" : "chat outside send scope",
        });
        return { skipped: "not-allowed" as const };
      }

      // Core's operational chatter (tool-error warnings, fallback notices)
      // stays out of group chats: it is telemetry for the operator, not a
      // reply to the room, and it has already been seen carrying shell
      // commands with secret-store paths. DMs keep it. The text itself is
      // never logged — see system-notice.ts for why.
      const suppressedNotice = shouldSuppressGroupSystemNotice({
        targetKind: inferOutboundTargetKind(ctx.to),
        text: ctx.text,
        to: ctx.to,
        operatorIds: operatorIdsFor(ctx.accountId),
      });
      if (suppressedNotice) {
        actionLog.warn("clawgram suppressing system notice in group", {
          accountId: ctx.accountId,
          rawTo: ctx.to,
          noticeKind: suppressedNotice,
          textLength: ctx.text.length,
        });

        return { skipped: "system-notice" as const };
      }

      const gram = runtimes.get(ctx.accountId);
      if (!gram) {
        throw new Error(`clawgram: runtime not found for account ${ctx.accountId}`);
      }

      // The agent already answered this message with its own `send`, and this
      // is core delivering the same turn's final text. Two messages for one
      // answer is how 2026-08-10 read in a work chat: every request reported
      // twice, in slightly different words, seconds apart.
      //
      // Core's own convention is that an agent which has sent a message
      // returns NO_REPLY; this catches the turns that forget. The window is
      // seconds wide, so a result the assistant comes back with later is
      // still delivered.
      if (ctx.replyToId !== null && ctx.replyToId !== undefined && hadTurnSendJustNow({
        accountId: ctx.accountId,
        chatId: normalizeOutboundTarget(ctx.to),
        currentMessageId: ctx.replyToId,
      })) {
        actionLog.warn("clawgram suppressing echo of a turn that already sent", {
          accountId: ctx.accountId,
          rawTo: ctx.to,
          replyToId: ctx.replyToId,
          textLength: ctx.text.length,
        });

        return { skipped: "duplicate" as const };
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
      /** The roots the agent may read from, when core scoped this call. */
      mediaLocalRoots?: readonly string[];
      mediaAccess?: { localRoots?: readonly string[] };
    }) {
      const gram = runtimes.get(ctx.accountId);
      if (!gram) {
        throw new Error(`clawgram: runtime not found for account ${ctx.accountId}`);
      }

      // Same rule as the action path: a local file outside the declared
      // roots is refused before anything is uploaded.
      const outboundRoots = ctx.mediaLocalRoots ?? ctx.mediaAccess?.localRoots;
      assertLocalMediaWithinRoots(ctx.filePath, outboundRoots);
      assertLocalMediaWithinRoots(ctx.mediaUrl, outboundRoots);

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

      // Ниже — проверки, которые у `sendText` были, а здесь не было ни
      // одной: путь доставки медиа писался отдельно и обзавёлся только
      // своими границами (находка A6-18).
      const mediaTarget = normalizeOutboundTarget(ctx.to);

      // Область отправки: файл наружу — такое же исходящее, как текст.
      // `resolveTarget` ядро зовёт не на каждом пути, поэтому проверяем и тут.
      if (!isChatSendable(mediaTarget, sendScopeFor(ctx.accountId))) {
        actionLog.warn("clawgram outbound sendMedia refused", {
          accountId: ctx.accountId,
          target: mediaTarget,
          reason: isPhoneNumberTarget(mediaTarget) ? "phone-number target" : "chat outside send scope",
        });
        return { skipped: "not-allowed" as const };
      }

      // Молчаливый ответ: подпись с токеном молчания означает «ничего не
      // говорить», и отправлять файл с ним в подписи — тем более.
      const mediaCaption = ctx.caption ?? ctx.text;
      if (mediaCaption?.trim() && isSilentReplyText(mediaCaption)) {
        actionLog.info("clawgram suppressing silent outbound media", {
          accountId: ctx.accountId,
          rawTo: ctx.to,
        });
        return { skipped: "silent" as const };
      }

      // Обращение в группе — то же, что у текста: адрес принадлежит
      // конкретному входящему сообщению, а не последнему говорившему.
      const mediaReplyAddress = consumeGroupReplyAddress({
        accountId: ctx.accountId,
        chatId: ctx.to,
        replyToId: ctx.replyToId,
      });

      // Чего здесь НЕТ намеренно:
      // — подавление эха хода (`hadTurnSendJustNow`): у текста дубль стоит
      //   лишнего сообщения, а у медиа отказ стоит потерянного файла —
      //   картинку агент готовил, и второй раз она не появится;
      // — подавление служебных сообщений ядра в группах: они текстовые,
      //   медиа-доставка ими не бывает.

      const messageThreadId = parseOptionalThreadId(ctx.threadId);
      // Same normalization `sendText` does two functions up. Without it the
      // channel prefix reaches peer resolution and the send throws — which is
      // exactly how a synthesized group reply died on 2026-08-08, silently
      // enough that the transcript fallback posted it as raw text instead.
      const target = normalizeOutboundTarget(ctx.to);

      const sent = await gram.sendMedia({
        target,
        file,
        // Подпись получает то же обращение, что и текстовый ответ.
        caption: mediaCaption
          ? prefixReplyTextToAddress(mediaCaption, mediaReplyAddress)
          : mediaCaption,
        // Captions follow the account reply format like every other reply:
        // they are the same agent prose, just attached to a file (2.15.0).
        parseMode: gram.replyParseMode,
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
    };
}
