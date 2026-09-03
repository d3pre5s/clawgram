import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";

/**
 * `outbound.sendMedia` is the path core uses to deliver a synthesized voice
 * reply. It sat unused until voice replies existed, and carried two defects
 * that only a group could expose — 2026-08-08, message 2185:
 *
 *   [clawgram] outbound sendMedia   to: "clawgram:-1000000000001"
 *   (no "sendMedia completed" line ever followed)
 *
 * 1. The target went to peer resolution with the channel prefix still on it.
 *    `sendText` right next door calls `normalizeOutboundTarget`; this one did
 *    not, so the send threw, the dispatch counters stayed at zero, and the
 *    transcript fallback posted the raw reply as text instead.
 * 2. `audioAsVoice` — core's own signal that this file is a voice note — was
 *    dropped on the floor, so even a successful send would have produced a
 *    grey audio document.
 *
 * A direct message never hit either one: that path goes through the
 * `upload-file` action, which normalizes the target and reads the flag.
 */
describe("outbound.sendMedia delivers a voice reply", () => {
  const withRecordingRuntime = () => {
    const calls: any[] = [];
    const runtimes = new Map([ [ "default", {
      sendMedia: async (args: any) => {
        calls.push(args);
        return { id: 555 };
      },
    } ] ]) as unknown as RuntimeMap;

    return { channel: createChannelPlugin(runtimes) as any, calls };
  };

  const send = async (channel: any, ctx: Record<string, unknown>) => channel.outbound.sendMedia({
    accountId: "default",
    to: "clawgram:-1000000000001",
    mediaUrl: "/tmp/voice.ogg",
    ...ctx,
  });

  it("strips the channel prefix before resolving the peer", async () => {
    const { channel, calls } = withRecordingRuntime();

    await send(channel, {});

    assert.equal(calls.length, 1);
    assert.equal(
      calls[ 0 ].target,
      "-1000000000001",
      "peer resolution never sees a clawgram: prefix from any other path",
    );
  });

  it("forwards audioAsVoice so Telegram renders a voice bubble", async () => {
    const { channel, calls } = withRecordingRuntime();

    await send(channel, { audioAsVoice: true });

    assert.equal(calls[ 0 ].asVoice, true);
  });

  it("leaves ordinary media as ordinary media", async () => {
    const { channel, calls } = withRecordingRuntime();

    await send(channel, { mediaUrl: "/tmp/cat.png" });

    assert.notEqual(calls[ 0 ].asVoice, true);
  });

  it("accepts a plain target unchanged", async () => {
    const { channel, calls } = withRecordingRuntime();

    await send(channel, { to: "@someone" });

    assert.equal(calls[ 0 ].target, "@someone");
  });

  it("still refuses a send with nothing to send", async () => {
    const { channel } = withRecordingRuntime();

    await assert.rejects(
      () => channel.outbound.sendMedia({ accountId: "default", to: "@someone" }),
      /requires filePath or mediaUrl/,
    );
  });
});
