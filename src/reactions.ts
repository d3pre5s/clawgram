/**
 * Emoji reactions — the `react` action of OpenClaw's message tool.
 *
 * Semantics follow the tool contract, and deliberately match what OpenClaw's
 * own Telegram channel does: an empty `emoji` clears this account's reactions,
 * and `remove: true` also clears but still requires a non-empty `emoji` so the
 * tool call stays self-describing.
 *
 * Parsing lives here, apart from the network, so the argument handling can be
 * tested without a Telegram connection.
 */

import { readChatTargetParam } from "./helpers";

export type ReactionParams = {
  target: string;
  messageId: number;
  /** The emoji to add, or "" when the call is a removal. */
  emoji: string;
  remove: boolean;
};

/**
 * How freely the agent may react, from the account's `reactionLevel`.
 *
 * This started as an answer for core's `agentPrompt.reactionGuidance` hook,
 * which core turned out never to call for this channel. The config key stays
 * and keeps its meaning; it now steers `reactToSilentMention` instead of a
 * paragraph of prompt text. Levels mirror the bundled Telegram channel so the
 * same config reads the same way in both:
 *
 * - `off`, `ack` — no agent reactions (`ack` is the "seen it" emoji core sends
 *   by itself, which is a different feature);
 * - `minimal` — react sparingly; the default when nothing is configured;
 * - `extensive` — react whenever it feels natural.
 *
 * An invalid value yields no guidance rather than a guess: a typo turning a
 * work chat chatty is worse than a typo turning it quiet.
 */
export function resolveAgentReactionGuidance(value: unknown): "minimal" | "extensive" | undefined {
  if (value === undefined || value === null) {
    return "minimal";
  }
  if (typeof value !== "string") {
    return undefined;
  }

  const level = value.trim();
  if (!level) {
    return "minimal";
  }
  if (level === "minimal" || level === "extensive") {
    return level;
  }
  if (level === "off" || level === "ack") {
    return undefined;
  }

  return undefined;
}

export type ReactionToolContext = {
  currentChannelId?: string;
  currentMessageId?: string | number;
} | undefined;

/** Accepts the boolean and the string a JSON-ish caller may send for it. */
function readBooleanFlag(value: unknown): boolean {
  return value === true || value === "true";
}

/**
 * Message ids are positive integers. A date arriving here would resolve to
 * some unrelated message, so anything else is refused rather than coerced —
 * the same reasoning as the history parser's id/date guard.
 */
function parseMessageId(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`clawgram: react messageId must be a positive integer, got ${JSON.stringify(value)}`);
  }

  return parsed;
}

export function parseReactionParams(
  params: Record<string, unknown>,
  toolContext: ReactionToolContext,
): ReactionParams {
  const rawTarget = readChatTargetParam(params, toolContext);
  const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
  if (!target) {
    throw new Error("clawgram: react requires a chatId");
  }

  const messageId = parseMessageId(params.messageId ?? params.msgId ?? params.message_id)
    ?? parseMessageId(toolContext?.currentMessageId);
  if (messageId === undefined) {
    throw new Error("clawgram: react requires a messageId");
  }

  const rawEmoji = params.emoji;
  if (rawEmoji !== undefined && rawEmoji !== null && typeof rawEmoji !== "string") {
    throw new Error("clawgram: react emoji must be a string");
  }

  const removeFlag = readBooleanFlag(params.remove);
  const emoji = typeof rawEmoji === "string" ? rawEmoji.trim() : undefined;

  // Only two shapes are meaningful: add this emoji, or clear. A call with
  // neither is a caller mistake, not an empty-string removal.
  if (emoji === undefined) {
    throw new Error("clawgram: react requires an emoji");
  }

  if (removeFlag && emoji === "") {
    throw new Error("clawgram: react with remove requires an emoji");
  }

  return {
    target,
    messageId,
    emoji,
    remove: removeFlag || emoji === "",
  };
}
