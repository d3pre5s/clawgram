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

/**
 * Downloads a voice or audio note to a temporary file.
 *
 * Voice messages arrive with an empty `text`, so the channel used to drop them
 * as "empty inbound" — the assistant simply never saw them. Metadata is not
 * enough here: unlike a screenshot in a work chat, where knowing "spec.pdf,
 * 240 KB" is a usable summary, a voice note *is* the message. The bytes have
 * to be fetched for the audio pipeline to turn them into words.
 *
 * Returns the path, or undefined when the message carries no downloadable
 * audio. The caller owns the file and is responsible for removing it.
 */
/** What an inbound attachment can be turned into for the agent to read. */
export type InboundMediaUnderstanding = "transcript" | "description";

/**
 * Decides whether an attachment is worth fetching, and what reading it means.
 *
 * Voice notes and images are the two kinds whose bytes *are* the message:
 * dropping them leaves the assistant silent on being spoken to or shown
 * something. Other attachments keep the old treatment — metadata only —
 * because "spec.pdf, 240 KB" already tells a reader what happened, and
 * fetching every document would be a different feature with different costs.
 */
export function inboundMediaUnderstanding(media: HistoryMedia | undefined): InboundMediaUnderstanding | undefined {
  if (!media) return undefined;
  if (media.kind === "voice" || media.kind === "audio") return "transcript";
  if (media.kind === "photo") return "description";
  // A document can be an image sent "as file" — Telegram keeps the pixels,
  // only the envelope differs, so read it rather than announce it.
  if (media.kind === "document" && media.mimeType?.startsWith("image/")) return "description";
  return undefined;
}

/**
 * Downloads an inbound attachment to a temporary file.
 *
 * Returns the path, or undefined when the attachment is not one this channel
 * reads, or is too large to be worth the transfer. The caller owns the file
 * and is responsible for removing it.
 */
export async function downloadInboundMediaToTempFile(params: {
  client: { downloadMedia: (message: unknown, options?: unknown) => Promise<unknown> };
  message: unknown;
  maxBytes: number;
  tmpDir: string;
}): Promise<{ path: string; mimeType?: string; understanding: InboundMediaUnderstanding } | undefined> {
  const described = describeMedia((params.message as any)?.media);
  const understanding = inboundMediaUnderstanding(described);
  if (!described || !understanding) {
    return undefined;
  }

  // A cap belongs here rather than in the caller: an oversized attachment
  // should be reported as such, not fetched and then discarded after the
  // transfer cost.
  if (typeof described.size === "number" && described.size > params.maxBytes) {
    return undefined;
  }

  const buffer = await params.client.downloadMedia(params.message, {});
  if (!buffer || !(buffer instanceof Buffer) || buffer.length === 0) {
    return undefined;
  }

  const extension = extensionFor(described, understanding);
  const { mkdtemp, writeFile } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(params.tmpDir, "clawgram-media-"));
  const path = join(dir, `attachment.${extension}`);
  await writeFile(path, buffer);
  return { path, mimeType: described.mimeType, understanding };
}

function extensionFor(media: HistoryMedia, understanding: InboundMediaUnderstanding): string {
  if (understanding === "description") {
    if (media.mimeType === "image/png") return "png";
    if (media.mimeType === "image/webp") return "webp";
    return "jpg";
  }
  if (media.mimeType === "audio/mpeg") return "mp3";
  if (media.mimeType === "audio/mp4") return "m4a";
  return "ogg";
}
