import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";

/**
 * Sending a file was implemented in `outbound.sendMedia` from the start, but
 * the channel never told core it could do it: `describeMessageTool` listed
 * every action except `upload-file`. That does not fail loudly — it fails as a
 * shrug. On 2026-08-07 the owner asked the agent to draw a cat; the image was
 * generated, resized and waiting on disk, and the agent — with no action able
 * to carry a file — answered "Вот кот 🐱" in plain text. The file never moved.
 *
 * These tests tie the advertised action to the implementation in both
 * directions, the same way the reaction tests do, so the pair cannot drift.
 */
describe("upload-file carries a real file", () => {
  const cfg = { channels: { clawgram: { accounts: { default: {} } } } };

  const parse = (result: unknown) => JSON.parse(
    typeof result === "string" ? result : (result as any).content?.[ 0 ]?.text ?? "{}",
  );

  const describeTool = (channel: any) => channel.actions.describeMessageTool({
    cfg,
    accountId: "default",
  });

  // Records what would have gone to Telegram instead of going there.
  const withRecordingRuntime = () => {
    const calls: any[] = [];
    const runtimes = new Map([ [ "default", {
      sendMedia: async (args: any) => {
        calls.push(args);
        return { id: 4242 };
      },
    } ] ]) as unknown as RuntimeMap;

    return { channel: createChannelPlugin(runtimes) as any, calls };
  };

  it("advertises upload-file", () => {
    const described = describeTool(createChannelPlugin(new Map() as RuntimeMap) as any);

    assert.ok(
      described.actions.includes("upload-file"),
      `upload-file missing; tool offers only: ${described.actions.join(", ")}`,
    );
  });

  it("declares which params carry the file, so core can normalize paths", () => {
    const described = describeTool(createChannelPlugin(new Map() as RuntimeMap) as any);
    const declared = described.mediaSourceParams?.[ "upload-file" ] ?? [];

    for (const param of [ "filePath", "path", "media" ]) {
      assert.ok(declared.includes(param), `upload-file does not declare ${param} as a media source`);
    }
  });

  it("keeps the actions the channel already had", () => {
    const described = describeTool(createChannelPlugin(new Map() as RuntimeMap) as any);

    for (const action of [ "send", "read", "participants", "joins", "react", "chatInfo" ]) {
      assert.ok(described.actions.includes(action), `lost the ${action} action`);
    }
  });

  it("passes the file and caption through to Telegram", async () => {
    const { channel, calls } = withRecordingRuntime();

    const payload = parse(await channel.actions.handleAction({
      action: "upload-file",
      params: { to: "-100123", filePath: "/tmp/cat.png", message: "Вот кот" },
      cfg,
      accountId: "default",
    }));

    assert.equal(calls.length, 1);
    assert.equal(calls[ 0 ].file, "/tmp/cat.png");
    assert.equal(calls[ 0 ].caption, "Вот кот");
    assert.equal(payload.ok, true);
    assert.equal(payload.messageId, "4242");
  });

  it("accepts the legacy sendAttachment alias", async () => {
    const { channel, calls } = withRecordingRuntime();

    await channel.actions.handleAction({
      action: "sendAttachment",
      params: { to: "-100123", path: "/tmp/cat.png" },
      cfg,
      accountId: "default",
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[ 0 ].file, "/tmp/cat.png");
  });

  it("takes the file from any param core may have filled in", async () => {
    for (const param of [ "filePath", "path", "media", "mediaUrl" ]) {
      const { channel, calls } = withRecordingRuntime();

      await channel.actions.handleAction({
        action: "upload-file",
        params: { to: "-100123", [ param ]: "/tmp/cat.png" },
        cfg,
        accountId: "default",
      });

      assert.equal(calls.length, 1, `${param} did not reach sendMedia`);
    }
  });

  it("sends no caption rather than the silent sentinel", async () => {
    const { channel, calls } = withRecordingRuntime();

    await channel.actions.handleAction({
      action: "upload-file",
      params: { to: "-100123", filePath: "/tmp/cat.png", message: "NO_REPLY" },
      cfg,
      accountId: "default",
    });

    assert.equal(calls.length, 1, "the file itself must still be sent");
    assert.equal(calls[ 0 ].caption, undefined);
  });

  it("says what is missing when no file was given", async () => {
    const { channel } = withRecordingRuntime();

    await assert.rejects(
      () => channel.actions.handleAction({
        action: "upload-file",
        params: { to: "-100123", message: "no file here" },
        cfg,
        accountId: "default",
      }),
      /upload-file requires filePath, path, media, or mediaUrl/,
    );
  });

  // `openclaw message send --media photo.jpg` is a documented invocation, and
  // it arrives as action "send" with the file in params. Routing that to the
  // text path sent the caption and silently dropped the picture.
  it("sends the file when a plain send carries one", async () => {
    const { channel, calls } = withRecordingRuntime();

    await channel.actions.handleAction({
      action: "send",
      params: { to: "-100123", message: "подпись", media: "/tmp/cat.png" },
      cfg,
      accountId: "default",
    });

    assert.equal(calls.length, 1, "a send carrying media must not degrade to text");
    assert.equal(calls[ 0 ].file, "/tmp/cat.png");
    assert.equal(calls[ 0 ].caption, "подпись");
  });

  it("leaves a send without a file on the text path", async () => {
    const { channel, calls } = withRecordingRuntime();

    // No runtime method for text here, so reaching the text path throws —
    // which is the assertion: it must not have been treated as media.
    await assert.rejects(() => channel.actions.handleAction({
      action: "send",
      params: { to: "-100123", message: "просто текст" },
      cfg,
      accountId: "default",
    }));

    assert.equal(calls.length, 0, "a plain text send must not call sendMedia");
  });

  it("answers a dry run without touching Telegram", async () => {
    const { channel, calls } = withRecordingRuntime();

    const payload = parse(await channel.actions.handleAction({
      action: "upload-file",
      params: { to: "-100123", filePath: "/tmp/cat.png" },
      cfg,
      accountId: "default",
      dryRun: true,
    }));

    assert.equal(payload.ok, true);
    assert.equal(payload.dryRun, true);
    assert.equal(calls.length, 0, "a dry run must not send");
  });
});
