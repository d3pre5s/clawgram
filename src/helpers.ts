import { readFileSync } from "node:fs";
import path from "node:path";
import {
  stripChannelTargetPrefix,
  stripTargetKindPrefix,
  readStringParam,
} from "openclaw/plugin-sdk/core";
import {
  buildMentionRegexes,
  matchesMentionWithExplicit,
} from "openclaw/plugin-sdk/channel-inbound";
import { CHANNEL_ID } from './constants';

function resolveConfiguredAccountId(cfg: any, preferred?: string | null): string | undefined {
  if (preferred?.trim()) {
    return preferred.trim();
  }

  const accounts = cfg?.channels?.[ CHANNEL_ID ]?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return undefined;
  }

  return Object.keys(accounts).find((accountId) => accounts?.[ accountId ]?.enabled !== false);
}

function normalizeOutboundTarget(rawTarget: string): string {
  const withoutChannel = stripChannelTargetPrefix(rawTarget, CHANNEL_ID, "tguserbot", "telegram", "tg");
  return stripTargetKindPrefix(withoutChannel).trim();
}

function inferOutboundTargetKind(rawTarget: string, resolvedKind?: "user" | "group" | "channel"): "user" | "group" | "channel" | undefined {
  if (resolvedKind) {
    return resolvedKind;
  }

  const withoutChannel = stripChannelTargetPrefix(rawTarget, CHANNEL_ID, "tguserbot", "telegram", "tg").trim();
  const prefix = withoutChannel.match(/^(user|channel|group|conversation|room|dm):/i)?.[ 1 ]?.toLowerCase();
  if (prefix === "group" || prefix === "room" || prefix === "conversation") {
    return "group";
  }
  if (prefix === "channel") {
    return "channel";
  }
  if (prefix === "user" || prefix === "dm") {
    return "user";
  }

  const target = normalizeOutboundTarget(rawTarget);
  if (target.startsWith("-")) {
    return "group";
  }

  return undefined;
}

function routeKindFromChatType(chatType?: "direct" | "group" | "channel"): "direct" | "group" | "channel" {
  return chatType === "group" || chatType === "channel" ? chatType : "direct";
}

function buildConversationTarget(chatId: string): string {
  return `${CHANNEL_ID}:${chatId}`;
}

function buildScopedGroupPeerId(accountId: string | undefined, chatId: string): string {
  const scopedAccountId = (accountId ?? "default").trim() || "default";
  return `${scopedAccountId}:${chatId}`;
}

