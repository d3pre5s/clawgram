/**
 * Attachment metadata for history reads.
 *
 * A message whose whole content is a screenshot used to arrive as an empty
 * `text` — indistinguishable from a message that said nothing. That is a real
 * loss for a reader summarizing a work chat, where the screenshot of the error
 * *is* the report.
 *
 * Only metadata is produced. Nothing is downloaded: knowing that "spec.pdf,
 * 240 KB" was posted is what a summary needs, and fetching the bytes of every
 * attachment in a window would be a different feature with different costs.
 */

export type HistoryMediaKind =
  | "photo"
  | "video"
  | "voice"
  | "audio"
  | "document"
  | "sticker"
  | "poll"
  | "geo"
  | "contact"
  | "webpage"
  | "other";

export type HistoryMedia = {
  kind: HistoryMediaKind;
  /** Present for documents that carry a filename attribute. */
  fileName?: string;
  mimeType?: string;
  /** Bytes, when Telegram reports a size. */
  size?: number;
  /** Whole seconds, for voice, audio and video. */
  durationSeconds?: number;
  /** The emoji a sticker stands for. */
  emoji?: string;
  /** Raw Telegram class, kept for kinds this code does not model yet. */
  telegramType?: string;
};

/**
 * GramJS carries numbers as `big-integer` objects as often as native numbers —
 * the same shape that once made `senderId` silently undefined. Anything that
 * stringifies to digits is accepted.
 */
function readNumber(value: unknown): number | undefined {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : undefined;
  }

  if (value === undefined || value === null) {
    return undefined;
  }

  const parsed = Number(String(value));
  return Number.isFinite(parsed) ? parsed : undefined;
}

function readAttributes(document: any): any[] {
  const attributes = document?.attributes;
  return Array.isArray(attributes) ? attributes : [];
}

function findAttribute(document: any, className: string): any {
  return readAttributes(document).find((attribute) => attribute?.className === className);
}

const SIMPLE_KINDS: Record<string, HistoryMediaKind> = {
  MessageMediaPhoto: "photo",
  MessageMediaPoll: "poll",
  MessageMediaGeo: "geo",
  MessageMediaGeoLive: "geo",
  MessageMediaContact: "contact",
  MessageMediaWebPage: "webpage",
};

/**
 * Documents are the ambiguous case: a voice note, a video, a sticker and a
 * spreadsheet are all `MessageMediaDocument`, separated only by attributes.
 */
function describeDocument(document: any): HistoryMedia {
  const mimeType = typeof document?.mimeType === "string" ? document.mimeType : undefined;
  const size = readNumber(document?.size);
  const fileName = findAttribute(document, "DocumentAttributeFilename")?.fileName;

  const base: HistoryMedia = {
    kind: "document",
    fileName: typeof fileName === "string" ? fileName : undefined,
    mimeType,
    size,
  };

  const sticker = findAttribute(document, "DocumentAttributeSticker");
  if (sticker) {
    return { ...base, kind: "sticker", emoji: typeof sticker.alt === "string" ? sticker.alt : undefined };
  }

  const audio = findAttribute(document, "DocumentAttributeAudio");
  if (audio) {
    const duration = readNumber(audio.duration);
    return {
      ...base,
      kind: audio.voice === true ? "voice" : "audio",
      durationSeconds: duration === undefined ? undefined : Math.round(duration),
    };
  }

  const video = findAttribute(document, "DocumentAttributeVideo");
  if (video) {
    const duration = readNumber(video.duration);
    return {
      ...base,
      kind: "video",
      durationSeconds: duration === undefined ? undefined : Math.round(duration),
    };
  }

  return base;
}

export function describeMedia(media: unknown): HistoryMedia | undefined {
  const raw = media as any;
  const className = raw?.className;
  if (!className || typeof className !== "string" || className === "MessageMediaEmpty") {
    return undefined;
  }

  const simple = SIMPLE_KINDS[ className ];
  if (simple) {
    return { kind: simple };
  }

  if (className === "MessageMediaDocument") {
    return describeDocument(raw.document);
  }

  // Telegram keeps adding media types. An unmodelled one still has to show up
  // as "something was attached" — a blank message is the failure being fixed.
  return { kind: "other", telegramType: className };
}
