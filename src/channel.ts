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
 * How long a file fetched by `fetch-media` stays on disk.
 *
 * Long enough for the turn that asked for it and the next one — forwarding a
 * screenshot happens minutes after reading it, not days — and short enough
 * that a chat full of images does not silently become a copy of itself in the
 * temp directory.
 */
const FETCHED_MEDIA_TTL_MS = 24 * 60 * 60 * 1000;

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
  downloadInboundMediaToTempFile,
  downloadMessageMediaToFile,
  pruneFetchedMedia,
} from "./media";
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
import { shouldSuppressGroupSystemNotice } from "./system-notice";
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
 * Model ref for the emoji pick, when the account names one.
 *
 * Picking one emoji out of a fixed list of 68 is the cheapest judgement this
 * channel makes and the only model call it makes on its own; running it on the
 * agent's own head spends the expensive quota on a decision a small model
 * makes just as well.
 */
function readAccountReactionModel(cfg: any, accountId?: string | null): string | undefined {
  const resolvedAccountId = resolveConfiguredAccountId(cfg, accountId);
  if (!resolvedAccountId) {
    return undefined;
  }

  const raw = cfg?.channels?.[ CHANNEL_ID ]?.accounts?.[ resolvedAccountId ]?.reactionModel;
  return typeof raw === "string" && raw.trim() ? raw.trim() : undefined;
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
 * Management scope as configured. Handed to `isChatManageable` raw: unlike
 * `readChats`, an absent value already means "deny", so there is nothing to
 * tell apart here.
 */
/** Chat discovery as configured; absent means "deny", like management scope. */
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

/**
 * Core's own name for a clawgram action, and the only thing that makes the
 * action reachable from the agent's `message` tool.
 *
 * Core keys its target policy by `CHANNEL_MESSAGE_ACTION_NAMES`, and an action
 * outside that vocabulary is simultaneously "requires a target" and "does not
 * accept a target" — there is no call that satisfies both. Declaring `chatId`
 * through `messageActionTargetAliases` looks like the fix and is not: core
 * resolves the channel with `getBootstrapChannelPlugin`, which only knows
 * bundled channels, so a plugin channel's declaration is never read. Measured
 * on 2026-08-30 — `thread-list` reached `handleAction` and `topics` did not,
 * from the same caller, on the same chat.
 *
 * Every name on the right maps to core target mode `"none"` except
 * `channel-info`, which is `"channelId"`: the chat arrives in
 * `params.channelId`, a spelling no parser here read until 2.21.0 — so the
 * call fell through to the current chat and answered about the wrong one.
 * `readChatTargetParam` is the single list of accepted spellings now.
 */
export const CORE_ACTION_SYNONYMS: Record<string, string> = {
  "thread-list": "topics",
  "channel-list": "dialogs",
  "channel-info": "chatInfo",
  "member-info": "participants",
  "download-file": "fetch-media",
  // Chat management. `kick` was already accepted; the rest were advertised
  // under names core does not know and were therefore never callable from the
  // tool at all — 2.19.4 gives them core's nearest name. `transferOwnership`
  // and `inviteLink` have no counterpart in that vocabulary and stay
  // gateway-only, as does `joins`.
  "channel-create": "createGroup",
  addParticipant: "addMembers",
  kick: "removeMember",
  "role-add": "promoteAdmin",
  "role-remove": "demoteAdmin",
};

/** Canonical management action for every accepted spelling. */
const MANAGE_ACTION_ALIASES: Record<string, string> = {
  // Core's spellings first — these are the only ones the agent's tool can
  // reach; see CORE_ACTION_SYNONYMS.
  "channel-create": "createGroup",
  addParticipant: "addMembers",
  "role-add": "promoteAdmin",
  "role-remove": "demoteAdmin",
  createGroup: "createGroup",
  createChat: "createGroup",
  "create-group": "createGroup",
  addMembers: "addMembers",
  addMember: "addMembers",
  "add-members": "addMembers",
  removeMember: "removeMember",
  removeMembers: "removeMember",
  "remove-member": "removeMember",
  kick: "removeMember",
  promoteAdmin: "promoteAdmin",
  promote: "promoteAdmin",
  "promote-admin": "promoteAdmin",
  setAdmin: "promoteAdmin",
  demoteAdmin: "demoteAdmin",
  demote: "demoteAdmin",
  "demote-admin": "demoteAdmin",
  transferOwnership: "transferOwnership",
  transferOwner: "transferOwnership",
  "transfer-ownership": "transferOwnership",
  inviteLink: "inviteLink",
  exportInviteLink: "inviteLink",
  "invite-link": "inviteLink",
};

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

/**
 * Turns a downloaded attachment into text.
 *
 * Shared by the inbound path and by `fetch-media`: the backend choice lives in
 * `runtime.mediaUnderstanding`, and both callers have to make exactly the same
 * call — an image read on arrival and the same image read on request must not
 * become two different readings because two call sites drifted.
 */
async function understandAttachmentFile(params: {
  runtime?: PluginRuntime;
  cfg: any;
  filePath: string;
  mimeType?: string;
  understanding: "transcript" | "description";
}): Promise<string | undefined> {
  const media = params.runtime?.mediaUnderstanding;
  if (!media) return undefined;

  const result = params.understanding === "transcript"
    ? await media.transcribeAudioFile({
      filePath: params.filePath,
      cfg: params.cfg,
      mime: params.mimeType,
    })
    : await media.describeImageFile({
      filePath: params.filePath,
      cfg: params.cfg,
      mime: params.mimeType,
      agentDir: resolveAgentDirForMedia(params.cfg),
    });

  const text = typeof result?.text === "string" ? result.text.trim() : "";
  return text || undefined;
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
    const read = await understandAttachmentFile({
      runtime: params.runtime,
      cfg: params.cfg,
      filePath: downloaded.path,
      mimeType: downloaded.mimeType,
      understanding: downloaded.understanding,
    });
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
        "Explicit targets may be @username, numeric Telegram user id, phone/contact resolvable by Telegram, group chat ids, or clawgram:<target>.",
        "For Telegram forum topics, send to the group chat id and pass the topic id separately as `threadId`.",
        "Use the `react` action to acknowledge a message with an emoji instead of sending a reply; pass an empty `emoji` (or `remove: true`) to take the reaction back.",
        "Use the `channel-info` action to learn what a chat is — title, type, member count, description, pinned message — instead of guessing from its id. Name the chat with `chatId` and do not pass `target`: core refuses it for this action, and the descriptive spelling `chatInfo` is not callable from this tool at all.",
        "Use the `thread-list` action to list a forum's topics by name (optional `query` narrows by title); that is where a `threadId` comes from when someone names a topic instead of quoting a message in it. Name the chat with `chatId` and do not pass `target` — core refuses it for this action. `topics` is the same call under a name core does not know, and is only reachable through the gateway RPC.",
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
          // Same resolver as `resolveAccount`, so the gate the inbound path
          // applies is the one the account was started with. These used to be
          // two independent reads of the raw config and could disagree.
          const { allowFrom: directAllowFrom, groups } = resolveAccountScopes(cfg, accountId);
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

      handleAction: async ({ action, params, cfg, accountId, dryRun: dryRunFlag, toolContext }: {
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
        // Core passes the flag beside `params`; callers write it inside.
        // Both count, because a rehearsal flag that is silently ignored puts
        // a real message in a real chat — twice, so far (2.13.1).
        const dryRun = resolveDryRun(dryRunFlag, params);
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

        // The attachment on a message that is already in a chat.
        //
        // `read` says a photo exists; it does not fetch it, and the inbound
        // path only ever reads what arrives while the agent is being addressed.
        // Everything else — a screenshot posted an hour ago, a diagram in a
        // chat the agent reads but was not tagged in — was visible to the
        // channel and unreachable to the agent. Same `readChats` scope as
        // history: this must not become a way to pull bytes out of a chat the
        // account was never allowed to read.
        if (
          action === "fetch-media" || action === "fetchMedia" ||
          action === "download-media" || action === "downloadMedia" ||
          action === "getMedia" || action === "download-file"
        ) {
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
          const sharedFetchDir = path.join(os.tmpdir(), "clawgram-fetched");
          let fetchDir = sharedFetchDir;
          if (fetchParams.mode === "read") {
            const { mkdtemp } = await import("node:fs/promises");
            fetchDir = await mkdtemp(path.join(os.tmpdir(), "clawgram-media-"));
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

        // Membership is a read, so the same `readChats` scope that gates history
        // gates it too: this cannot become a way to enumerate chats the account
        // was never allowed to read.
        if (action === "participants" || action === "members" || action === "member-info") {
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

        // Topic names. A forum chat is addressed by topic id, and until now an
        // id could only be lifted off an inbound message — so a topic nobody had
        // written in yet was unreachable, and one named in words was unfindable.
        // Titles say what a chat is working on, so the read scope gates them.
        if (action === "topics" || action === "forumTopics" || action === "thread-list") {
          const topicsParams = parseTopicsParams(params);
          const topicsAccountId = resolveRuntimeAccountId(cfg, accountId);
          if (!topicsAccountId) {
            throw new Error("clawgram: no configured account found");
          }

          if (!isChatReadable(topicsParams.target, resolveAccountReadChats(cfg, topicsAccountId))) {
            actionLog.warn("clawgram topics refused: chat outside read scope", {
              accountId: topicsAccountId,
              target: topicsParams.target,
            });
            throw new Error(`clawgram: not-allowed-chat ${topicsParams.target}`);
          }

          const topicsGram = runtimes.get(topicsAccountId);
          if (!topicsGram) {
            throw new Error(`clawgram: runtime not found for account ${topicsAccountId}`);
          }

          const forum = await topicsGram.listTopics(topicsParams);

          actionLog.info("clawgram handleAction topics completed", {
            accountId: topicsAccountId,
            target: topicsParams.target,
            limit: topicsParams.limit,
            returned: forum.topics.length,
            truncated: forum.truncated,
          });

          return jsonResult({
            ok: true,
            accountId: topicsAccountId,
            chatId: forum.chatId ?? topicsParams.target,
            count: forum.topics.length,
            truncated: forum.truncated,
            topics: forum.topics,
          });
        }

        // Which chats this account is in. Not gated by `readChats` — the whole
        // point is to find chats that are not in it yet — so it has a gate of
        // its own, is metadata only, and never reports direct chats.
        if (action === "dialogs" || action === "chats" || action === "channel-list") {
          const dialogsParams = parseDialogsParams(params);
          const dialogsAccountId = resolveRuntimeAccountId(cfg, accountId);
          if (!dialogsAccountId) {
            throw new Error("clawgram: no configured account found");
          }

          if (!isChatDiscoveryEnabled(resolveAccountDiscoverChats(cfg, dialogsAccountId))) {
            actionLog.warn("clawgram dialogs refused: chat-discovery is not enabled", {
              accountId: dialogsAccountId,
            });
            throw new Error("clawgram: chat-discovery is not enabled");
          }

          const dialogsGram = runtimes.get(dialogsAccountId);
          if (!dialogsGram) {
            throw new Error(`clawgram: runtime not found for account ${dialogsAccountId}`);
          }

          const found = await dialogsGram.listDialogs(dialogsParams);

          // Counts only: which chats a person's account sits in is exactly the
          // kind of thing that should not be sitting in a log.
          actionLog.info("clawgram handleAction dialogs completed", {
            accountId: dialogsAccountId,
            limit: dialogsParams.limit,
            returned: found.dialogs.length,
            truncated: found.truncated,
          });

          return jsonResult({
            ok: true,
            accountId: dialogsAccountId,
            count: found.dialogs.length,
            truncated: found.truncated,
            dialogs: found.dialogs,
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
          action === "chatInfo" || action === "getChatInfo" || action === "channel-info"
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
        const manageAction = MANAGE_ACTION_ALIASES[ action ];
        if (manageAction) {
          const manageAccountId = resolveRuntimeAccountId(cfg, accountId);
          if (!manageAccountId) {
            throw new Error("clawgram: no configured account found");
          }

          const manageScope = resolveAccountManageChats(cfg, manageAccountId);
          const requireManagedChat = (target: string) => {
            if (!isChatManageable(target, manageScope)) {
              actionLog.warn("clawgram management refused: chat outside manage scope", {
                accountId: manageAccountId,
                action: manageAction,
                target,
              });
              throw new Error(`clawgram: not-managed-chat ${target}`);
            }
          };
          const requireRuntime = () => {
            const gram = runtimes.get(manageAccountId);
            if (!gram) {
              throw new Error(`clawgram: runtime not found for account ${manageAccountId}`);
            }

            return gram;
          };

          if (manageAction === "createGroup") {
            const createParams = parseCreateGroupParams(params);
            // A group being created is not in any scope yet, so the gate is
            // coarser: management must be enabled at all for this account.
            if (!isManagementEnabled(manageScope)) {
              actionLog.warn("clawgram createGroup refused: management is not enabled", {
                accountId: manageAccountId,
              });
              throw new Error(
                "clawgram: chat management is not enabled for this account — "
                + `set channels.clawgram.accounts.${manageAccountId}.manageChats`,
              );
            }

            actionLog.info("clawgram handleAction createGroup", {
              accountId: manageAccountId,
              dryRun: dryRun === true,
              users: createParams.users.length,
              hasAbout: Boolean(createParams.about),
            });

            if (dryRun === true) {
              return jsonResult({ ok: true, dryRun: true, accountId: manageAccountId });
            }

            const created = await requireRuntime().createGroup(createParams);

            actionLog.info("clawgram handleAction createGroup completed", {
              accountId: manageAccountId,
              chatId: created.chatId ?? null,
              missing: created.missing.length,
            });

            return jsonResult({
              ok: true,
              accountId: manageAccountId,
              chatId: created.chatId,
              missing: created.missing,
            });
          }

          if (manageAction === "addMembers") {
            const addParams = parseAddMembersParams(params, toolContext);
            requireManagedChat(addParams.target);

            actionLog.info("clawgram handleAction addMembers", {
              accountId: manageAccountId,
              dryRun: dryRun === true,
              target: addParams.target,
              users: addParams.users.length,
            });

            if (dryRun === true) {
              return jsonResult({ ok: true, dryRun: true, accountId: manageAccountId, chatId: addParams.target });
            }

            const added = await requireRuntime().addChatMembers(addParams);

            actionLog.info("clawgram handleAction addMembers completed", {
              accountId: manageAccountId,
              target: addParams.target,
              requested: addParams.users.length,
              missing: added.missing.length,
            });

            return jsonResult({
              ok: true,
              accountId: manageAccountId,
              chatId: added.chatId ?? addParams.target,
              requested: addParams.users.length,
              // Telegram refuses silently-restricted invites per user; the
              // caller gets the ids so it can hand them an invite link.
              missing: added.missing,
            });
          }

          if (manageAction === "removeMember") {
            const removeParams = parseRemoveMemberParams(params, toolContext);
            requireManagedChat(removeParams.target);

            actionLog.info("clawgram handleAction removeMember", {
              accountId: manageAccountId,
              dryRun: dryRun === true,
              target: removeParams.target,
              ban: removeParams.ban,
            });

            if (dryRun === true) {
              return jsonResult({ ok: true, dryRun: true, accountId: manageAccountId, chatId: removeParams.target });
            }

            await requireRuntime().removeChatMember(removeParams);

            actionLog.info("clawgram handleAction removeMember completed", {
              accountId: manageAccountId,
              target: removeParams.target,
              ban: removeParams.ban,
            });

            return jsonResult({
              ok: true,
              accountId: manageAccountId,
              chatId: removeParams.target,
              user: removeParams.user,
              banned: removeParams.ban,
            });
          }

          if (manageAction === "promoteAdmin" || manageAction === "demoteAdmin") {
            const adminParams = manageAction === "promoteAdmin"
              ? parsePromoteAdminParams(params, toolContext)
              : parseDemoteAdminParams(params, toolContext);
            requireManagedChat(adminParams.target);

            actionLog.info("clawgram handleAction setAdmin", {
              accountId: manageAccountId,
              dryRun: dryRun === true,
              target: adminParams.target,
              isAdmin: adminParams.isAdmin,
              hasRank: Boolean(adminParams.rank),
            });

            if (dryRun === true) {
              return jsonResult({ ok: true, dryRun: true, accountId: manageAccountId, chatId: adminParams.target });
            }

            await requireRuntime().setChatAdmin(adminParams);

            actionLog.info("clawgram handleAction setAdmin completed", {
              accountId: manageAccountId,
              target: adminParams.target,
              isAdmin: adminParams.isAdmin,
            });

            return jsonResult({
              ok: true,
              accountId: manageAccountId,
              chatId: adminParams.target,
              user: adminParams.user,
              isAdmin: adminParams.isAdmin,
              ...(adminParams.rank ? { rank: adminParams.rank } : {}),
            });
          }

          if (manageAction === "transferOwnership") {
            const transferParams = parseTransferOwnershipParams(params, toolContext);
            requireManagedChat(transferParams.target);

            actionLog.info("clawgram handleAction transferOwnership", {
              accountId: manageAccountId,
              dryRun: dryRun === true,
              target: transferParams.target,
            });

            if (dryRun === true) {
              return jsonResult({ ok: true, dryRun: true, accountId: manageAccountId, chatId: transferParams.target });
            }

            const transferGram = requireRuntime();
            // The password stays inside the runtime: it is read from the
            // account config at start-up and never travels through dispatch
            // arguments, which are one log call away from the journal.
            if (!transferGram.twoFaPassword) {
              throw new Error(
                "clawgram: ownership transfer requires twoFaPassword in the account config "
                + "(the account's Telegram 2FA password, as a literal or a SecretRef)",
              );
            }

            await transferGram.transferChatOwnership(transferParams);

            actionLog.info("clawgram handleAction transferOwnership completed", {
              accountId: manageAccountId,
              target: transferParams.target,
            });

            return jsonResult({
              ok: true,
              accountId: manageAccountId,
              chatId: transferParams.target,
              newOwner: transferParams.user,
            });
          }

          // inviteLink — the only management action left.
          const inviteParams = parseInviteLinkParams(params, toolContext);
          requireManagedChat(inviteParams.target);

          actionLog.info("clawgram handleAction inviteLink", {
            accountId: manageAccountId,
            dryRun: dryRun === true,
            target: inviteParams.target,
            hasExpiry: inviteParams.expireDate !== undefined,
            usageLimit: inviteParams.usageLimit ?? null,
            requestNeeded: inviteParams.requestNeeded,
          });

          if (dryRun === true) {
            return jsonResult({ ok: true, dryRun: true, accountId: manageAccountId, chatId: inviteParams.target });
          }

          const exported = await requireRuntime().exportChatInviteLink(inviteParams);

          actionLog.info("clawgram handleAction inviteLink completed", {
            accountId: manageAccountId,
            target: inviteParams.target,
            hasLink: Boolean(exported.link),
          });

          return jsonResult({
            ok: true,
            accountId: manageAccountId,
            chatId: inviteParams.target,
            link: exported.link,
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

        // Core's operational chatter (tool-error warnings, fallback notices)
        // stays out of group chats: it is telemetry for the operator, not a
        // reply to the room, and it has already been seen carrying shell
        // commands with secret-store paths. DMs keep it. The text itself is
        // never logged — see system-notice.ts for why.
        const suppressedNotice = shouldSuppressGroupSystemNotice({
          targetKind: inferOutboundTargetKind(ctx.to),
          text: ctx.text,
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
    },
  };
};