function stripReplyDirectiveTags(text: string): string {
  return text
    .replace(/\[\[\s*reply_to_current\s*\]\]/gi, " ")
    .replace(/\[\[\s*reply_to\s*:\s*[^\]\n]+\s*\]\]/gi, " ")
    .replace(/\[\[\s*audio_as_voice\s*\]\]/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function resolveTranscriptPathFromStoreEntry(input: {
  storePath: string;
  sessionKey: string;
  entry?: {
    sessionId?: string;
    sessionFile?: string;
  };
}): string | undefined {
  const sessionId = typeof input.entry?.sessionId === "string" && input.entry.sessionId.trim()
    ? input.entry.sessionId.trim()
    : input.sessionKey.trim();
  if (!sessionId) {
    return undefined;
  }

  const sessionsDir = path.dirname(path.resolve(input.storePath));
  const sessionFile = typeof input.entry?.sessionFile === "string" ? input.entry.sessionFile.trim() : "";
  const candidateFileName = sessionFile || `${sessionId}.jsonl`;

  try {
    return path.resolve(sessionsDir, candidateFileName);
  } catch {
    return undefined;
  }
}

/**
 * Salvages a reply that reached the transcript but not stdout.
 *
 * `notBeforeMs` is the start of the current dispatch. Only entries stamped at
 * or after it count: on a turn that aborted with zero output, the newest
 * assistant entry is by definition from an earlier turn, and re-sending it
 * addresses an old answer to a new question (the 2026-08-06 duplicates,
 * note 0054 in the control repo). An entry with no parseable timestamp cannot
 * prove it is fresh, so it does not count either.
 */
function readLatestAssistantFallbackFromTranscript(sessionKey: string, storePath?: string, notBeforeMs?: number): string | undefined {
  if (!storePath?.trim()) {
    return undefined;
  }

  try {
    const rawStore = readFileSync(storePath, "utf8");
    const store = JSON.parse(rawStore) as Record<string, { sessionId?: string; sessionFile?: string }>;
    const sessionFile = resolveTranscriptPathFromStoreEntry({
      storePath,
      sessionKey,
      entry: store?.[ sessionKey ],
    });
    if (!sessionFile) {
      return undefined;
    }

    const lines = readFileSync(sessionFile, "utf8")
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    for (let index = lines.length - 1; index >= 0; index -= 1) {
      try {
        const entry = JSON.parse(lines[ index ]) as {
          type?: string;
          timestamp?: string;
          message?: {
            role?: string;
            content?: Array<{ type?: string; text?: string }>;
          };
        };

        if (entry?.type !== "message" || entry?.message?.role !== "assistant" || !Array.isArray(entry.message.content)) {
          continue;
        }

        if (notBeforeMs !== undefined) {
          const stamped = typeof entry.timestamp === "string" ? Date.parse(entry.timestamp) : NaN;
          if (!Number.isFinite(stamped) || stamped < notBeforeMs) {
            // Entries are appended in order; everything below this one is
            // older still. Stop instead of walking further into the past.
            return undefined;
          }
        }

        const textPart = entry.message.content.find((part) => part?.type === "text" && typeof part.text === "string" && part.text.trim());
        if (!textPart?.text) {
          continue;
        }

        const cleaned = stripReplyDirectiveTags(textPart.text);
        if (cleaned) {
          return cleaned;
        }
      } catch {
        continue;
      }
    }
  } catch {
    return undefined;
  }

  return undefined;
}

function resolveActionTarget(params: Record<string, unknown>, toolContext?: {
  currentChannelId?: string;
}): string {
  const explicitTo = readStringParam(params, "to") ?? readStringParam(params, "target");
  if (explicitTo?.trim()) {
    return explicitTo.trim();
  }

  const contextTarget = toolContext?.currentChannelId?.trim();
  if (contextTarget) {
    return contextTarget;
  }

  throw new Error("clawgram: message target is required");
}

function resolveReplyToMessageIdForTarget(rawTarget: string, replyToId?: string | number | null): number | undefined {
  if (replyToId === null || replyToId === undefined || replyToId === "") {
    return undefined;
  }

  const targetKind = inferOutboundTargetKind(rawTarget);
  if (targetKind === "group" || targetKind === "channel") {
    return Number(replyToId);
  }

  return undefined;
}

/**
 * Разметка синтеза речи, которая не должна доехать до человека.
 *
 * Core вырезает `[[tts:...]]` из видимого текста сам, но только на штатном
 * пути ответа. Аварийный путь (`readLatestAssistantFallbackFromTranscript`)
 * читает сырой текст из стенограммы, поэтому 2026-08-08 в групповой чат
 * ушло `[[tts:text]]Привет, Вася!…[[/tts:text]]` как есть.
 *
 * Блок `[[tts:text]]…[[/tts:text]]` РАЗВОРАЧИВАЕТСЯ, а не удаляется: внутри
 * лежит то, что агент собирался сказать. Если синтез не состоялся, человек
 * должен получить эти слова текстом — деградация в читаемое, а не в мусор
 * и не в пустоту.
 */
const TTS_TEXT_BLOCK = /\[\[tts:text\]\]([\s\S]*?)\[\[\/tts:text\]\]/gi;
const TTS_DIRECTIVE = /\[\[\s*\/?\s*(?:tts:[^\]]*|audio_as_voice)\s*\]\]/gi;

