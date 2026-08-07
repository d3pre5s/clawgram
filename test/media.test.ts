import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import os from "node:os";
import { readFileSync, rmSync } from "node:fs";
import { dirname } from "node:path";

import { describeMedia, downloadInboundMediaToTempFile, inboundMediaUnderstanding } from "../src/media";

/**
 * Shapes here mirror what GramJS hands over: a `className` string plus the
 * raw TL fields. Nothing is downloaded — the point is that a reader can tell
 * a photo from a spreadsheet without fetching either.
 */
describe("describeMedia", () => {
  it("returns undefined when a message carries no media", () => {
    assert.equal(describeMedia(undefined), undefined);
    assert.equal(describeMedia(null), undefined);
    assert.equal(describeMedia({ className: "MessageMediaEmpty" }), undefined);
  });

  it("recognizes a photo", () => {
    const media = describeMedia({ className: "MessageMediaPhoto" });

    assert.equal(media?.kind, "photo");
  });

  it("reads filename, mime type and size of a document", () => {
    const media = describeMedia({
      className: "MessageMediaDocument",
      document: {
        mimeType: "application/pdf",
        size: 240_512,
        attributes: [ { className: "DocumentAttributeFilename", fileName: "spec.pdf" } ],
      },
    });

    assert.equal(media?.kind, "document");
    assert.equal(media?.fileName, "spec.pdf");
    assert.equal(media?.mimeType, "application/pdf");
    assert.equal(media?.size, 240_512);
  });

  // A voice note is a document too, and the distinction matters: "someone sent
  // a 42-second voice message" reads very differently from "someone sent a file".
  it("tells a voice note from an audio file", () => {
    const voice = describeMedia({
      className: "MessageMediaDocument",
      document: {
        mimeType: "audio/ogg",
        attributes: [ { className: "DocumentAttributeAudio", voice: true, duration: 42 } ],
      },
    });

    assert.equal(voice?.kind, "voice");
    assert.equal(voice?.durationSeconds, 42);

    const audio = describeMedia({
      className: "MessageMediaDocument",
      document: {
        mimeType: "audio/mpeg",
        attributes: [ { className: "DocumentAttributeAudio", duration: 180, title: "track" } ],
      },
    });

    assert.equal(audio?.kind, "audio");
    assert.equal(audio?.durationSeconds, 180);
  });

  it("recognizes video and rounds a fractional duration", () => {
    const media = describeMedia({
      className: "MessageMediaDocument",
      document: {
        mimeType: "video/mp4",
        attributes: [ { className: "DocumentAttributeVideo", duration: 12.7 } ],
      },
    });

    assert.equal(media?.kind, "video");
    assert.equal(media?.durationSeconds, 13);
  });

  it("recognizes a sticker and keeps the emoji it stands for", () => {
    const media = describeMedia({
      className: "MessageMediaDocument",
      document: {
        mimeType: "image/webp",
        attributes: [ { className: "DocumentAttributeSticker", alt: "👍" } ],
      },
    });

    assert.equal(media?.kind, "sticker");
    assert.equal(media?.emoji, "👍");
  });

  it("recognizes the non-document media a work chat actually sees", () => {
    assert.equal(describeMedia({ className: "MessageMediaPoll" })?.kind, "poll");
    assert.equal(describeMedia({ className: "MessageMediaGeo" })?.kind, "geo");
    assert.equal(describeMedia({ className: "MessageMediaGeoLive" })?.kind, "geo");
    assert.equal(describeMedia({ className: "MessageMediaContact" })?.kind, "contact");
    assert.equal(describeMedia({ className: "MessageMediaWebPage" })?.kind, "webpage");
  });

  // Telegram keeps adding media types; an unknown one must still be visible as
  // "something was attached" rather than vanishing into a blank message.
  it("falls back to a generic kind for anything unrecognized", () => {
    const media = describeMedia({ className: "MessageMediaGiveaway" });

    assert.equal(media?.kind, "other");
    assert.equal(media?.telegramType, "MessageMediaGiveaway");
  });

  it("survives a malformed document without throwing", () => {
    const media = describeMedia({ className: "MessageMediaDocument", document: { attributes: "not-an-array" } });

    assert.equal(media?.kind, "document");
    assert.equal(media?.fileName, undefined);
  });

  // GramJS carries sizes as big-integer objects, the same trap that once made
  // senderId come back undefined.
  it("reads a size carried as a big-integer object", () => {
    const media = describeMedia({
      className: "MessageMediaDocument",
      document: { size: { toString: () => "1048576" }, attributes: [] },
    });

    assert.equal(media?.size, 1_048_576);
  });
});

