import {
  buildChannelOutboundSessionRoute,
  createSubsystemLogger,
  jsonResult,
} from "openclaw/plugin-sdk/core";
import os from "node:os";
import path from "node:path";

/**
 * How long a file fetched by `fetch-media` stays on disk.
 *
 * Long enough for the turn that asked for it and the next one — forwarding a
 * screenshot happens minutes after reading it, not days — and short enough
 * that a chat full of images does not silently become a copy of itself in the
 * temp directory.
 */
// Час, а не сутки: `fetch-media` существует ради «прочитать и переслать», и
// файл нужен ровно на время хода. Сутки означали сутки чужой личной переписки
// на диске (A5-13).
const FETCHED_MEDIA_TTL_MS = 60 * 60 * 1000;

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
import {
  describeMedia,
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
import type { ChannelCapabilities } from "openclaw/plugin-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { createChannelPairingController } from "openclaw/plugin-sdk/channel-pairing";
import { NewMessage, Raw } from "telegram/events";
import { GramJsClientManager } from "./gramjs-client";
import { isChatReadable, parseListMessagesParams, parseListParticipantsParams } from "./history";
import { isChatSendable, isPhoneNumberTarget, rememberSendScope} from "./send-scope";
import {
  appendJoinRecord,
  parseJoinEvent,
  parseJoinsParams,
  readJoinRecords,
  resolveJoinsJournalPath,
  selectJoinRecords,
} from "./joins";
import { parseReactionParams} from "./reactions";
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
import { rememberOperatorIds} from "./system-notice";
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
import { consumeGroupReplyAddress, peekGroupReplyAddress} from "./group-reply-address";
import {
  hasRecentVisibleGroupReply,
  rememberTurnSend,
  rememberVisibleGroupReply,
} from "./group-visible-reply-guard";
import {
  normalizeOutboundTarget,
  resolveConfiguredAccountId,
  inferOutboundTargetKind,
  routeKindFromChatType,
  buildScopedGroupPeerId,
  resolveActionTarget,
  resolveReplyToMessageIdForTarget,
  readMessageText,
  readVoiceNoteFlag,
  resolveAccountScopes,
  resolveActiveUsername,
  toDisplayName,
  prefixReplyTextToAddress,
  isSilentReplyText,
  resolveOutboundParseMode,
  resolveDryRun,
  parseOptionalThreadId,
} from './helpers';
import { resolveProxyConfig } from './proxy-config';
import { CHANNEL_ID } from './constants';

const actionLog = createSubsystemLogger("channels/clawgram");




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

/**
 * Outbound scope as configured. Handed to `isChatSendable` raw: an absent
 * value means "unrestricted" and an empty list means "deny", and only the
 * raw value tells those apart — same shape as `readChats`.
 */
/**
 * Хэндл в `allowFrom` — обещание, которое Telegram не держит.
 *
 * Запись `@username` утверждает не про человека, а про хэндл: хэндл можно
 * освободить, и тогда его берёт кто угодно — запись начинает пускать
 * постороннего, ничего об этом не сказав. Числовой id так не переходит из рук
 * в руки. Отказываться от хэндлов нельзя (люди пишут ими, и конфиг у многих
 * уже такой), но молчать об этом тоже не годится — поэтому предупреждение
 * один раз при старте аккаунта (находка A5-16).
 */
function warnAboutHandleAllowlistEntries(cfg: any, accountId: string): void {
  const account = cfg?.channels?.[ "clawgram" ]?.accounts?.[ accountId ];
  const entries = Array.isArray(account?.allowFrom) ? account.allowFrom : [];
  const handles = entries
    .map((entry: unknown) => String(entry ?? "").trim())
    .filter((entry: string) => entry.startsWith("@"));
  if (handles.length === 0) {
    return;
  }

  actionLog.warn("clawgram allowFrom names handles, not ids", {
    accountId,
    // Сами хэндлы — это про людей: в лог уходит только их число.
    handleEntries: handles.length,
    why: "a released handle can be taken by someone else; numeric ids do not change hands",
  });
}

function resolveAccountSendChats(cfg: any, accountId: string): unknown {
  return cfg?.channels?.[ "clawgram" ]?.accounts?.[ accountId ]?.sendChats;
}

/** One refusal for every outbound action, so the three read the same. */
function refuseOutboundOutsideScope(
  action: string,
  accountId: string,
  target: string,
): never {
  const phone = isPhoneNumberTarget(target);
  const reason = phone ? "phone-number target" : "chat outside send scope";
  // Телефонный номер — персональные данные: в журнал идёт вид цели, не значение (B5-09).
  actionLog.warn(`clawgram ${action} refused: ${reason}`, { accountId, ...(phone ? { targetKind: "phone" } : { target }) });
  throw new Error(`clawgram: not-allowed-chat ${target}`);
}

/**
 * Management scope as configured. Handed to `isChatManageable` raw: unlike
 * `readChats`, an absent value already means "deny", so there is nothing to
 * tell apart here.
 */
/** Chat discovery as configured; absent means "deny", like management scope. */
/**
 * Кому уходит операционная телеметрия ядра в личке.
 *
 * `operatorIds` — если задан. Иначе `allowFrom`, но только когда это
 * конкретный список: со звёздочкой он означает «пишет кто угодно», и слать
 * туда пути secret-store нельзя (A5-11). Пустой результат означает «оператор
 * не назван», и уведомление подавляется везде.
 *
 * Запоминается при старте аккаунта — см. реестр в system-notice.ts.
 */
export function resolveAccountOperatorIds(cfg: any, accountId: string): string[] {
  const account = cfg?.channels?.[ "clawgram" ]?.accounts?.[ accountId ];
  // Только явный список. Умолчание «operatorIds = allowFrom» делало
  // оператором каждого допущенного собеседника — и телеметрию с путями
  // secret-store получал любой из них (D2-03, A5-11). Не назван — не
  // назван: уведомления подавляются везде.
  const raw = account?.operatorIds;
  if (raw === undefined || raw === null) return [];
  const entries = Array.isArray(raw) ? raw : [ raw ];
  return entries.map((entry: unknown) => String(entry).trim()).filter(Boolean);
}

function resolveAccountDiscoverChats(cfg: any, accountId: string): unknown {
  return cfg?.channels?.[ "clawgram" ]?.accounts?.[ accountId ]?.discoverChats;
}

function resolveAccountManageChats(cfg: any, accountId: string): unknown {
  return cfg?.channels?.[ "clawgram" ]?.accounts?.[ accountId ]?.manageChats;
}

/** Same normalization `readChats` gets, for the resolved-account copy. */
function readAccountManageChats(account: any): string[] | undefined {
  const raw = account?.manageChats;
  if (raw === undefined || raw === null) return undefined;
  const entries = Array.isArray(raw) ? raw : [ raw ];
  return entries.map((entry) => String(entry).trim()).filter(Boolean);
}

import { CORE_ACTION_SYNONYMS, MANAGE_ACTIONS, canonicalAction } from "./actions";

// Словарь имён живёт в ./actions. Реэкспорт — ради вызывающих снаружи:
// тесты и другие модули знают его по этому файлу с 2.19.4.
export { CORE_ACTION_SYNONYMS, canonicalAction };
import { createOutbound } from "./outbound";
import { handleInboundEvent } from "./inbound-pipeline";



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
import {
  INBOUND_MEDIA_MAX_BYTES,
  understandAttachmentFile,
} from "./attachments";

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

  /**
   * The connected runtime for an account, or a refusal naming it.
   *
   * One helper instead of the eleven copies of this three-liner that used to
   * sit inside each dispatch branch — the same repetition that made every new
   * action cost a scaffold (finding A6-11).
   */
  const requireRuntimeFor = (id: string) => {
    const gram = runtimes.get(id);
    if (!gram) {
      throw new Error(`clawgram: runtime not found for account ${id}`);
    }

    return gram;
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

    // Core plans config hot reloads from these prefixes. Without the
    // declaration a changed `channels.clawgram.*` path matches no rule and
    // core restarts the whole Gateway (SIGUSR1, all runs aborted) — measured
    // 2026-08-13. With it, the same edit restarts only this channel. No
    // `noopPrefixes`: `groups`/`allowFrom`/`readChats` are read from the cfg
    // captured in `startAccount`, so a channel restart is exactly what an
    // edit needs to take effect.
    reload: { configPrefixes: [ "channels.clawgram" ] },

    // Per-group `tools` / `toolsBySender` from the config. Core asks the
    // channel first because only the channel knows that its group ids carry
    // an account prefix; see src/group-tool-policy.ts.
    groups: {
      resolveToolPolicy: resolveClawgramGroupToolPolicy,
    },

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
        "Explicit targets may be @username, numeric Telegram user id, group chat ids, or clawgram:<target>.",
        "For Telegram forum topics, send to the group chat id and pass the topic id separately as `threadId`.",
        "Use the `react` action to acknowledge a message with an emoji instead of sending a reply; pass an empty `emoji` (or `remove: true`) to take the reaction back.",
        "Use the `channel-info` action to learn what a chat is — title, type, member count, description, pinned message — instead of guessing from its id. Name the chat with `chatId` and do not pass `target`: core refuses it for this action, and the descriptive spelling `chatInfo` is not callable from this tool at all.",
        "Use the `thread-list` action to list a forum's topics by name (optional `query` narrows by title); that is where a `threadId` comes from when someone names a topic instead of quoting a message in it. Name the chat with `chatId` and do not pass `target` — core refuses it for this action. `topics` is the same call under a name core does not know, and is only reachable through the gateway RPC.",
        "Name the chat for `read` with `target`, never `chatId`: `read` is in core's own vocabulary, so core resolves the destination itself and reads only `to`/`target` — `chatId` is silently ignored and the call is refused as targetless. The chat-shaped reads next to it (`thread-list`, `channel-info`, `member-info`) are the opposite, because core does not know them; that asymmetry is core's, not a typo, and it cost 745 refused reads in the week before 2026-09-04.",
        "Pass that `threadId` to `read` as well: without it a forum read returns every topic interleaved rather than the one that was asked about.",
        "Use the `download-file` action to fetch the attachment on a message `read` reported. Name the chat with `chatId` and the message with `messageId`; do not pass `target` — core refuses it for this action: `mode: \"read\"` returns a description of an image or a transcript of a voice note, `\"file\"` returns a path to reuse, `\"both\"` (default) returns both. `read` only says an attachment exists; this is what brings it.",
        "Use the `channel-list` action to find out which group chats this account is actually in — including ones nobody has configured yet. It reports id, title and type only, never direct chats, and only when the account enables `discoverChats`.",
        "Use `member-info` with a `chatId` to list who is in a chat, and `kick` with a `chatId` and `userId` to remove someone from a managed chat. The rest of the chat-management family and `joins` have no name core knows, so they are reachable only through the gateway RPC, not from this tool.",
        "Use `createGroup` (title, optional about, optional users) to create a new Telegram supergroup; `addMembers`/`removeMember` change who is in a managed chat, `promoteAdmin`/`demoteAdmin` grant or revoke admin rights, `transferOwnership` hands the chat over, `inviteLink` issues an invite link for people Telegram refused to add directly.",
      ],
      messageToolCapabilities: () => [
        "clawgram can reply in the current Telegram conversation when no explicit target is provided.",
        "clawgram can send text messages to direct chats and groups from the connected personal account.",
        "clawgram supports Telegram forum topics via the `threadId` parameter on group sends.",
        "clawgram can add and clear emoji reactions on messages. A plain Telegram account holds one reaction per message, so a new emoji replaces the previous one.",
        "clawgram can describe a chat via `channel-info`: title, type (direct/group/supergroup/channel), member count, description, whether it is a forum, and the pinned message id.",
        "clawgram can list the topics of a forum supergroup via `thread-list`: id, title, last message, and whether a topic is closed, hidden or pinned.",
        "clawgram can fetch the attachment on any message inside its read scope via `download-file`: images come back described, voice notes transcribed, and either can be returned as a file path for reuse.",
        "clawgram can list the group chats the account belongs to via `channel-list`, when the account sets discoverChats. Metadata only, no direct chats — it answers \"where am I\", not \"what was said\".",
        "clawgram can manage chats where the account's manageChats config allows it: create supergroups, add and remove members, promote and demote admins, transfer ownership, and export invite links.",
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
          ...resolveAccountScopes(cfg, accountId),
          readChats: readAccountReadChats(account),
          enabled: account?.enabled,
          accountId,
          proxy: resolveProxyConfig(account?.proxy),
          // Field-by-field construction means every new account setting has to
          // be listed here as well: 2.3.1 shipped replyParseMode read by the
          // client from a config object this function had already stripped it
          // from, so the setting validated, deployed and did nothing.
          replyParseMode: account?.replyParseMode,
          manageChats: readAccountManageChats(account),
          // Optional secret: absent must stay absent, not become "".
          twoFaPassword: account?.twoFaPassword === undefined || account?.twoFaPassword === null
            ? undefined
            : readSecretInput(account.twoFaPassword),
        };
      },
    },

    gateway: {
      startAccount: async (ctx: any) => {
        const { account, accountId, channelRuntime, cfg, log } = ctx;

        if (!channelRuntime) {
          throw new Error("clawgram: channelRuntime is required");
        }

        // An empty allowlist denies everyone (2.21.0). That is the right
        // default for a scope, but "the agent answers nobody" is indis-
        // tinguishable from "the channel is broken" in a log, so say it out
        // loud once per account start.
        if (account.allowFrom.length === 0) {
          log?.warn?.("clawgram allowFrom is empty: no direct message will be accepted", {
            accountId,
            hint: 'set allowFrom to ["*"] to accept everyone, or list the senders',
          });
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
        rememberOperatorIds(accountId, resolveAccountOperatorIds(cfg, accountId));
        // Область отправки — туда же и по той же причине: в `outbound.*`
        // конфига нет, а барьер нужен и на пути доставки ядра (A5-12).
        rememberSendScope(accountId, resolveAccountSendChats(cfg, accountId));
        warnAboutHandleAllowlistEntries(cfg, accountId);
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
        const eventHandler = async (event: unknown) => handleInboundEvent(event, {
          accountId, cfg, channelRuntime, client, gram, log, pairing,
          pluginRuntime, runtimes, selfId, selfLabel, selfUsername,
        });
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
          // Only names core already knows. An action outside
          // `CHANNEL_MESSAGE_ACTION_NAMES` cannot be called from the agent's
          // `message` tool at all — it is simultaneously "requires a target"
          // and "does not accept a target" — so advertising one is handing the
          // agent a trap. It cost a broken reply in a live chat on 2026-08-31:
          // the agent picked the descriptive `chatInfo`, got both halves of
          // the contradiction, and the turn ended in `✉️ Message failed`.
          //
          // The descriptive spellings (`topics`, `dialogs`, `chatInfo`,
          // `participants`, `joins`, `fetch-media`, the manage family) still
          // work in `handleAction`, so gateway RPC and existing skills keep
          // calling them — RPC does not consult this list. They are simply not
          // offered to the agent, which has no way to use them.
          //
          // `upload-file` is what core dispatches when an agent has an
          // attachment to deliver — a generated image is the common case.
          // Leaving it out does not degrade to a text send: the agent simply
          // never sees a way to send the file, announces it in words, and the
          // file stays on disk. That is exactly what happened on 2026-08-07.
          //
          // `kick` is core's name for `removeMember`; the rest of the manage
          // family has no core equivalent and stays gateway-only until it gets
          // one. `joins` likewise.
          actions: [
            "send", "read", "react", "upload-file",
            // Reading an attachment that is already in a chat. `read` reports
            // that a photo exists; this is what turns it into something the
            // agent can look at or pass on.
            "download-file",
            // Core's names for the chat-shaped reads — see CORE_ACTION_SYNONYMS.
            "thread-list", "channel-list", "channel-info", "member-info",
            // Chat management (2.12.0) — gated by the account's manageChats
            // scope; without it every one of these is refused.
            "channel-create", "addParticipant", "kick", "role-add", "role-remove",
          ],
          capabilities: [],
          mediaSourceParams: {
            "upload-file": [ "filePath", "path", "media" ],
          },
        };
      },

      // Core asks the channel which params name a destination when the action
      // is not one of its own. Without this, `chatId` is invisible to
      // `actionHasTarget` and the call is refused as targetless before it ever
      // reaches `handleAction`. The chat is named by `chatId` rather than
      // `target` because core reserves `target` for actions in its own
      // vocabulary and throws on it for everything else.
      //
      // This declaration alone does not rescue an action, and 2.19.1 read too
      // much into it. Core resolves the channel through
      // `getBootstrapChannelPlugin`, which only ever returns a *bundled*
      // channel; for a plugin channel the lookup misses and the declaration is
      // never consulted. Measured on the live server on 2026-08-30: `topics`
      // was refused for `target`, `chatId`, `groupId` and the prefixed form
      // alike even with `chatId` declared here. What actually carried
      // `fetch-media` through was its second name, `download-file` — see
      // CORE_ACTION_SYNONYMS. This stays because it costs nothing and is
      // correct the day core consults plugin channels too.
      messageActionTargetAliases: {
        "fetch-media": { aliases: [ "chatId" ] },
        "download-file": { aliases: [ "chatId" ] },
      } as any,

      extractToolSend: ({ args }: { args: Record<string, unknown> }) => extractToolSend(args, "sendMessage"),

      handleAction: async ({
        action,
        params,
        cfg,
        accountId,
        dryRun: dryRunFlag,
        toolContext,
        // Core scopes every action to the media roots the agent may read, and
        // bundled channels enforce them. This one used to take `filePath`
        // verbatim, so a path naming the secret store or the config holding
        // `sessionString` was uploaded like any attachment.
        mediaLocalRoots,
        mediaAccess,
      }: {
        action: string;
        params: Record<string, unknown>;
        cfg: any;
        accountId?: string | null;
        dryRun?: boolean;
        toolContext?: {
          currentChannelId?: string;
          currentMessageId?: string | number;
        };
        mediaLocalRoots?: readonly string[];
        mediaAccess?: { localRoots?: readonly string[] };
      }) => {
        const allowedMediaRoots = mediaLocalRoots ?? mediaAccess?.localRoots;
        // Core passes the flag beside `params`; callers write it inside.
        // Both count, because a rehearsal flag that is silently ignored puts
        // a real message in a real chat — twice, so far (2.13.1).
        const dryRun = resolveDryRun(dryRunFlag, params);
        // Every branch below compares the canonical name, so a spelling is
        // resolved once, here, and `ACTION_ALIASES` is the only place that
        // decides what a name means. An unknown name stays itself and falls
        // through to the unsupported-action error, as before.
        const canonical = canonicalAction(action);
        // `read` is what OpenClaw core dispatches (`openclaw message read`,
        // MCP `messages_read`); `list` resolves to it too.
        if (canonical === "read") {
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

        // The attachment on a message that is already in a chat.
        //
        // `read` says a photo exists; it does not fetch it, and the inbound
        // path only ever reads what arrives while the agent is being addressed.
        // Everything else — a screenshot posted an hour ago, a diagram in a
        // chat the agent reads but was not tagged in — was visible to the
        // channel and unreachable to the agent. Same `readChats` scope as
        // history: this must not become a way to pull bytes out of a chat the
        // account was never allowed to read.
        if (canonical === "fetch-media") {
          const fetchParams = parseFetchMediaParams(params);
          const fetchAccountId = resolveRuntimeAccountId(cfg, accountId);
          if (!fetchAccountId) {
            throw new Error("clawgram: no configured account found");
          }

          if (!isChatReadable(fetchParams.target, resolveAccountReadChats(cfg, fetchAccountId))) {
            actionLog.warn("clawgram fetch-media refused: chat outside read scope", {
              accountId: fetchAccountId,
              target: fetchParams.target,
            });
            throw new Error(`clawgram: not-allowed-chat ${fetchParams.target}`);
          }

          const fetchGram = runtimes.get(fetchAccountId);
          if (!fetchGram) {
            throw new Error(`clawgram: runtime not found for account ${fetchAccountId}`);
          }

          // Fetching is a read: a dry run answers for real, the same way `read`
          // does. Nothing leaves the machine — the file lands in a temp
          // directory this channel prunes — so a rehearsal that reported
          // "would fetch" would only teach the agent to ask twice.
          const found = await fetchGram.getMessageById(fetchParams.target, fetchParams.messageId);
          const fetchChatId = found.chatId ?? fetchParams.target;
          if (!found.message) {
            actionLog.info("clawgram fetch-media found no message", {
              accountId: fetchAccountId,
              chatId: fetchChatId,
              messageId: fetchParams.messageId,
            });
            return jsonResult({
              ok: false,
              accountId: fetchAccountId,
              chatId: fetchChatId,
              messageId: String(fetchParams.messageId),
              error: "message-not-found",
            });
          }

          // `read` throws the file away, so it gets a directory of its own —
          // the shared directory is keyed by chat and message, and deleting
          // that path would pull the file out from under an earlier `both`
          // fetch of the same message that handed the caller a path.
          // Не общий /tmp: там файлы видит каждый локальный пользователь, а на
          // этом хосте живёт ещё и раннер деплоя. Каталог состояния OpenClaw
          // принадлежит агенту; если он не задан, остаётся /tmp — но права
          // 0700/0600 ставятся в любом случае (A5-13).
          // Каталог состояния принадлежит агенту; при явно заданном
          // OPENCLAW_STATE_DIR вложения не покидают его.
          const mediaRoot = process.env.OPENCLAW_STATE_DIR?.trim()
            ? path.join(resolveStateDir(), "tmp")
            : os.tmpdir();
          const sharedFetchDir = path.join(mediaRoot, "clawgram-fetched");
          let fetchDir = sharedFetchDir;
          if (fetchParams.mode === "read") {
            const { mkdtemp, mkdir } = await import("node:fs/promises");
            await mkdir(mediaRoot, { recursive: true, mode: 0o700 });
            fetchDir = await mkdtemp(path.join(mediaRoot, "clawgram-media-"));
          } else {
            await pruneFetchedMedia(sharedFetchDir, FETCHED_MEDIA_TTL_MS, Date.now());
          }

          const downloaded = await downloadMessageMediaToFile({
            client: fetchGram.getClient() as any,
            message: found.message,
            maxBytes: INBOUND_MEDIA_MAX_BYTES,
            dir: fetchDir,
            fileNameFor: ({ media, extension }) => fetchedMediaFileName({
              chatId: fetchChatId,
              messageId: fetchParams.messageId,
              extension,
              fileName: media.fileName,
            }),
          });

          if (!downloaded) {
            // Three different nothings, and the agent has to be able to tell
            // them apart: a message with no attachment, an attachment this
            // channel does not read (a video, a spreadsheet), and one too
            // large to be worth the transfer. Saying "could not fetch" to all
            // three is how "she ignored the picture" starts.
            const described = describeMedia((found.message as any)?.media);
            const tooLarge = typeof described?.size === "number" && described.size > INBOUND_MEDIA_MAX_BYTES;
            const error = !described
              ? "no-media"
              : tooLarge
                ? "media-too-large"
                : "unsupported-media";

            actionLog.info("clawgram fetch-media returned nothing", {
              accountId: fetchAccountId,
              chatId: fetchChatId,
              messageId: fetchParams.messageId,
              kind: described?.kind ?? null,
              error,
            });

            return jsonResult({
              ok: false,
              accountId: fetchAccountId,
              chatId: fetchChatId,
              messageId: String(fetchParams.messageId),
              media: described ?? null,
              error,
            });
          }

          let read: string | undefined;
          let readError: string | undefined;
          if (fetchParams.mode !== "file") {
            try {
              read = await understandAttachmentFile({
                runtime: pluginRuntime,
                cfg,
                filePath: downloaded.path,
                mimeType: downloaded.mimeType,
                understanding: downloaded.understanding,
              });
              if (!read) {
                readError = "read-empty";
              }
            } catch (err) {
              // The bytes are already here. A failed reading is worth
              // reporting, but it does not undo a successful fetch: the file
              // still exists and can still be forwarded.
              readError = String(err);
            }
          }

          // `read` mode is the inbound contract — the words, not the file — so
          // the bytes go away with the answer. Any other mode keeps them:
          // that is the whole point of asking for a path.
          if (fetchParams.mode === "read") {
            try {
              const { rm } = await import("node:fs/promises");
              await rm(fetchDir, { recursive: true, force: true });
            } catch {
              // A file left behind is pruned within a day; failing the call
              // over it would throw away a reading that already succeeded.
            }
          }

          actionLog.info("clawgram fetch-media completed", {
            accountId: fetchAccountId,
            chatId: fetchChatId,
            messageId: fetchParams.messageId,
            mode: fetchParams.mode,
            kind: downloaded.media.kind,
            understanding: downloaded.understanding,
            characters: read?.length ?? 0,
            readError: readError ?? null,
          });

          return jsonResult({
            ok: true,
            accountId: fetchAccountId,
            chatId: fetchChatId,
            messageId: String(fetchParams.messageId),
            mode: fetchParams.mode,
            media: downloaded.media,
            understanding: downloaded.understanding,
            filePath: fetchParams.mode === "read" ? undefined : downloaded.path,
            text: read,
            readError,
          });
        }

        /**
         * The scaffold every chat-shaped read shares.
         *
         * `participants`, `topics`, `dialogs`, `joins` and `chatInfo` each
         * spelled out the same sequence: parse, resolve the account, check a
         * scope, fetch the runtime, call it, log counts, answer. Roughly
         * forty lines apiece, differing in four places — which is how a new
         * action came to cost sixty lines of scaffold and how the two gates
         * drifted apart (finding A6-11).
         *
         * The gate follows from the shape rather than being restated: an
         * action that names a chat is gated by `readChats`, `dialogs` has its
         * own discovery gate precisely because its point is to find chats
         * that are not in scope yet, and `joins` has none — the journal only
         * ever holds chats this account was put into.
         *
         * The runtime is a getter, not a value: `joins` reads a file and must
         * not fail merely because no runtime is connected.
         */
        const runRead = async <P, R>(spec: {
          name: string;
          parse: () => P;
          /** The chat being read; absent means the action is not chat-scoped. */
          target?: (parsed: P) => string;
          /** Only `dialogs`: gated by discovery instead of by read scope. */
          discovery?: boolean;
          run: (ctx: {
            parsed: P;
            accountId: string;
            gram: () => ReturnType<typeof requireRuntimeFor>;
          }) => Promise<R>;
          after: (parsed: P, result: R) => Record<string, unknown>;
          result: (parsed: P, result: R) => Record<string, unknown>;
        }) => {
          const parsed = spec.parse();
          const readAccountId = resolveRuntimeAccountId(cfg, accountId);
          if (!readAccountId) {
            throw new Error("clawgram: no configured account found");
          }

          const target = spec.target?.(parsed);
          if (target !== undefined) {
            if (!isChatReadable(target, resolveAccountReadChats(cfg, readAccountId))) {
              actionLog.warn(`clawgram ${spec.name} refused: chat outside read scope`, {
                accountId: readAccountId,
                target,
              });
              throw new Error(`clawgram: not-allowed-chat ${target}`);
            }
          } else if (spec.discovery) {
            if (!isChatDiscoveryEnabled(resolveAccountDiscoverChats(cfg, readAccountId))) {
              actionLog.warn(`clawgram ${spec.name} refused: chat-discovery is not enabled`, {
                accountId: readAccountId,
              });
              throw new Error("clawgram: chat-discovery is not enabled");
            }
          }

          const gram = () => requireRuntimeFor(readAccountId);
          const result = await spec.run({ parsed, accountId: readAccountId, gram });

          actionLog.info(`clawgram handleAction ${spec.name} completed`, {
            accountId: readAccountId,
            ...spec.after(parsed, result),
          });

          return jsonResult({ ok: true, accountId: readAccountId, ...spec.result(parsed, result) });
        };

        // Membership is a read, so the same `readChats` scope that gates history
        // gates it too: this cannot become a way to enumerate chats the account
        // was never allowed to read.
        if (canonical === "participants") {
          return await runRead({
            name: "participants",
            parse: () => parseListParticipantsParams(params),
            target: (p) => p.target,
            run: ({ parsed, gram }) => gram().listParticipants(parsed),
            // Counts only. Member ids are personal data and have no business in
            // a log that is read while debugging something else.
            after: (p, m) => ({
              target: p.target,
              limit: p.limit,
              returned: m.participants.length,
              truncated: m.truncated,
            }),
            result: (p, m) => ({
              chatId: m.chatId ?? p.target,
              count: m.participants.length,
              truncated: m.truncated,
              participants: m.participants,
            }),
          });
        }

        // Topic names. A forum chat is addressed by topic id, and until now an
        // id could only be lifted off an inbound message — so a topic nobody had
        // written in yet was unreachable, and one named in words was unfindable.
        // Titles say what a chat is working on, so the read scope gates them.
        if (canonical === "topics") {
          return await runRead({
            name: "topics",
            parse: () => parseTopicsParams(params),
            target: (p) => p.target,
            run: ({ parsed, gram }) => gram().listTopics(parsed),
            after: (p, f) => ({
              target: p.target,
              limit: p.limit,
              returned: f.topics.length,
              truncated: f.truncated,
            }),
            result: (p, f) => ({
              chatId: f.chatId ?? p.target,
              count: f.topics.length,
              truncated: f.truncated,
              topics: f.topics,
            }),
          });
        }

        // Which chats this account is in. Not gated by `readChats` — the whole
        // point is to find chats that are not in it yet — so it has a gate of
        // its own, is metadata only, and never reports direct chats.
        if (canonical === "dialogs") {
          return await runRead({
            name: "dialogs",
            parse: () => parseDialogsParams(params),
            discovery: true,
            run: ({ parsed, gram }) => gram().listDialogs(parsed),
            // Counts only: which chats a person's account sits in is exactly
            // the kind of thing that should not be sitting in a log.
            after: (p, f) => ({ limit: p.limit, returned: f.dialogs.length, truncated: f.truncated }),
            result: (_p, f) => ({ count: f.dialogs.length, truncated: f.truncated, dialogs: f.dialogs }),
          });
        }

        // Where this account was recently added, and by whom. Reading the journal
        // has no scope check of its own: it only ever contains chats this account
        // was put into, which is exactly what the caller is allowed to learn.
        if (canonical === "joins") {
          return await runRead({
            name: "joins",
            parse: () => parseJoinsParams(params),
            // No runtime: this reads a file, and must answer with none connected.
            run: async ({ parsed, accountId: joinsAccountId }) => selectJoinRecords(
              readJoinRecords(resolveJoinsJournalPath(
                cfg?.channels?.[ "clawgram" ]?.accounts?.[ joinsAccountId ],
                joinsAccountId,
              )),
              parsed,
            ),
            after: (p, selected) => ({
              since: p.since ?? null,
              limit: p.limit,
              returned: selected.length,
            }),
            result: (_p, selected) => ({ count: selected.length, joins: selected }),
          });
        }

        // Describing a chat is a read, so the same `readChats` scope that gates
        // history gates it too — this must not become a way to learn the title
        // and size of a chat the account was never allowed to read.
        if (canonical === "chatInfo") {
          return await runRead({
            name: "chatInfo",
            parse: () => parseChatInfoParams(params, toolContext),
            target: (p) => p.target,
            run: async ({ parsed, gram }) => {
              const { entity, full } = await gram().getChatInfo(parsed.target);
              return describeChat(entity, full);
            },
            // Type and size only. The title of a private chat is as personal as
            // its contents and has no business in a debugging log.
            after: (_p, info) => ({
              type: info.type,
              memberCount: info.memberCount ?? null,
              isForum: info.isForum ?? null,
            }),
            result: (p, info) => ({ chat: { ...info, chatId: info.chatId ?? p.target } }),
          });
        }

        // A reaction is an outbound act on someone else's message, so it is
        // gated like sending rather than like reading — and it respects
        // `dryRun`, which reading does not need to.
        if (canonical === "react") {
          const reactionParams = parseReactionParams(params, toolContext);
          const reactionAccountId = resolveRuntimeAccountId(cfg, accountId);
          if (!reactionAccountId) {
            throw new Error("clawgram: no configured account found");
          }

          // Реакция — видимое действие от имени владельца в чужом чате, и
          // адресуется она так же, как сообщение: та же область (A5-12).
          if (!isChatSendable(reactionParams.target, resolveAccountSendChats(cfg, reactionAccountId))) {
            refuseOutboundOutsideScope("react", reactionAccountId, String(reactionParams.target));
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

        // ---- Chat management (2.12.0) ----
        //
        // Assembling a chat rather than speaking in it: create a supergroup,
        // add and remove people, appoint admins, hand the chat over, issue an
        // invite link. All of it is possible only because this is a personal
        // MTProto account — a bot could do almost none of this.
        //
        // Every branch is gated by the account's `manageChats` scope, which is
        // opt-in (absent = deny, see manage.ts) — these are the first actions
        // that change a chat rather than write into it. Parsing runs before
        // the gate so a malformed call fails on its own shape, and `dryRun`
        // returns after the gate so a dry run exercises the same refusals a
        // real call would hit. People's ids stay out of the logs throughout;
        // the JSON result carries them to the caller, the journal does not.
        const manageAction = MANAGE_ACTIONS.has(canonical) ? canonical : undefined;
        if (manageAction) {
          const manageAccountId = resolveRuntimeAccountId(cfg, accountId);
          if (!manageAccountId) {
            throw new Error("clawgram: no configured account found");
          }
          const manageScope = resolveAccountManageChats(cfg, manageAccountId);
          const requireRuntime = () => requireRuntimeFor(manageAccountId);

          /**
           * The scaffold every management action shares.
           *
           * Six actions used to spell it out one after another: resolve the
           * account, check the scope, log, answer a dry run, call the
           * runtime, log again, build the result. A change to any of those —
           * the dry-run contract, say — was a six-place edit in the plugin's
           * largest file, and the one deliberate exception (createGroup does
           * not check a chat scope, because the chat does not exist yet) was
           * invisible among the copies (finding A12-06).
           *
           * The differences stay written at each call site: what to parse,
           * what to log, what to run, what to answer. Only the scaffold moved.
           */
          const runManage = async <P, R>(spec: {
            /** Log name; promote and demote deliberately share `setAdmin`. */
            name: string;
            parse: () => P;
            /** The chat this touches, or nothing when it does not exist yet. */
            target: (parsed: P) => string | undefined;
            before: (parsed: P) => Record<string, unknown>;
            /** Checked after the gate, before any call. */
            precondition?: (gram: ReturnType<typeof requireRuntime>) => void;
            run: (gram: ReturnType<typeof requireRuntime>, parsed: P) => Promise<R>;
            after: (parsed: P, result: R) => Record<string, unknown>;
            result: (parsed: P, result: R) => Record<string, unknown>;
          }) => {
            const parsed = spec.parse();
            const target = spec.target(parsed);

            if (target === undefined) {
              // Nothing to check a scope against yet, so the gate is coarser:
              // management must be enabled at all for this account.
              if (!isManagementEnabled(manageScope)) {
                actionLog.warn(`clawgram ${spec.name} refused: management is not enabled`, {
                  accountId: manageAccountId,
                });
                throw new Error(
                  "clawgram: chat management is not enabled for this account — "
                  + `set channels.clawgram.accounts.${manageAccountId}.manageChats`,
                );
              }
            } else if (!isChatManageable(target, manageScope)) {
              actionLog.warn("clawgram management refused: chat outside manage scope", {
                accountId: manageAccountId,
                action: manageAction,
                target,
              });
              throw new Error(`clawgram: not-managed-chat ${target}`);
            }

            actionLog.info(`clawgram handleAction ${spec.name}`, {
              accountId: manageAccountId,
              dryRun: dryRun === true,
              ...spec.before(parsed),
            });

            if (dryRun === true) {
              return jsonResult({
                ok: true,
                dryRun: true,
                accountId: manageAccountId,
                ...(target === undefined ? {} : { chatId: target }),
              });
            }

            const gram = requireRuntime();
            spec.precondition?.(gram);
            const result = await spec.run(gram, parsed);

            actionLog.info(`clawgram handleAction ${spec.name} completed`, {
              accountId: manageAccountId,
              ...spec.after(parsed, result),
            });

            return jsonResult({ ok: true, accountId: manageAccountId, ...spec.result(parsed, result) });
          };

          if (manageAction === "createGroup") {
            return await runManage({
              name: "createGroup",
              parse: () => parseCreateGroupParams(params),
              // A group being created is not in any scope yet.
              target: () => undefined,
              before: (p) => ({ users: p.users.length, hasAbout: Boolean(p.about) }),
              run: (gram, p) => gram.createGroup(p),
              after: (_p, created) => ({ chatId: created.chatId ?? null, missing: created.missing.length }),
              result: (_p, created) => ({ chatId: created.chatId, missing: created.missing }),
            });
          }

          if (manageAction === "addMembers") {
            return await runManage({
              name: "addMembers",
              parse: () => parseAddMembersParams(params, toolContext),
              target: (p) => p.target,
              before: (p) => ({ target: p.target, users: p.users.length }),
              run: (gram, p) => gram.addChatMembers(p),
              after: (p, added) => ({
                target: p.target,
                requested: p.users.length,
                missing: added.missing.length,
              }),
              result: (p, added) => ({
                chatId: added.chatId ?? p.target,
                requested: p.users.length,
                // Telegram refuses silently-restricted invites per user; the
                // caller gets the ids so it can hand them an invite link.
                missing: added.missing,
              }),
            });
          }

          if (manageAction === "removeMember") {
            return await runManage({
              name: "removeMember",
              parse: () => parseRemoveMemberParams(params, toolContext),
              target: (p) => p.target,
              before: (p) => ({ target: p.target, ban: p.ban }),
              run: (gram, p) => gram.removeChatMember(p),
              after: (p) => ({ target: p.target, ban: p.ban }),
              result: (p) => ({ chatId: p.target, user: p.user, banned: p.ban }),
            });
          }

          if (manageAction === "promoteAdmin" || manageAction === "demoteAdmin") {
            const promote = manageAction === "promoteAdmin";
            return await runManage({
              // Both spellings log as `setAdmin`, as they always have.
              name: "setAdmin",
              parse: () => (promote
                ? parsePromoteAdminParams(params, toolContext)
                : parseDemoteAdminParams(params, toolContext)),
              target: (p) => p.target,
              before: (p) => ({ target: p.target, isAdmin: p.isAdmin, hasRank: Boolean(p.rank) }),
              run: (gram, p) => gram.setChatAdmin(p),
              after: (p) => ({ target: p.target, isAdmin: p.isAdmin }),
              result: (p) => ({
                chatId: p.target,
                user: p.user,
                isAdmin: p.isAdmin,
                ...(p.rank ? { rank: p.rank } : {}),
              }),
            });
          }

          if (manageAction === "transferOwnership") {
            return await runManage({
              name: "transferOwnership",
              parse: () => parseTransferOwnershipParams(params, toolContext),
              target: (p) => p.target,
              before: (p) => ({ target: p.target }),
              // The password stays inside the runtime: it is read from the
              // account config at start-up and never travels through dispatch
              // arguments, which are one log call away from the journal.
              precondition: (gram) => {
                if (!gram.twoFaPassword) {
                  throw new Error(
                    "clawgram: ownership transfer requires twoFaPassword in the account config "
                    + "(the account's Telegram 2FA password, as a literal or a SecretRef)",
                  );
                }
              },
              run: (gram, p) => gram.transferChatOwnership(p),
              after: (p) => ({ target: p.target }),
              result: (p) => ({ chatId: p.target, newOwner: p.user }),
            });
          }

          // inviteLink — the only management action left.
          return await runManage({
            name: "inviteLink",
            parse: () => parseInviteLinkParams(params, toolContext),
            target: (p) => p.target,
            before: (p) => ({
              target: p.target,
              hasExpiry: p.expireDate !== undefined,
              usageLimit: p.usageLimit ?? null,
              requestNeeded: p.requestNeeded,
            }),
            run: (gram, p) => gram.exportChatInviteLink(p),
            after: (p, exported) => ({ target: p.target, hasLink: Boolean(exported.link) }),
            result: (p, exported) => ({ chatId: p.target, link: exported.link }),
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
        if (canonical === "upload-file" || (canonical === "send" && attachedFile)) {
          const rawUploadTo = resolveActionTarget(params, toolContext);
          const uploadTo = normalizeOutboundTarget(rawUploadTo);
          const uploadAccountId = resolveRuntimeAccountId(cfg, accountId);
          if (!uploadAccountId) {
            throw new Error("clawgram: no configured account found");
          }

          // Та же граница, что у `send`: файл наружу — такое же исходящее.
          if (!isChatSendable(uploadTo, resolveAccountSendChats(cfg, uploadAccountId))) {
            refuseOutboundOutsideScope("upload-file", uploadAccountId, uploadTo);
          }

          const file = attachedFile;
          if (!file) {
            throw new Error("clawgram: upload-file requires filePath, path, media, or mediaUrl");
          }

          // Before anything else about the message is considered: an
          // out-of-scope path is refused, not sent and then regretted.
          assertLocalMediaWithinRoots(file, allowedMediaRoots);

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
            // Same resolution as the text `send`: per-call value wins, an
            // omitted one inherits the account format (2.15.0). A caption is
            // the same prose as a message and renders identically.
            parseMode: resolveOutboundParseMode(params, cfg, uploadAccountId),
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
        // Omitting parseMode inherits the account's configured mode rather
        // than falling back to plain text (2.13.0): an account set to `html`
        // used to render replies as HTML and these sends as raw markup.
        const parseMode = resolveOutboundParseMode(
          params as Record<string, unknown> | undefined,
          cfg,
          resolveConfiguredAccountId(cfg, accountId) ?? accountId ?? "default",
        );

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

        // Проверка ПОСЛЕ резолва аккаунта и ДО любой доставки: область задаётся
        // на аккаунт, а отказ должен случиться раньше, чем цель разрешена в
        // Telegram-сущность — resolve сам по себе виден собеседнику (A5-12).
        if (!isChatSendable(to, resolveAccountSendChats(cfg, resolvedAccountId))) {
          refuseOutboundOutsideScope("send", resolvedAccountId, to);
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

          // A dry run reports the suppression instead of impersonating it: the
          // caller asked what would happen, and what would happen is nothing.
          return jsonResult({
            ok: true,
            ...(dryRun ? { dryRun: true } : {}),
            suppressedDuplicate: true,
            to,
            accountId: resolvedAccountId,
          });
        }

        // Whom to greet is decided by the message this turn is answering, not
        // by whoever spoke last. An agent replying to a request rarely passes
        // `replyToId`, and until 2026-08-10 that fell through to the most
        // recent sender: in an interleaved chat the owner's report went out
        // addressed to a colleague who had asked something else entirely.
        // A dry run peeks: consuming the address here left the real send with
        // no greeting, so a rehearsal silently changed the message that went
        // out afterwards.
        const groupReplyAddress = (dryRun ? peekGroupReplyAddress : consumeGroupReplyAddress)({
          accountId: resolvedAccountId,
          chatId: to,
          replyToId: replyToId ?? currentMessageId,
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

        // The turn has now spoken for itself. Recorded for every send into the
        // chat this turn came from — with or without an explicit replyToId —
        // so that core delivering the turn's final text a few seconds later
        // can be recognised as an echo of this same answer.
        if (currentMessageId !== null && currentMessageId !== undefined) {
          rememberTurnSend({
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

    outbound: createOutbound(runtimes),
  };
};