function stripTtsDirectives(text: string): string {
  return text
    .replace(TTS_TEXT_BLOCK, (_match, spoken: string) => spoken)
    .replace(TTS_DIRECTIVE, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

/**
 * Whether an outbound file should become a Telegram voice message.
 *
 * Core emits `asVoice` and, on some paths, the older `audioAsVoice` — both
 * carry the same meaning, so both are read. Only a real `true` counts: a
 * string "true" or a stray truthy value must not silently turn a document
 * into a voice bubble.
 */
function readVoiceNoteFlag(params: Record<string, unknown>): boolean {
  return params?.asVoice === true || params?.audioAsVoice === true;
}

function readMessageText(params: Record<string, unknown>): string {
  const message = readStringParam(params, "message", { allowEmpty: true });
  if (typeof message === "string") {
    return message;
  }

  const text = readStringParam(params, "text", { allowEmpty: true });
  if (typeof text === "string") {
    return text;
  }

  return "";
}

function resolveAllowFrom(value: unknown): string[] {
  if (value === "*") {
    return [ "*" ];
  }

  if (typeof value === "string" || typeof value === "number") {
    const entry = String(value).trim();
    return entry ? [ entry ] : [ "*" ];
  }

  if (!Array.isArray(value)) {
    return [ "*" ];
  }

  const entries = value.map((entry) => String(entry).trim()).filter(Boolean);
  return entries.length > 0 ? entries : [ "*" ];
}

function resolveGroupPolicy(value: unknown): "open" | "mention" {
  return value === "open" ? "open" : "mention";
}

function resolveGroups(value: unknown): Record<string, {
  enabled: boolean;
  groupPolicy: "open" | "mention";
  allowFrom: string[];
}> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return {};
  }

  const entries = Object.entries(value as Record<string, unknown>);
  return Object.fromEntries(entries.map(([ groupId, rawConfig ]) => {
    const groupConfig = rawConfig && typeof rawConfig === "object" && !Array.isArray(rawConfig)
      ? rawConfig as Record<string, unknown>
      : {};

    return [
      String(groupId).trim(),
      {
        enabled: groupConfig.enabled !== false,
        groupPolicy: resolveGroupPolicy(groupConfig.groupPolicy),
        allowFrom: resolveAllowFrom(groupConfig.allowFrom),
      },
    ];
  }).filter(([ groupId ]) => Boolean(groupId)));
}

function resolveGroupConfig(groups: Record<string, {
  enabled: boolean;
  groupPolicy: "open" | "mention";
  allowFrom: string[];
}>, chatId: string): {
  enabled: boolean;
  groupPolicy: "open" | "mention";
  allowFrom: string[];
} | undefined {
  return groups[ chatId ] ?? groups[ "*" ];
}

function resolveActiveUsername(source: any): string | undefined {
  if (typeof source?.username === "string" && source.username.trim()) {
    return source.username.trim();
  }

  const activeUsername = Array.isArray(source?.usernames)
    ? source.usernames.find((entry: any) => entry?.active !== false && typeof entry?.username === "string")?.username
    : undefined;

  return typeof activeUsername === "string" && activeUsername.trim() ? activeUsername.trim() : undefined;
}


function normalizeAllowEntry(value: string): string {
  return value.trim().replace(/^@/, "").toLowerCase();
}

function isSenderAllowed(input: {
  allowFrom: string[];
  senderId?: string;
  senderUsername?: string;
}): boolean {
  if (input.allowFrom.includes("*")) {
    return true;
  }

  const senderIds = [
    input.senderId,
    input.senderUsername,
    input.senderUsername ? `@${input.senderUsername}` : undefined,
  ].filter((value): value is string => Boolean(value)).map(normalizeAllowEntry);

  return input.allowFrom.map(normalizeAllowEntry).some((entry) => senderIds.includes(entry));
}

