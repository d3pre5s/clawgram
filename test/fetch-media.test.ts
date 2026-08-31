import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import os from "node:os";
import path from "node:path";
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";

import { createChannelPlugin } from "../src/channel";
import {
  fetchedMediaFileName,
  parseFetchMediaMode,
  parseFetchMediaParams,
  sanitizeFileName,
} from "../src/fetch-media";
import { downloadMessageMediaToFile, pruneFetchedMedia } from "../src/media";
import type { RuntimeMap } from "../src/types";

/**
 * A photo in a chat used to be a word. The inbound path reads what arrives
 * while the agent is addressed and throws the bytes away; `read` reports that
 * an attachment exists and never fetches it. So "посмотри картинку, которую
 * кидали вчера" had no answer, and neither did "перешли её" — the file the
 * agent had just read was already deleted.
 *
 * `fetch-media` closes both: a message id in, a reading and/or a path out.
 */
describe("parseFetchMediaParams", () => {
  it("accepts the chat under any of the names callers use", () => {
    for (const key of [ "chatId", "target", "to", "chat" ]) {
      const parsed = parseFetchMediaParams({ [ key ]: " -1001234 ", messageId: 42 });
      assert.equal(parsed.target, "-1001234");
    }
  });

  it("accepts the message id under any of the names callers use", () => {
    for (const key of [ "messageId", "id", "message", "msgId" ]) {
      const parsed = parseFetchMediaParams({ chatId: "-100123", [ key ]: "77" });
      assert.equal(parsed.messageId, 77);
    }
  });

  it("refuses a call with no chat or no message id", () => {
    assert.throws(() => parseFetchMediaParams({ messageId: 1 }), /requires a chatId/);
    assert.throws(() => parseFetchMediaParams({ chatId: "-100123" }), /requires a messageId/);
  });

  it("defaults to both — the reading and the file", () => {
    assert.equal(parseFetchMediaParams({ chatId: "-100123", messageId: 1 }).mode, "both");
  });

  it("maps the words a caller is likely to reach for", () => {
    assert.equal(parseFetchMediaMode("describe"), "read");
    assert.equal(parseFetchMediaMode("transcript"), "read");
    assert.equal(parseFetchMediaMode("download"), "file");
    assert.equal(parseFetchMediaMode(" FILE "), "file");
    assert.equal(parseFetchMediaMode(undefined), "both");
  });

  it("refuses a mode it does not know rather than guessing", () => {
    assert.throws(() => parseFetchMediaMode("everything"), /unknown mode/);
  });
});

describe("fetchedMediaFileName", () => {
  // A Telegram file name is attacker-supplied text. `../` in it must decide
  // nothing about where the file lands.
  it("cannot escape the directory it is joined to", () => {
    const name = fetchedMediaFileName({
      chatId: "-1001234",
      messageId: 5,
      extension: "jpg",
      fileName: "../../../etc/passwd",
    });

    assert.ok(!name.includes("/"), name);
    assert.ok(!name.includes(".."), name);
    assert.equal(path.basename(path.join("/tmp", name)), name);
  });

  it("keeps the sender's name when it is a name", () => {
    const name = fetchedMediaFileName({
      chatId: "-1001234",
      messageId: 5,
      extension: "jpg",
      fileName: "схема развёртывания.png",
    });

    assert.ok(name.endsWith("схема_развёртывания.png"), name);
    assert.ok(name.startsWith("-1001234-5-"), name);
  });

  it("names an unnamed photo after the message it came from", () => {
    assert.equal(
      fetchedMediaFileName({ chatId: "-1001234", messageId: 5, extension: "jpg" }),
      "-1001234-5.jpg",
    );
  });

  it("drops a name that sanitizes to nothing", () => {
    assert.equal(sanitizeFileName("..."), undefined);
    assert.equal(sanitizeFileName(42), undefined);
  });
});

