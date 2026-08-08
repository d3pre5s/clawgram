import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createChannelPlugin } from "../src/channel";
import { buildVoiceNoteParams } from "../src/gramjs-client";
import type { RuntimeMap } from "../src/types";

/**
 * Synthesized speech reached Telegram as an `.ogg` **document** — a grey file
 * card you have to download before you know what it is — instead of a voice
 * bubble you can just play. Nothing errored; the channel simply never told
 * core it could deliver voice.
 *
 * Core decides by `capabilities.tts.voice` (`resolveChannelTtsVoiceDelivery`),
 * defaulting to `"audio-file"` when the key is absent. Once the channel
 * advertises `"voice-note"`, core marks such sends with `asVoice` — and the
 * send path has to honour it, or the flag becomes another promise made to the
 * Gateway and broken while the agent is acting.
 *
 * These tests tie the three parts together: the advertised capability, the
 * param core actually sends, and the GramJS option that makes Telegram render
 * a voice message.
 */
describe("TTS audio is delivered as a real voice note", () => {
  const cfg = { channels: { clawgram: { accounts: { default: {} } } } };

  // Records what would have gone to Telegram instead of going there.
  const withRecordingRuntime = () => {
    const calls: any[] = [];
    const runtimes = new Map([ [ "default", {
      sendMedia: async (args: any) => {
        calls.push(args);
        return { id: 777 };
      },
    } ] ]) as unknown as RuntimeMap;

    return { channel: createChannelPlugin(runtimes) as any, calls };
  };

  const upload = async (channel: any, params: Record<string, unknown>) => channel.actions.handleAction({
    action: "upload-file",
    params: { to: "@someone", filePath: "/tmp/speech.ogg", ...params },
    cfg,
    accountId: "default",
  });

  it("advertises voice-note delivery to core", () => {
    const channel = createChannelPlugin(new Map() as RuntimeMap) as any;

    assert.equal(
      channel.capabilities.tts?.voice?.synthesisTarget,
      "voice-note",
      "without this core keeps the default 'audio-file' and never sets asVoice",
    );
  });

  it("does not claim to transcode audio it cannot transcode", () => {
    const channel = createChannelPlugin(new Map() as RuntimeMap) as any;

    // `transcodesAudio: true` tells core it may hand over any format because
    // the channel will convert it. We ship no ffmpeg and add no dependencies,
    // so claiming it would make core stop producing Opus and send mp3 bytes
    // labelled as voice.
    assert.notEqual(channel.capabilities.tts?.voice?.transcodesAudio, true);
  });

  it("passes asVoice through to the send", async () => {
    const { channel, calls } = withRecordingRuntime();

    await upload(channel, { asVoice: true });

    assert.equal(calls.length, 1);
    assert.equal(calls[ 0 ].asVoice, true);
  });

  it("accepts the audioAsVoice alias core also emits", async () => {
    const { channel, calls } = withRecordingRuntime();

    await upload(channel, { audioAsVoice: true });

    assert.equal(calls[ 0 ].asVoice, true);
  });

  it("leaves ordinary file sends alone", async () => {
    const { channel, calls } = withRecordingRuntime();

    await upload(channel, {});

    assert.notEqual(calls[ 0 ].asVoice, true);
  });

  it("does not turn an explicit false into a voice note", async () => {
    const { channel, calls } = withRecordingRuntime();

    await upload(channel, { asVoice: false });

    assert.notEqual(calls[ 0 ].asVoice, true);
  });

  it("maps asVoice onto the GramJS option that produces a voice bubble", () => {
    // GramJS branches on `voiceNote` and builds DocumentAttributeAudio with
    // voice=true itself; passing the attribute by hand is not needed.
    assert.deepEqual(buildVoiceNoteParams(true), { voiceNote: true });
  });

  it("omits the option entirely for ordinary media", () => {
    // Not `{ voiceNote: false }`: an absent key and a false one are the same
    // to GramJS today, but the codebase already learned from MTProxy that a
    // key's mere presence can flip a branch. Send nothing when there is
    // nothing to say.
    assert.deepEqual(buildVoiceNoteParams(false), {});
    assert.deepEqual(buildVoiceNoteParams(undefined), {});
  });
});