function hasTelegramMention(input: {
  cfg: any;
  agentId?: string;
  selfUsername?: string;
  text: string;
  message?: any;
}): boolean {
  const normalizedText = input.text.trim();
  const message = input.message;
  const mentionRegexes = buildMentionRegexes(input.cfg, input.agentId);
  const selfUsername = input.selfUsername?.replace(/^@/, "").trim();
  const entities = Array.isArray(message?.entities) ? message.entities : [];
  const hasAnyMention = Boolean(message?.mentioned) ||
    entities.some((entity: any) => {
      const kind = typeof entity?.className === "string" ? entity.className : entity?.type;
      return kind === "MessageEntityMention" || kind === "mention" || kind === "MessageEntityMentionName" || kind === "InputMessageEntityMentionName";
    }) ||
    /(^|\s)@[a-zA-Z0-9_]{5,}\b/.test(normalizedText);
  const entityExplicitMention = Boolean(selfUsername) && entities.some((entity: any) => {
    const kind = typeof entity?.className === "string" ? entity.className : entity?.type;
    if (kind !== "MessageEntityMention" && kind !== "mention") {
      return false;
    }

    const offset = typeof entity?.offset === "number" ? entity.offset : -1;
    const length = typeof entity?.length === "number" ? entity.length : 0;
    if (offset < 0 || length <= 0) {
      return false;
    }

    return normalizedText.slice(offset, offset + length).replace(/^@/, "").trim().toLowerCase() === selfUsername.toLowerCase();
  });
  const explicitlyMentioned = Boolean(selfUsername) &&
    (
      message?.mentioned === true ||
      entityExplicitMention ||
      new RegExp(`(^|\\s)@${selfUsername?.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i").test(normalizedText)
    );

  return matchesMentionWithExplicit({
    text: normalizedText,
    mentionRegexes,
    explicit: {
      hasAnyMention,
      isExplicitlyMentioned: explicitlyMentioned,
      canResolveExplicit: Boolean(selfUsername),
    },
  });
}

function toDisplayName(input: {
  username?: string;
  firstName?: string;
  lastName?: string;
  fallback?: string;
}): string {
  if (input.username) {
    return `@${input.username}`;
  }

  const fullName = [ input.firstName, input.lastName ].filter(Boolean).join(" ").trim();
  return fullName || input.fallback || "Telegram";
}

async function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => resolve(undefined), timeoutMs);
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

/**
 * OpenClaw's shared silent-reply sentinel. When the agent decides not to answer
 * it returns this token instead of text, and surfaces are expected to drop the
 * message rather than deliver the token.
 *
 * Core owns the canonical helpers (`SILENT_REPLY_TOKEN`, `isSilentReplyText`,
 * `stripSilentToken` in `src/auto-reply/tokens`), but they are not re-exported
 * through any of the public `openclaw/plugin-sdk/*` entry points, so the
 * behaviour is mirrored here. If the SDK ever exposes them, drop this block and
 * import instead.
 */
const SILENT_REPLY_TOKEN = "NO_REPLY";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove leading and trailing occurrences of the silent token.
 *
 * Leading tokens may be glued to the following text ("NO_REPLYstill thinking"),
 * so the match is not anchored on a word boundary, and punctuation directly
 * after a leading token belongs to the marker rather than to the text.
 *
 * Only whitespace is consumed before a trailing token: punctuation there ends
 * the preceding sentence and must survive ("Done. NO_REPLY" -> "Done.").
 *
 * Occurrences in the middle of a sentence are left alone: there the token is
 * content, not a control marker.
 *
 * Returns the remaining visible text. An empty result means the whole payload
 * was the token and nothing should be sent.
 */
function stripSilentReplyToken(text: string, token: string = SILENT_REPLY_TOKEN): string {
  const escaped = escapeRegExp(token);
  const leading = new RegExp(`^(?:${escaped})[\\s,.:;!—-]*`, "i");
  const trailing = new RegExp(`\\s*(?:${escaped})$`, "i");

  let result = text.trim();
  while (leading.test(result)) {
    const next = result.replace(leading, "").trim();
    if (next === result) {
      break;
    }
    result = next;
  }

  return result.replace(trailing, "").trim();
}

/** True when the payload carries no visible text beyond the silent token. */
function isSilentReplyText(text: string | undefined, token: string = SILENT_REPLY_TOKEN): boolean {
  const trimmed = typeof text === "string" ? text.trim() : "";
  if (!trimmed) {
    return false;
  }

  return stripSilentReplyToken(trimmed, token).length === 0;
}

function prefixReplyTextToAddress(text: string, address?: string): string {
  const outboundText = text.trim();
  if (!address) {
    return outboundText;
  }

  const lowerText = outboundText.toLowerCase();
  const lowerAddress = address.toLowerCase();
  if (
    lowerText === lowerAddress ||
    lowerText.startsWith(`${lowerAddress},`) ||
    lowerText.startsWith(`${lowerAddress}:`) ||
    lowerText.startsWith(`${lowerAddress} `)
  ) {
    return outboundText;
  }

  return `${address}, ${outboundText}`;
}

async function resolveReplyTarget(message: any): Promise<unknown> {
  const directInputSender =
    typeof message?.getInputSender === "function"
      ? await message.getInputSender().catch(() => undefined)
      : undefined;
  if (directInputSender) {
    return directInputSender;
  }

  const sender =
    typeof message?.getSender === "function"
      ? await message.getSender().catch(() => undefined)
      : undefined;
  if (sender) {
    return sender;
  }

  const directInputChat =
    typeof message?.getInputChat === "function"
      ? await message.getInputChat().catch(() => undefined)
      : undefined;
  if (directInputChat) {
    return directInputChat;
  }

  const chat =
    typeof message?.getChat === "function"
      ? await message.getChat().catch(() => undefined)
      : undefined;
  if (chat) {
    return chat;
  }

  return message?.inputSender ?? message?._inputSender ?? message?.sender ?? message?._sender ?? message?.inputChat ?? message?._inputChat ?? message?.chat ?? message?._chat ?? message?.peerId;
}

async function resolveChatTarget(message: any): Promise<unknown> {
  const directInputChat =
    typeof message?.getInputChat === "function"
      ? await message.getInputChat().catch(() => undefined)
      : undefined;
  if (directInputChat) {
    return directInputChat;
  }

  const chat =
    typeof message?.getChat === "function"
      ? await message.getChat().catch(() => undefined)
      : undefined;
  if (chat) {
    return chat;
  }

  return message?.inputChat ?? message?._inputChat ?? message?.chat ?? message?._chat ?? message?.peerId;
}

async function isReplyToSelfMessage(message: any, selfId?: string): Promise<boolean> {
  if (!selfId) {
    return false;
  }

  const replyToMessageId = message?.replyTo?.replyToMsgId ?? message?.replyToMsgId;
  if (!replyToMessageId) {
    return false;
  }

  const replied =
    typeof message?.getReplyMessage === "function"
      ? await message.getReplyMessage().catch(() => undefined)
      : undefined;
  if (!replied) {
    return false;
  }

  if (replied.out === true) {
    return true;
  }

  const replySenderId =
    replied.senderId ??
    replied.fromId?.userId ??
    replied.fromId?.channelId;
  return replySenderId !== undefined && String(replySenderId) === selfId;
}

async function resolveSenderProfile(message: any, input?: {
  senderId?: string;
  client?: any;
}): Promise<{
  username?: string;
  display?: string;
}> {
  const pickProfile = (source: any): {
    username?: string;
    firstName?: string;
    lastName?: string;
  } => {
    const activeUsername = Array.isArray(source?.usernames)
      ? source.usernames.find((entry: any) => entry?.active !== false && typeof entry?.username === "string")?.username
      : undefined;

    return {
      username: typeof source?.username === "string" ? source.username : activeUsername,
      firstName: typeof source?.firstName === "string" ? source.firstName : undefined,
      lastName: typeof source?.lastName === "string" ? source.lastName : undefined,
    };
  };

  const sender =
    typeof message?.getSender === "function"
      ? await message.getSender().catch(() => undefined)
      : undefined;
  const inputSender =
    typeof message?.getInputSender === "function"
      ? await message.getInputSender().catch(() => undefined)
      : undefined;
  const inputSenderEntity =
    inputSender && typeof input?.client?.getEntity === "function"
      ? await input.client.getEntity(inputSender).catch(() => undefined)
      : undefined;
  const fromEntity =
    message?.fromId && typeof input?.client?.getEntity === "function"
      ? await input.client.getEntity(message.fromId).catch(() => undefined)
      : undefined;
  const numericSenderId =
    input?.senderId && /^\d+$/.test(input.senderId) && Number.isSafeInteger(Number(input.senderId))
      ? Number(input.senderId)
      : undefined;
  const entity =
    input?.senderId && typeof input?.client?.getEntity === "function"
      ? await input.client.getEntity(numericSenderId ?? input.senderId).catch(() => undefined)
      : undefined;
  const profiles = [
    pickProfile(sender),
    pickProfile(inputSenderEntity),
    pickProfile(fromEntity),
    pickProfile(entity),
    pickProfile(message?.sender),
    pickProfile(message?._sender),
  ];
  const profile =
    profiles.find((candidate) => candidate.username) ??
    profiles.find((candidate) => candidate.firstName || candidate.lastName);

  const username = profile?.username;

  const display = toDisplayName({
    username,
    firstName: profile?.firstName,
    lastName: profile?.lastName,
  });

  return {
    username,
    display,
  };
}

async function resolveSenderProfileWithTimeout(message: any, input?: {
  senderId?: string;
  client?: any;
}, timeoutMs = 1500): Promise<{
  username?: string;
  display?: string;
}> {
  return await withTimeout(resolveSenderProfile(message, input), timeoutMs) ?? {};
}

/**
 * Send accepts parseMode so drafts can carry real links ([text](url)) instead
 * of bare URLs. The value reaches GramJS, so it is validated here: an unknown
 * mode fails loudly at the action boundary rather than silently sending
 * markup as literal text to a live human.
 */
function normalizeParseMode(raw: unknown): "markdown" | "html" | undefined {
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = String(raw).toLowerCase();
  if (value === "md" || value === "markdown") return "markdown";
  if (value === "html") return "html";
  throw new Error(`clawgram: invalid parseMode "${String(raw)}" — use "markdown" or "html"`);
}

/**
 * Reply parse mode for the inbound reply path (2.3.1). The action `send`
 * takes parseMode per-call, but replies to a mention run through the reply
 * pipeline, which has no per-call slot — so the format is a channel setting:
 * `channels.clawgram.accounts.<id>.replyParseMode: "markdown" | "html"`.
 * Absent means plain text, exactly as before 2.3.1. An invalid value throws
 * at config-read time, loud and early, rather than shipping raw markup.
 */
function resolveReplyParseMode(
  cfg: unknown,
  accountId: string,
): "markdown" | "html" | undefined {
  const channel = (cfg as any)?.channels?.["clawgram"];
  const account = channel?.accounts?.[accountId] ?? channel;
  return normalizeParseMode(account?.replyParseMode);
}

/**
 * Whether this call is a rehearsal, from either position the flag can arrive.
 *
 * Core passes `dryRun` as a sibling of `params`. Callers put it inside
 * `params`, next to `to` and `text`, because that is where every other
 * parameter lives — and there it used to be read by nobody: the flag vanished
 * and the send happened for real.
 *
 * That is the worst possible failure mode for a safety flag, and it has cost
 * two irreversible messages in a work chat (2026-08-08, note 0066; and
 * 2026-08-10 at 02:49 UTC, a bare "ping" the agent then could not delete,
 * because this channel has no delete action). Either position now counts, and
 * a disagreement resolves toward **not** sending: a caller who wrote
 * "dry run" anywhere meant it somewhere.
 */
function resolveDryRun(dryRun: unknown, params: Record<string, unknown> | undefined): boolean {
  const fromParams = params?.dryRun;
  return dryRun === true || dryRun === "true" || fromParams === true || fromParams === "true";
}

/**
 * Parse mode for the `send` action (2.13.0).
 *
 * The per-call parameter still wins — a caller that knows its text is markdown
 * has to be able to say so, and `parseMode: ""` still means "exactly as typed".
 * What changed is the default: an omitted parameter now inherits the account's
 * configured mode instead of silently sending plain text.
 *
 * Before this, the two send paths disagreed. An account set to `html` rendered
 * replies as HTML and tool-driven sends as plain text, so an answer written in
 * markup arrived with its markup showing — which is what happened on
 * 2026-08-09 at 22:30 UTC, in a work chat, to a long answer. Two sends half an
 * hour earlier had passed `parseMode` by hand and looked right; that is the
 * tell, not the reassurance. Correctness that depends on remembering a
 * parameter on every call is correctness that will lapse.
 */
function resolveOutboundParseMode(
  params: Record<string, unknown> | undefined,
  cfg: unknown,
  accountId: string,
): "markdown" | "html" | undefined {
  const raw = params?.parseMode;

  // An explicitly empty value is a decision, not an omission: send it raw.
  if (raw === "" || raw === null) {
    return undefined;
  }

  return raw === undefined
    ? resolveReplyParseMode(cfg, accountId)
    : normalizeParseMode(raw);
}

export {
  normalizeOutboundTarget,
  resolveConfiguredAccountId,
  inferOutboundTargetKind,
  routeKindFromChatType,
  buildConversationTarget,
  buildScopedGroupPeerId,
  stripReplyDirectiveTags,
  readLatestAssistantFallbackFromTranscript,
  resolveActionTarget,
  resolveReplyToMessageIdForTarget,
  readMessageText,
  readVoiceNoteFlag,
  stripTtsDirectives,
  resolveAllowFrom,
  resolveGroupPolicy,
  resolveGroups,
  resolveGroupConfig,
  resolveActiveUsername,
  normalizeAllowEntry,
  isSenderAllowed,
  hasTelegramMention,
  toDisplayName,
  withTimeout,
  SILENT_REPLY_TOKEN,
  stripSilentReplyToken,
  isSilentReplyText,
  prefixReplyTextToAddress,
  resolveReplyTarget,
  resolveChatTarget,
  isReplyToSelfMessage,
  resolveSenderProfile,
  resolveSenderProfileWithTimeout,
  normalizeParseMode,
  resolveReplyParseMode,
  resolveOutboundParseMode,
  resolveDryRun,
};