describe("pruneFetchedMedia", () => {
  it("removes what has aged out and keeps the rest", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "clawgram-prune-test-"));
    try {
      const stale = path.join(dir, "old.jpg");
      const fresh = path.join(dir, "new.jpg");
      writeFileSync(stale, "x");
      writeFileSync(fresh, "x");
      const longAgo = Date.now() / 1000 - 60 * 60 * 48;
      utimesSync(stale, longAgo, longAgo);

      const removed = await pruneFetchedMedia(dir, 24 * 60 * 60 * 1000, Date.now());

      assert.equal(removed, 1);
      assert.equal(existsSync(stale), false);
      assert.equal(existsSync(fresh), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("says nothing was pruned when the directory does not exist yet", async () => {
    const missing = path.join(os.tmpdir(), "clawgram-prune-absent-", String(process.pid));

    assert.equal(await pruneFetchedMedia(missing, 1000, Date.now()), 0);
  });
});

describe("downloadMessageMediaToFile", () => {
  const photoMessage = { media: { className: "MessageMediaPhoto" } };

  it("writes the bytes where the caller asked, under the name it chose", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "clawgram-download-test-"));
    try {
      const result = await downloadMessageMediaToFile({
        client: { downloadMedia: async () => Buffer.from("pixels") },
        message: photoMessage,
        maxBytes: 25 * 1024 * 1024,
        dir,
        fileNameFor: ({ extension }) => `chosen.${extension}`,
      });

      assert.equal(result?.path, path.join(dir, "chosen.jpg"));
      assert.equal(readFileSync(result!.path, "utf8"), "pixels");
      assert.equal(result?.understanding, "description");
      assert.equal(result?.media.kind, "photo");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves an oversized document unfetched", async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), "clawgram-download-test-"));
    try {
      let downloads = 0;
      const result = await downloadMessageMediaToFile({
        client: {
          downloadMedia: async () => {
            downloads += 1;
            return Buffer.from("x");
          },
        },
        message: {
          media: {
            className: "MessageMediaDocument",
            document: { mimeType: "image/png", size: 40 * 1024 * 1024, attributes: [] },
          },
        },
        maxBytes: 25 * 1024 * 1024,
        dir,
        fileNameFor: () => "never.png",
      });

      assert.equal(result, undefined);
      assert.equal(downloads, 0, "the cap has to be checked before the transfer, not after");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * End to end through the action, with Telegram and the image model faked.
 */
describe("the fetch-media action", () => {
  const cfg = { channels: { clawgram: { accounts: { default: {} } } } };

  const parse = (result: unknown) => JSON.parse(
    typeof result === "string" ? result : (result as any).content?.[ 0 ]?.text ?? "{}",
  );

  const photoMessage = { className: "Message", media: { className: "MessageMediaPhoto" } };

  const withRuntime = (options?: { message?: unknown; describe?: () => Promise<{ text: string }> }) => {
    const runtimes = new Map([ [ "default", {
      getMessageById: async (_target: string, _id: number) => ({
        chatId: "-1001234",
        message: "message" in (options ?? {}) ? options?.message : photoMessage,
      }),
      getClient: () => ({ downloadMedia: async () => Buffer.from("pixels") }),
    } ] ]) as unknown as RuntimeMap;

    const pluginRuntime = {
      mediaUnderstanding: {
        describeImageFile: options?.describe ?? (async () => ({ text: "  скриншот с ошибкой TS2307  " })),
        transcribeAudioFile: async () => ({ text: "words" }),
      },
    } as any;

    return createChannelPlugin(runtimes, pluginRuntime) as any;
  };

  const fetchMedia = async (channel: any, params: Record<string, unknown>) => parse(
    await channel.actions.handleAction({
      action: "fetch-media",
      params: { chatId: "-1001234", messageId: 42, ...params },
      cfg,
      accountId: "default",
    }),
  );

  it("is advertised, or the agent never learns it exists", () => {
    const described = createChannelPlugin(new Map() as RuntimeMap).actions.describeMessageTool({
      cfg,
      accountId: "default",
    });

    // Under `download-file`, core's own name for it. The descriptive
    // `fetch-media` is outside core's vocabulary, so advertising it taught the
    // agent a spelling that always fails — the same trap `chatInfo` sprang in a
    // live chat on 2026-08-31.
    assert.ok(
      described.actions.includes("download-file"),
      `download-file missing; tool offers only: ${described.actions.join(", ")}`,
    );
    assert.ok(!described.actions.includes("fetch-media"));
  });

  it("returns both the reading and a file that outlives the call", async () => {
    const result = await fetchMedia(withRuntime(), {});

    assert.equal(result.ok, true);
    assert.equal(result.mode, "both");
    assert.equal(result.text, "скриншот с ошибкой TS2307");
    assert.equal(result.media.kind, "photo");
    assert.ok(result.filePath, "no path — the file cannot be forwarded");
    assert.equal(existsSync(result.filePath), true, "the file was deleted, so `both` gave only words");
    rmSync(result.filePath, { force: true });
  });

  it("keeps the file and skips the model call in file mode", async () => {
    let described = 0;
    const channel = withRuntime({
      describe: async () => {
        described += 1;
        return { text: "should not run" };
      },
    });

    const result = await fetchMedia(channel, { mode: "file" });

    assert.equal(result.ok, true);
    assert.equal(result.text, undefined);
    assert.equal(described, 0, "file mode paid for a reading nobody asked for");
    assert.equal(existsSync(result.filePath), true);
    rmSync(result.filePath, { force: true });
  });

  it("deletes the file in read mode, the way the inbound path does", async () => {
    const result = await fetchMedia(withRuntime(), { mode: "read" });

    assert.equal(result.ok, true);
    assert.equal(result.text, "скриншот с ошибкой TS2307");
    assert.equal(result.filePath, undefined);
  });

  it("keeps the fetch when the reading fails", async () => {
    const channel = withRuntime({
      describe: async () => {
        throw new Error("vision backend is down");
      },
    });

    const result = await fetchMedia(channel, {});

    assert.equal(result.ok, true, "a failed reading must not throw away bytes already fetched");
    assert.ok(result.filePath);
    assert.match(result.readError, /vision backend is down/);
    rmSync(result.filePath, { force: true });
  });

  it("tells a missing message from a message with nothing to fetch", async () => {
    const missing = await fetchMedia(withRuntime({ message: undefined }), {});
    assert.equal(missing.ok, false);
    assert.equal(missing.error, "message-not-found");

    const text = await fetchMedia(withRuntime({ message: { className: "Message" } }), {});
    assert.equal(text.ok, false);
    assert.equal(text.error, "no-media");

    const video = await fetchMedia(
      withRuntime({
        message: {
          className: "Message",
          media: {
            className: "MessageMediaDocument",
            document: {
              mimeType: "video/mp4",
              attributes: [ { className: "DocumentAttributeVideo", duration: 12 } ],
            },
          },
        },
      }),
      {},
    );
    assert.equal(video.ok, false);
    assert.equal(video.error, "unsupported-media");
    assert.equal(video.media.kind, "video");
  });

  it("obeys readChats — bytes must not leave a chat history may not be read from", async () => {
    const scoped = {
      channels: { clawgram: { accounts: { default: { readChats: [ "-1009999" ] } } } },
    };

    await assert.rejects(
      withRuntime().actions.handleAction({
        action: "fetch-media",
        params: { chatId: "-1001234", messageId: 42 },
        cfg: scoped,
        accountId: "default",
      }),
      /not-allowed-chat/,
    );
  });

  it("answers to the names a caller is likely to guess", async () => {
    for (const action of [ "fetchMedia", "download-media", "downloadMedia", "getMedia", "download-file" ]) {
      const result = parse(await withRuntime().actions.handleAction({
        action,
        params: { chatId: "-1001234", messageId: 42, mode: "read" },
        cfg,
        accountId: "default",
      }));

      assert.equal(result.ok, true, `${action} was not routed to fetch-media`);
    }
  });
});

describe("fetching an attachment is discoverable by an agent that has no other documentation", () => {
  const channel = createChannelPlugin(new Map() as RuntimeMap) as any;

  // Named as `download-file` throughout. Naming the descriptive spelling in a
  // hint is worse than silence: it reads as an offer and fails on every call,
  // which is how `chatInfo` broke a live reply on 2026-08-31.
  it("is named in the tool hints and capabilities, under the callable name", () => {
    assert.ok(
      channel.agentPrompt.messageToolHints().some((hint: string) => hint.includes("`download-file`")),
      "an action nobody is told about is an action nobody uses",
    );
    assert.ok(
      channel.agentPrompt.messageToolCapabilities().some((line: string) => line.includes("download-file")),
    );
    assert.ok(
      !channel.agentPrompt.messageToolHints().some((hint: string) => hint.includes("`fetch-media`")),
      "a hint that names an uncallable spelling invites the agent to fail",
    );
  });
});

describe("a read-mode fetch does not delete an earlier fetch of the same message", () => {
  // The shared directory is keyed by chat and message on purpose — fetching
  // one screenshot twice must not leave two copies. That makes the path
  // predictable, which is exactly why `read` must not delete it: an earlier
  // `both` handed that path to the caller.
  const cfg = { channels: { clawgram: { accounts: { default: {} } } } };

  const parse = (result: unknown) => JSON.parse(
    typeof result === "string" ? result : (result as any).content?.[ 0 ]?.text ?? "{}",
  );

  it("keeps the file the earlier fetch returned", async () => {
    const runtimes = new Map([ [ "default", {
      getMessageById: async () => ({
        chatId: "-1005555",
        message: { className: "Message", media: { className: "MessageMediaPhoto" } },
      }),
      getClient: () => ({ downloadMedia: async () => Buffer.from("pixels") }),
    } ] ]) as unknown as RuntimeMap;

    const channel = createChannelPlugin(runtimes, {
      mediaUnderstanding: {
        describeImageFile: async () => ({ text: "диаграмма" }),
        transcribeAudioFile: async () => ({ text: "words" }),
      },
    } as any) as any;

    const call = async (mode: string) => parse(await channel.actions.handleAction({
      action: "fetch-media",
      params: { chatId: "-1005555", messageId: 9, mode },
      cfg,
      accountId: "default",
    }));

    const kept = await call("both");
    assert.ok(kept.filePath);

    const glanced = await call("read");
    assert.equal(glanced.ok, true);
    assert.equal(glanced.filePath, undefined);

    assert.equal(
      existsSync(kept.filePath),
      true,
      "the read-mode fetch deleted a path an earlier fetch had already handed out",
    );
    rmSync(kept.filePath, { force: true });
  });
});

describe("core's target policy lets the call through", () => {
  // Core keys its target policy by its own action vocabulary. An action it
  // does not know is simultaneously "requires a target" (the lookup returns
  // undefined, which is !== "none") and "does not accept a target" (the same
  // lookup defaults to "none" when a target is passed) — so on 2026-08-24 the
  // agent got `Action fetch-media requires a target.` without one and
  // `Action fetch-media does not accept a target.` with one, and had no way
  // through. Two things fix it, and both have to stay.
  const channel = createChannelPlugin(new Map() as RuntimeMap) as any;

  it("uses core's own name for the action as well", () => {
    const described = channel.actions.describeMessageTool({
      cfg: { channels: { clawgram: { accounts: { default: {} } } } },
      accountId: "default",
    });

    assert.ok(
      described.actions.includes("download-file"),
      "download-file is in CHANNEL_MESSAGE_ACTION_NAMES and maps to target mode \"none\" — without it the contradiction above is unavoidable",
    );
  });

  it("tells core that chatId names the destination", () => {
    const aliases = channel.actions.messageActionTargetAliases;

    for (const action of [ "fetch-media", "download-file" ]) {
      assert.ok(
        aliases?.[ action ]?.aliases?.includes("chatId"),
        `${action} does not declare chatId — core will refuse the call as targetless`,
      );
    }
  });
});
