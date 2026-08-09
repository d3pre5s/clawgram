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

export function buildEmojiSystemPrompt(
  appetite: ReactionAppetite,
  allowed?: readonly string[],
): string {
  const choices = allowed === undefined || allowed.length === 0 ? TELEGRAM_REACTIONS : allowed;
  const shared = [
    "You pick a single emoji reaction for a chat message.",
    "The assistant was mentioned in this message but decided it needs no written reply.",
    "Answer with exactly one emoji and nothing else, or the word NONE if no reaction fits.",
    // The set is not decoration: Telegram refuses anything outside it, and an
    // answer outside it is discarded, so offering the choices up front is the
    // difference between a reaction and silence.
    `Choose ONLY from this set, copied exactly: ${choices.join(" ")}`,
    // Fixed answers the owner asked for by name. They come before the mood
    // rule because the model's own instinct here was wrong in a specific way:
    // it answered 👍 to being praised, which reads as approving of the praise
    // rather than being touched by it.
    "Three situations have a fixed answer. Use it, and do not substitute a similar emoji:",
    `- the assistant is praised or thanked, or someone speaks well of it → ❤ (never \u{1F44D} here)`,
    `- the assistant is asked or told to do something → \u{1FAE1}, or \u{1F44C} for a small routine request`,
    `- the message is about producing something written — a text, a reply, a document, a draft → ✍`,
    "Otherwise match the mood: a joke gets something amused, bad news something",
    "sympathetic, an achievement something celebratory.",
    "Answer NONE when the message is conflictual or heavy, or when it judges",
    "SOMEONE ELSE's work or behaviour — a reaction there reads as a verdict on",
    "that person.",
    // Without this the NONE rule swallowed the praise rule: "молодец тина" is
    // literally a statement about someone's performance, the model applied the
    // rule as written, and answered NONE to being praised. The carve-out
    // exists in the assistant's own rules — the ban on judging people protects
    // others, not itself — and had to be repeated here.
    "That restraint protects other people and does NOT apply to the assistant",
    "itself. Praise, teasing, thanks or criticism aimed at the assistant is",
    "exactly what the fixed answers above are for: being called clever, useful",
    "or 'молодец' is praise → ❤, not a verdict on a third party.",
    "When a fixed answer applies, it wins over the mood rule.",
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
 * The emoji Telegram accepts as reactions, in the exact form it expects.
 *
 * Reactions are not "any emoji". Telegram keeps a fixed set, and several of
 * its members carry **no** variation selector — `❤` is U+2764 alone, and so
 * are `⚡`, `✍`, `🕊`, `☃`. Sending the U+FE0F-decorated form of any of them
 * fails, which is exactly what happened on the first live attempt:
 *
 *   RPCError: 400: REACTION_INVALID (caused by messages.SendReaction)
 *
 * The list is written with explicit escapes for those five, because the
 * difference is invisible in an editor and a stray U+FE0F would break them
 * again silently.
 */
export const TELEGRAM_REACTIONS: readonly string[] = [
  "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱",
  "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "\u{1F54A}", "🤡",
  "🥱", "🥴", "😍", "🐳", "🌚", "🌭", "💯", "🤣", "⚡", "🍌",
  "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "😈", "😴", "😭",
  "🤓", "👻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗",
  "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉",
  "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷", "😡",
];

/**
 * Strips the decorations a model adds that Telegram will not accept.
 *
 * U+FE0F is the big one — models emit `❤️` and `⚡️` by habit, and the reaction
 * set wants them bare. Skin-tone modifiers are dropped for the same reason:
 * `👍🏽` is not a member of the set, `👍` is.
 */
export function canonicalizeReactionEmoji(value: string): string {
  return value.replace(/️/g, "").replace(/[\u{1F3FB}-\u{1F3FF}]/gu, "");
}

/**
 * Turns a model answer into an emoji Telegram will actually take, or nothing.
 *
 * Deliberately strict, and strict in the one way that matters: the result is
 * matched against the reaction set rather than merely "looks like an emoji".
 * The first live attempt proved the difference — the model picked a perfectly
 * sensible emoji, the parser passed it, and Telegram refused it.
 *
 * `allowed` narrows the set further for chats that restrict which reactions
 * they permit; omit it when the chat allows all of them.
 */
export function parseEmojiChoice(
  raw: string | undefined | null,
  allowed?: readonly string[],
): string | undefined {
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

  const candidate = canonicalizeReactionEmoji(cleaned);
  // `undefined` is "the chat does not restrict reactions"; an empty list is
  // `ChatReactionsNone` — reactions switched off — and must permit nothing.
  // Collapsing the two would react in a chat that forbids reacting.
  const permitted = allowed === undefined
    ? TELEGRAM_REACTIONS
    : allowed.map(canonicalizeReactionEmoji);

  return permitted.includes(candidate) ? candidate : undefined;
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
  /**
   * Which reactions this chat permits, when it restricts them at all.
   * Resolving it is best-effort: a failure here means "all of them", not
   * "none", because a chat that allows everything is the common case.
   */
  allowedReactions?: () => Promise<readonly string[] | undefined>;
  /**
   * Never receives the message body — only what the reaction step did with it.
   * The emoji is our own act, not correspondence, and the first live failure
   * was undiagnosable without it.
   */
  onDecision?: (info: {
    messageId: number;
    appetite: ReactionAppetite;
    chose: "emoji" | "none";
    emoji?: string;
    allowedCount?: number;
  }) => void;
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

  // A chat that restricts reactions would reject anything outside its own set,
  // so the restriction has to reach the model rather than be discovered by a
  // rejected send. Not knowing is not the same as being forbidden: a failure
  // here falls back to the full Telegram set.
  const allowed = await (params.deps.allowedReactions?.() ?? Promise.resolve(undefined))
    .catch(() => undefined);

  // Reactions switched off for the whole chat: nothing to pick from, and no
  // reason to spend a model call finding that out.
  if (allowed !== undefined && allowed.length === 0) {
    params.deps.onDecision?.({ messageId, appetite, chose: "none", allowedCount: 0 });
    return undefined;
  }

  const answer = await params.deps.complete({
    messages: [ { role: "user", content: String(params.messageText ?? "").slice(0, MAX_JUDGED_CHARS) } ],
    systemPrompt: buildEmojiSystemPrompt(appetite, allowed),
    maxTokens: 8,
    purpose: "clawgram: emoji reaction for a silent mention",
  });

  const emoji = parseEmojiChoice(answer?.text, allowed);
  params.deps.onDecision?.({
    messageId,
    appetite,
    chose: emoji ? "emoji" : "none",
    emoji,
    allowedCount: allowed?.length,
  });
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
