import { buildChannelOutboundSessionRoute, createSubsystemLogger } from "openclaw/plugin-sdk/core";
import path from "node:path";

/**
 * How long a file fetched by `fetch-media` stays on disk.
 *
 * Long enough for the turn that asked for it and the next one — forwarding a
 * screenshot happens minutes after reading it, not days — and short enough
 * that a chat full of images does not silently become a copy of itself in the
 * temp directory.
 */
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
import { waitUntilAbort } from "openclaw/plugin-sdk/channel-runtime";
import { extractToolSend } from "openclaw/plugin-sdk/tool-send";
import type { ChannelCapabilities } from "openclaw/plugin-sdk";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import { NewMessage, Raw } from "telegram/events";
import { GramJsClientManager } from "./gramjs-client";
import { forgetAccount, rememberAccount, requireRuntime } from "./account-registry";
import { appendJoinRecord, parseJoinEvent, resolveJoinsJournalPath } from "./joins";
import { resolveClawgramGroupToolPolicy } from "./group-tool-policy";
import { applyAccountSecrets, collectAccountSecretRefs, readSecretInput } from "./secret-refs";
import { resolveSecretRefValues } from "openclaw/plugin-sdk/secret-ref-runtime";
import type { SecretRef } from "openclaw/plugin-sdk/secret-ref-runtime";
import type { PluginConfig, RuntimeMap } from "./types";
import {
  normalizeOutboundTarget,
  resolveConfiguredAccountId,
  inferOutboundTargetKind,
  routeKindFromChatType,
  buildScopedGroupPeerId,
  resolveAccountScopes,
  resolveActiveUsername,
  toDisplayName,
  resolveDryRun,
} from './helpers';
import { resolveProxyConfig } from './proxy-config';
import { CHANNEL_ID } from './constants';
import { CORE_ACTION_SYNONYMS, canonicalAction } from "./actions";
import type { ActionContext } from "./action-context";
import { handleReadAction } from "./actions-read";
import { handleManageAction } from "./actions-manage";
import { handleSendAction } from "./actions-send";
import {
  readAccountManageChats,
  readAccountReadChats,
  resolveAccountOperatorIds,
  resolveAccountSendChats,
} from "./account-scopes";

// Config readers moved to ./account-scopes with the action branches; tests
// and system-notice.test.ts know this one by this file.
export { resolveAccountOperatorIds };
import { createOutbound } from "./outbound";
import { handleInboundEvent } from "./inbound-pipeline";

// Словарь имён живёт в ./actions. Реэкспорт — ради вызывающих снаружи:
// тесты и другие модули знают его по этому файлу с 2.19.4.
export { CORE_ACTION_SYNONYMS, canonicalAction };

const actionLog = createSubsystemLogger("channels/clawgram");

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

  /** The connected runtime for an account, or a refusal naming it (A6-11, D2-11). */
  const requireRuntimeFor = (id: string) => requireRuntime(runtimes, id);

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
        // Что `outbound.*` должен знать об аккаунте без конфига: область
        // отправки (A5-12) и операторы (A5-11). Одна запись, снимается при
        // остановке аккаунта (D2-11).
        rememberAccount(accountId, {
          sendChats: resolveAccountSendChats(cfg, accountId),
          operatorIds: resolveAccountOperatorIds(cfg, accountId),
        });
        warnAboutHandleAllowlistEntries(cfg, accountId);

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
          accountId, cfg, channelRuntime, client, gram, log,
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
          forgetAccount(accountId);

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
        mediaReadFile,
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
        mediaReadFile?: (filePath: string) => Promise<Buffer>;
        mediaAccess?: { localRoots?: readonly string[]; readFile?: (filePath: string) => Promise<Buffer> };
      }) => {
        const allowedMediaRoots = mediaLocalRoots ?? mediaAccess?.localRoots;
        const readMedia = mediaReadFile ?? mediaAccess?.readFile;
        // Core passes the flag beside `params`; callers write it inside.
        // Both count, because a rehearsal flag that is silently ignored puts
        // a real message in a real chat — twice, so far (2.13.1).
        const dryRun = resolveDryRun(dryRunFlag, params);
        // Every branch below compares the canonical name, so a spelling is
        // resolved once, here, and `ACTION_ALIASES` is the only place that
        // decides what a name means. An unknown name stays itself and falls
        // through to the unsupported-action error, as before.
        const canonical = canonicalAction(action);
        const context: ActionContext = {
          action, canonical, params, cfg, accountId, dryRun, toolContext,
          allowedMediaRoots, readMedia, pluginRuntime,
          resolveRuntimeAccountId, requireRuntimeFor,
        };
        // Reads first, then management, then the outbound actions — which end
        // with `send` and refuse whatever nobody claimed. Each module answers
        // `undefined` for an action that is not its own (B5-13, part 3).
        return (await handleReadAction(context))
          ?? (await handleManageAction(context))
          ?? (await handleSendAction(context));
      },
    },

    outbound: createOutbound(runtimes),
  };
};
