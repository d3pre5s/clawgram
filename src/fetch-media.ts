/**
 * Fetching an attachment that is already sitting in a chat.
 *
 * Inbound attachments are read as they arrive: a photo sent to the agent
 * becomes `[изображение] …` in the message body and the bytes are dropped.
 * That covers being shown something, and nothing else. It does not cover
 * "посмотри картинку, которую Женя кидал вчера" — history reads carry
 * metadata only (`media.ts`), so a screenshot posted before the agent was
 * addressed exists to it as the word "photo" and no more. It also does not
 * cover reuse: the file the agent read is deleted the moment the read ends,
 * so an image cannot be forwarded, attached to a ticket, or looked at twice.
 *
 * This module is the pure half of the `fetch-media` action: parameter
 * parsing and file naming, testable without a Telegram client. The transport
 * lives in `GramJsClientManager.getMessageById`, the dispatch in `channel.ts`.
 */

import { parseMessageId } from "./history";
import { readChatTargetParam } from "./helpers";

/**
 * What the caller wants out of the fetch.
 *
 * `read` is what inbound does — the attachment turned into words, file gone
 * afterwards. `file` skips the model call and yields a path, which is what
 * forwarding or attaching needs. `both` is the default because the agent
 * asking for an old screenshot usually needs to know what is on it *and* may
 * need to pass it on, and a second fetch to get the other half is a second
 * download of the same bytes.
 */
export type FetchMediaMode = "read" | "file" | "both";

export type FetchMediaParams = {
  target: string;
  messageId: number;
  mode: FetchMediaMode;
};

/**
 * A caller that guessed a neighbouring word is not refused: these are all
 * unambiguous, and an error over vocabulary costs a turn to say nothing.
 */
const MODE_ALIASES: Record<string, FetchMediaMode> = {
  read: "read",
  describe: "read",
  description: "read",
  transcript: "read",
  transcribe: "read",
  text: "read",
  file: "file",
  download: "file",
  path: "file",
  bytes: "file",
  both: "both",
  all: "both",
};

export function parseFetchMediaMode(value: unknown): FetchMediaMode {
  if (value === undefined || value === null || value === "") return "both";
  if (typeof value !== "string") {
    throw new Error("clawgram: mode must be one of read, file, both");
  }

  const mode = MODE_ALIASES[ value.trim().toLowerCase() ];
  if (!mode) {
    throw new Error(`clawgram: unknown mode ${value} — expected read, file or both`);
  }
  return mode;
}

export function parseFetchMediaParams(params: Record<string, unknown>): FetchMediaParams {
  const rawTarget = readChatTargetParam(params);
  const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
  if (!target) {
    throw new Error("clawgram: fetch-media requires a chatId");
  }

  const rawMessageId = params.messageId ?? params.id ?? params.message ?? params.msgId;
  const messageId = parseMessageId(rawMessageId, "messageId");
  if (messageId === undefined) {
    throw new Error("clawgram: fetch-media requires a messageId");
  }

  return { target, messageId, mode: parseFetchMediaMode(params.mode) };
}

/**
 * A file name that survives a round trip through a shell, a log line and a
 * second tool: Telegram file names carry spaces, Cyrillic, quotes and the
 * occasional path separator, and the last of those is the one that matters —
 * `../../x.jpg` as a name must not decide where the file lands.
 */
export function sanitizeFileName(name: unknown): string | undefined {
  if (typeof name !== "string") return undefined;
  const flattened = name.replace(/[/\\]/g, "_").replace(/\s+/g, "_").trim();
  const cleaned = flattened
    .replace(/[^\p{L}\p{N}._-]/gu, "")
    // A run of dots survives the separator strip as `..`, which is harmless in
    // a basename but reads like a traversal in every log it lands in.
    .replace(/\.{2,}/g, ".")
    .replace(/^[._-]+/, "");
  return cleaned.slice(0, 80) || undefined;
}

/**
 * Deterministic on purpose: fetching the same message twice writes the same
 * path instead of scattering copies of one screenshot across the temp
 * directory. The chat and message ids are in the name so two fetches in
 * flight at once cannot land on each other.
 */
export function fetchedMediaFileName(params: {
  chatId: string;
  messageId: number;
  extension: string;
  fileName?: unknown;
}): string {
  const own = sanitizeFileName(params.fileName);
  const chat = params.chatId.replace(/[^0-9a-zA-Z_-]/g, "");
  const stem = `${chat || "chat"}-${params.messageId}`;
  return own ? `${stem}-${own}` : `${stem}.${params.extension}`;
}
