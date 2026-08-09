/**
 * Reacting when the agent decides to stay silent.
 *
 * The agent is told, in her own workspace rules, to leave a reaction when she
 * is named but has nothing to say. She never did — not once across every turn
 * in the logs — and the reason turned out not to be the wording: core builds
 * her system prompt without knowing which channel it is for, so nothing this
 * channel contributes to the prompt reaches her at all. `messageToolHints`
 * and `reactionGuidance` both logged zero invocations while the assembled
 * prompt stayed byte-identical.
 *
 * So the decision moves out of the prompt and into code, at the one moment
 * that is unambiguous: she returned NO_REPLY on a message that named her.
 * The emoji is still chosen by a model — the point was a reaction that fits
 * the message, not a fixed acknowledgement stamp — but choosing it is now a
 * separate, cheap call that cannot be forgotten mid-prompt.
 *
 * Parsing lives here, away from the network, so the awkward cases can be
 * tested without Telegram or a model.
 */

/** How freely to react, mirroring the configured reaction level. */
export type ReactionAppetite = "minimal" | "extensive";

export function buildEmojiSystemPrompt(appetite: ReactionAppetite): string {
  const shared = [
    "You pick a single emoji reaction for a chat message.",
    "The assistant was mentioned in this message but decided it needs no written reply.",
    "Answer with exactly one emoji and nothing else, or the word NONE if no reaction fits.",
    "Match the mood of the message: a joke gets something amused, praise something warm,",
    "bad news something sympathetic, an achievement something celebratory.",
    "Answer NONE when the message is conflictual, heavy, or discusses a person's",
    "performance — a reaction there reads as a verdict on someone.",
  ];

  return appetite === "minimal"
    ? [
      ...shared,
      "Be sparing: answer NONE unless the message clearly invites a reaction.",
    ].join("\n")
    : [
      ...shared,
      "Be generous: react whenever a reaction would feel natural to a colleague.",
    ].join("\n");
}

/**
 * Turns a model answer into an emoji, or nothing.
 *
 * Deliberately strict. A wrong emoji is a visible act on someone else's
 * message, and Telegram rejects emoji outside the chat's allowed set anyway —
 * so anything that does not look like a bare emoji is treated as "no
 * reaction" rather than sent hopefully.
 */
export function parseEmojiChoice(raw: string | undefined | null): string | undefined {
  if (typeof raw !== "string") {
    return undefined;
  }

  // Models like to wrap answers in quotes, backticks or a trailing period.
  const cleaned = raw.trim().replace(/^["'`]+|["'`.]+$/g, "").trim();
  if (!cleaned || /^none$/i.test(cleaned)) {
    return undefined;
  }

  // A sentence is a refusal or an explanation, not a reaction.
  if (/\s/.test(cleaned) || cleaned.length > 8) {
    return undefined;
  }

  // Latin letters and digits mean words like "NONE", "ok" or "1" slipped
  // through; an emoji has none of them.
  if (/[A-Za-z0-9]/.test(cleaned)) {
    return undefined;
  }

  return cleaned;
}

/**
 * Whether a silent turn deserves a reaction attempt at all.
 *
 * Only mentions: the rule the owner asked for is about being named and having
 * nothing to add. A silent turn on a message that never mentioned her is
 * ordinary background reading, and reacting to it would be noise.
 */
export function shouldReactToSilentTurn(params: {
  wasMentioned: boolean;
  appetite: ReactionAppetite | undefined;
  messageText: string | undefined;
}): boolean {
  if (!params.appetite || !params.wasMentioned) {
    return false;
  }

  return Boolean(params.messageText?.trim());
}

/** The message text is truncated before it reaches the model; a mood needs no more. */
const MAX_JUDGED_CHARS = 2000;

export type SilentReactionDeps = {
  /** Asks a model for one emoji. Any throw here is swallowed by the caller. */
  complete: (params: {
    messages: Array<{ role: string; content: string }>;
    systemPrompt: string;
    maxTokens: number;
    purpose: string;
  }) => Promise<{ text?: string } | undefined>;
  sendReaction: (args: { target: unknown; messageId: number; emoji: string; remove: boolean }) => Promise<void>;
  /** Never receives the message body — only whether a reaction came of it. */
  onDecision?: (info: { messageId: number; appetite: ReactionAppetite; chose: "emoji" | "none" }) => void;
};

/**
 * Leaves an emoji on a message the agent was named in but chose not to answer.
 *
 * Best-effort by construction: the reply is already settled when this runs, so
 * a missing model, a refusal, or an emoji Telegram will not take all end as
 * silence — the same outcome as before the feature existed. Callers still wrap
 * it, because a throw here would surface as a failed turn on a message the
 * agent had already decided needed nothing.
 *
 * Returns the emoji it sent, for tests and for nothing else.
 */
export async function reactToSilentMention(params: {
  deps: SilentReactionDeps;
  appetite: ReactionAppetite | undefined;
  wasMentioned: boolean;
  chatId: unknown;
  messageId: unknown;
  messageText: string | undefined;
}): Promise<string | undefined> {
  const { appetite } = params;
  if (!appetite || !shouldReactToSilentTurn({
    wasMentioned: params.wasMentioned,
    appetite,
    messageText: params.messageText,
  })) {
    return undefined;
  }

  const messageId = Number(params.messageId);
  if (!Number.isInteger(messageId) || messageId <= 0) {
    return undefined;
  }

  const answer = await params.deps.complete({
    messages: [ { role: "user", content: String(params.messageText ?? "").slice(0, MAX_JUDGED_CHARS) } ],
    systemPrompt: buildEmojiSystemPrompt(appetite),
    maxTokens: 8,
    purpose: "clawgram: emoji reaction for a silent mention",
  });

  const emoji = parseEmojiChoice(answer?.text);
  params.deps.onDecision?.({ messageId, appetite, chose: emoji ? "emoji" : "none" });
  if (!emoji) {
    return undefined;
  }

  await params.deps.sendReaction({
    target: params.chatId,
    messageId,
    emoji,
    remove: false,
  });

  return emoji;
}
