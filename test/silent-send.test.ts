import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";
import { rememberGroupReplyAddress } from "../src/group-reply-address";

/**
 * `NO_REPLY` is OpenClaw's shared "say nothing" sentinel. The inbound pipeline
 * strips it, and core strips it from reply payloads before they reach a
 * channel — but `message.action` is neither: it is an explicit tool call, and
 * whatever text it carries went to Telegram verbatim.
 *
 * The realistic path to that is in the SDK's own prompting: an agent is told to
 * call `message(action="send")` with a caption *and then* reply `NO_REPLY`.
 * Two adjacent steps, one carrying text and one carrying the token — swapping
 * them posts the token into a work chat as the account's own message.
 *
 * With no runtime registered, a send that gets that far fails with "runtime not
 * found". These tests use that as the signal for "would have been sent".
 */
describe("message.action send suppresses the silent token", () => {
  const channel = createChannelPlugin(new Map() as RuntimeMap) as any;
  const cfg = { channels: { clawgram: { accounts: { default: {} } } } };

  const send = (params: Record<string, unknown>) => channel.actions.handleAction({
    action: "send",
    params: { to: "-100123", ...params },
    cfg,
    accountId: "default",
  });

  const parse = (result: unknown) => JSON.parse(
    typeof result === "string" ? result : (result as any).content?.[ 0 ]?.text ?? "{}",
  );

  it("skips a send whose whole text is the token", async () => {
    const payload = parse(await send({ text: "NO_REPLY" }));

    assert.equal(payload.ok, true);
    assert.equal(payload.skipped, "silent");
    assert.equal(payload.sent, false);
  });

  it("skips the token whatever its casing", async () => {
    const payload = parse(await send({ text: "no_reply" }));

    assert.equal(payload.skipped, "silent");
  });

  it("skips a token surrounded by whitespace", async () => {
    const payload = parse(await send({ text: "  NO_REPLY \n" }));

    assert.equal(payload.skipped, "silent");
  });

  // The bug this pins: checking after the reply-address prefix is applied
  // leaves "Иван: " in front of the token, which is not empty, so the token
  // sails through and is posted. That is exactly how it reached the inbound
  // path once already — so the prefix must actually exist for this to test
  // anything, hence the remembered address.
  it("checks the text before the reply-address prefix, not after", async () => {
    rememberGroupReplyAddress({
      accountId: "default",
      chatId: "-100123",
      replyToId: "42",
      address: "Иван",
    });

    const payload = parse(await send({ text: "NO_REPLY", replyToId: "42" }));

    assert.equal(payload.skipped, "silent");
  });

  it("still sends ordinary text", async () => {
    await assert.rejects(() => send({ text: "статус по задаче?" }), /runtime not found/);
  });

  // The token is only a control marker at the edges of the payload. In the
  // middle of a sentence it is content — someone discussing the convention.
  it("still sends a message that merely mentions the token", async () => {
    await assert.rejects(
      () => send({ text: "если ответа не нужно — верни NO_REPLY в конце" }),
      /runtime not found/,
    );
  });

  it("still sends text that only begins with the token", async () => {
    // A leading token is stripped, but visible text remains, so this is a real
    // message and must be delivered rather than silently dropped.
    await assert.rejects(() => send({ text: "NO_REPLY готово, выложил" }), /runtime not found/);
  });

  it("reports an empty send as a missing text, not as a silent one", async () => {
    await assert.rejects(() => send({ text: "" }), /message text is required/);
  });
});

/**
 * Defence in depth. Core normalizes reply payloads and drops the token before
 * a channel is called, so this path should never see one — but "should never"
 * is what the inbound path was assumed to be too, right up until it posted a
 * token. The cost of the check is a string comparison.
 */
describe("outbound.sendText suppresses the silent token", () => {
  const channel = createChannelPlugin(new Map() as RuntimeMap) as any;

  it("returns without sending when the payload is only the token", async () => {
    const result = await channel.outbound.sendText({
      accountId: "default",
      to: "-100123",
      text: "NO_REPLY",
    });

    assert.equal(result?.skipped, "silent");
  });

  it("lets ordinary text through to the runtime lookup", async () => {
    await assert.rejects(
      () => channel.outbound.sendText({ accountId: "default", to: "-100123", text: "привет" }),
      /runtime not found/,
    );
  });
});
