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

export type ReactionParams = {
  target: string;
  messageId: number;
  /** The emoji to add, or "" when the call is a removal. */
  emoji: string;
  remove: boolean;
};

/**
 * How chatty the agent may be with reactions, as core understands it.
 *
 * Core injects a `## Reactions` section into the system prompt only when a
 * channel returns a level from `agentPrompt.reactionGuidance`. Return nothing
 * and the prompt never mentions reactions at all — which is what happened
 * here until 2.8.0: the `react` action existed, the agent had it, and no line
 * of the prompt suggested using it.
 *
 * Levels and fallbacks mirror the bundled Telegram channel so the two behave
 * the same for the same config:
 *
 * - `off`, `ack` — no agent reactions (`ack` is the "seen it" emoji core sends
 *   by itself, which is a different feature);
 * - `minimal` — react sparingly; the default when nothing is configured;
 * - `extensive` — react whenever it feels natural.
 *
 * An invalid value yields no guidance rather than a guess: a typo turning a
 * work chat chatty is worse than a typo turning it quiet.
 */
/**
 * The reaction guidance as prompt lines, carried by `messageToolHints`.
 *
 * Core has its own `## Reactions` section, but it only builds it when
 * `params.config` is truthy in the prompt assembler — a condition our channel
 * never satisfied: the hook logged zero invocations across live turns while
 * the neighbouring `messageToolHints`, guarded only by the channel being
 * resolved, is called every time.
 *
 * That condition lives in the minified `openclaw` dependency, so it is not
 * ours to fix; patching `node_modules` would evaporate on the next update.
 * The hints path is ours, reaches the same prompt, and does not depend on
 * that diagnosis being right — if the hints arrive, so does the text.
 *
 * Wording follows core's own so behaviour stays the same if it ever starts
 * calling the hook and both appear.
 */
export function buildReactionHintLines(level: "minimal" | "extensive" | undefined): string[] {
  if (!level) {
    return [];
  }

  const shared = [
    "Use the `react` action for this: it leaves an emoji on a message without sending one.",
    "A reaction is not a reply — you can react and still return NO_REPLY, and that is the point when someone names you but needs no answer.",
  ];

  return level === "minimal"
    ? [
      "Reactions are enabled for Telegram in MINIMAL mode. React ONLY when truly relevant: acknowledge an important request or confirmation, or show genuine sentiment sparingly. Do not react to routine messages or to your own replies. Guideline: at most 1 reaction per 5-10 exchanges.",
      ...shared,
    ]
    : [
      "Reactions are enabled for Telegram in EXTENSIVE mode. React liberally: acknowledge messages with a fitting emoji, show sentiment and personality, react to humour, notable events or good news, and use a reaction to confirm agreement. Guideline: react whenever it feels natural.",
      ...shared,
    ];
}

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
  const rawTarget = params.chatId ?? params.target ?? params.to ?? params.chat ?? toolContext?.currentChannelId;
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
