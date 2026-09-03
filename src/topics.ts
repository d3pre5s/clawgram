/**
 * Forum topics — the names a supergroup organises itself by.
 *
 * A forum chat addresses replies by topic, and `chatInfo` can only say *that*
 * a chat is a forum. Everything else about a topic reached the assistant as a
 * bare number lifted off an inbound message, so a person could ask it to work
 * in "Визитка - представление" and it had no way to turn that name into an id —
 * or to know the topic existed before somebody wrote in it.
 *
 * Parsing and shaping are pure so they can be tested without a Telegram
 * client; the transport lives in `GramJsClientManager.listTopics`.
 */
import { toStringId } from "./normalize.js";
import { readChatTargetParam } from "./helpers";

export const TOPICS_DEFAULT_LIMIT = 100;
export const TOPICS_MAX_LIMIT = 500;

export type ForumTopic = {
  topicId: string;
  title: string;
  /** Last message in the topic — a cheap "is anything happening here". */
  topMessageId?: string;
  closed?: boolean;
  hidden?: boolean;
  pinned?: boolean;
};

export type TopicsParams = {
  target: string;
  limit: number;
  /** Narrows a long list by title; absent means "everything". */
  query?: string;
};

export function parseTopicsParams(params: Record<string, unknown>): TopicsParams {
  const rawTarget = readChatTargetParam(params);
  const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
  if (!target) {
    throw new Error("clawgram: topics requires a chatId");
  }

  const rawQuery = params.query ?? params.search ?? params.title;
  const trimmedQuery = typeof rawQuery === "string" ? rawQuery.trim() : "";
  const query = trimmedQuery.length > 0 ? trimmedQuery : undefined;

  const rawLimit = params.limit;
  if (rawLimit === undefined || rawLimit === null || rawLimit === "") {
    return { target, limit: TOPICS_DEFAULT_LIMIT, query };
  }

  const parsed = Number(rawLimit);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("clawgram: topics limit must be a positive number");
  }

  return { target, limit: Math.min(Math.floor(parsed), TOPICS_MAX_LIMIT), query };
}

/** Telegram sends flags only when they are set; an absent flag is not `false`. */
function optionalFlag(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function matchesQuery(title: string, query?: string): boolean {
  if (!query) return true;
  return title.toLocaleLowerCase().includes(query.toLocaleLowerCase());
}

/**
 * `channels.getForumTopics` returns live topics and tombstones in one list.
 * A `ForumTopicDeleted` carries an id and nothing else: it cannot be named,
 * so it is dropped rather than surfaced as a topic with a blank title.
 */
export function normalizeForumTopics(
  raw: unknown,
  options: { query?: string } = {},
): ForumTopic[] {
  if (!Array.isArray(raw)) return [];

  const topics: ForumTopic[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== "object") continue;

    const candidate = entry as Record<string, unknown>;
    const title = typeof candidate.title === "string" ? candidate.title : undefined;
    const topicId = toStringId(candidate.id);
    if (!title || !topicId) continue;
    if (!matchesQuery(title, options.query)) continue;

    const topic: ForumTopic = { topicId, title };

    const topMessageId = toStringId(candidate.topMessage);
    if (topMessageId !== undefined) topic.topMessageId = topMessageId;

    const closed = optionalFlag(candidate.closed);
    if (closed !== undefined) topic.closed = closed;

    const hidden = optionalFlag(candidate.hidden);
    if (hidden !== undefined) topic.hidden = hidden;

    const pinned = optionalFlag(candidate.pinned);
    if (pinned !== undefined) topic.pinned = pinned;

    topics.push(topic);
  }

  return topics;
}