/**
 * A voice note is the one attachment whose bytes have to be fetched: its text
 * is empty, so without the audio there is nothing for the assistant to read.
 * These cover the decisions made before any transfer happens.
 */
describe("downloadInboundMediaToTempFile", () => {
  const voiceMessage = {
    media: {
      className: "MessageMediaDocument",
      document: {
        mimeType: "audio/ogg",
        size: 12_000,
        attributes: [{ className: "DocumentAttributeAudio", voice: true, duration: 5 }],
      },
    },
  };

  it("leaves attachments it does not read alone", async () => {
    const client = {
      downloadMedia: async () => {
        throw new Error("must not download an attachment that is only announced");
      },
    };

    const result = await downloadInboundMediaToTempFile({
      client,
      message: {
        media: {
          className: "MessageMediaDocument",
          document: {
            mimeType: "application/pdf",
            size: 12_000,
            attributes: [{ className: "DocumentAttributeFilename", fileName: "spec.pdf" }],
          },
        },
      },
      maxBytes: 1_000_000,
      tmpDir: os.tmpdir(),
    });

    assert.equal(result, undefined);
  });

  it("downloads a photo so the picture can be described", async () => {
    const client = { downloadMedia: async () => Buffer.from("fake-jpeg-bytes") };

    const result = await downloadInboundMediaToTempFile({
      client,
      message: { media: { className: "MessageMediaPhoto" } },
      maxBytes: 1_000_000,
      tmpDir: os.tmpdir(),
    });

    assert.equal(result?.understanding, "description");
    assert.equal(readFileSync(result!.path).toString(), "fake-jpeg-bytes");
    rmSync(dirname(result!.path), { recursive: true, force: true });
  });

  it("refuses an oversized note before spending the transfer", async () => {
    let attempted = false;
    const client = {
      downloadMedia: async () => {
        attempted = true;
        return Buffer.from("never");
      },
    };

    const result = await downloadInboundMediaToTempFile({
      client,
      message: voiceMessage,
      maxBytes: 1_000,
      tmpDir: os.tmpdir(),
    });

    assert.equal(result, undefined);
    assert.equal(attempted, false, "size is known upfront, so nothing should be fetched");
  });

  it("writes the audio to a temp file and reports its mime type", async () => {
    const payload = Buffer.from("fake-opus-bytes");
    const client = { downloadMedia: async () => payload };

    const result = await downloadInboundMediaToTempFile({
      client,
      message: voiceMessage,
      maxBytes: 1_000_000,
      tmpDir: os.tmpdir(),
    });

    assert.ok(result, "a voice note within limits should be downloaded");
    assert.equal(result?.mimeType, "audio/ogg");
    assert.equal(result?.understanding, "transcript");
    assert.equal(readFileSync(result!.path).toString(), "fake-opus-bytes");
    rmSync(dirname(result!.path), { recursive: true, force: true });
  });

  it("treats an empty download as no audio rather than an empty file", async () => {
    const client = { downloadMedia: async () => Buffer.alloc(0) };

    const result = await downloadInboundMediaToTempFile({
      client,
      message: voiceMessage,
      maxBytes: 1_000_000,
      tmpDir: os.tmpdir(),
    });

    assert.equal(result, undefined);
  });
});

/**
 * The split between "read this" and "just say it arrived" is the whole policy:
 * a voice note and a screenshot are the message, a spreadsheet is a fact about
 * the message.
 */
describe("inboundMediaUnderstanding", () => {
  it("reads voice notes and audio as speech", () => {
    assert.equal(inboundMediaUnderstanding({ kind: "voice" }), "transcript");
    assert.equal(inboundMediaUnderstanding({ kind: "audio" }), "transcript");
  });

  it("reads photos as pictures", () => {
    assert.equal(inboundMediaUnderstanding({ kind: "photo" }), "description");
  });

  it("reads an image sent as a file — only the envelope differs", () => {
    assert.equal(
      inboundMediaUnderstanding({ kind: "document", mimeType: "image/png" }),
      "description",
    );
  });

  it("leaves other documents announced rather than read", () => {
    assert.equal(inboundMediaUnderstanding({ kind: "document", mimeType: "application/pdf" }), undefined);
    assert.equal(inboundMediaUnderstanding({ kind: "video" }), undefined);
    assert.equal(inboundMediaUnderstanding(undefined), undefined);
  });
});
