import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { createChannelPlugin } from "../src/channel";
import { classifySystemNotice, shouldSuppressGroupSystemNotice } from "../src/system-notice";
import type { RuntimeMap } from "../src/types";

/**
 * The three notices below are core's real output, captured verbatim from the
 * owner's group chat on 2026-08-30 … 09-01 (messages 723, 773, 713). If core
 * renames a prefix, the corresponding case here goes stale together with the
 * filter — and the noise returns to the chat, which is exactly what a failing
 * test is for.
 */
describe("classifySystemNotice", () => {
  it("recognizes each notice class core actually emits", () => {
    assert.equal(
      classifySystemNotice("⚠️ 🛠️ Bash failed: set -euo pipefail store_path=/opt/… (agent)"),
      "tool-warning",
    );
    assert.equal(classifySystemNotice("⚠️ ✉️ Message failed"), "message-failed");
    assert.equal(classifySystemNotice("⚠️ ✉️ Message failed: timed out"), "message-failed");
    assert.equal(
      classifySystemNotice("↪️ Model Fallback: openai/gpt-5.6-sol (selected anthropic/claude-sonnet-5; session expired)"),
      "model-fallback",
    );
    assert.equal(
      classifySystemNotice("↪️ Model Fallback cleared: anthropic/claude-sonnet-5"),
      "model-fallback",
    );
  });

  it("leaves the assistant's own words alone", () => {
    // Talking ABOUT a failure is a reply; only being core's notice is not.
    for (const text of [
      "Костя, стоп — тут не могу выполнить всё как есть, и вот почему.",
      "⚠️ Осторожно: дедлайн завтра.",
      "Вызов упал с ошибкой ⚠️ 🛠️ Bash failed — уже разбираюсь.",
      "Model Fallback — это механизм подстраховки, вот как он работает…",
      "NO_REPLY",
      "",
      "   ",
    ]) {
      assert.equal(classifySystemNotice(text), undefined, JSON.stringify(text));
    }
  });
});

describe("shouldSuppressGroupSystemNotice", () => {
  const notice = "⚠️ ✉️ Message failed";

  it("suppresses in groups and channels only", () => {
    assert.equal(shouldSuppressGroupSystemNotice({ targetKind: "group", text: notice }), "message-failed");
    assert.equal(shouldSuppressGroupSystemNotice({ targetKind: "channel", text: notice }), "message-failed");
  });

  it("keeps the telemetry in DMs, where the reader runs the agent", () => {
    assert.equal(shouldSuppressGroupSystemNotice({ targetKind: "user", text: notice }), undefined);
    assert.equal(shouldSuppressGroupSystemNotice({ targetKind: undefined, text: notice }), undefined);
  });

  it("never touches a real reply, whatever the chat", () => {
    assert.equal(
      shouldSuppressGroupSystemNotice({ targetKind: "group", text: "Готово, создала встречу на 19:00." }),
      undefined,
    );
  });
});

/**
 * The classifier is worthless unless `sendText` consults it: this is the pin
 * that keeps the filter wired in. A refactor of the outbound path that loses
 * the call fails here, not in the owner's chat.
 */
describe("the outbound path suppresses core notices for groups", () => {
  function makeChannel() {
    const sent: Array<Record<string, unknown>> = [];
    const gram = {
      sendText: (args: Record<string, unknown>) => {
        sent.push(args);
        return Promise.resolve({ id: 700 });
      },
      get replyParseMode() { return undefined; },
    };
    const channel = createChannelPlugin(new Map([ [ "default", gram ] ]) as unknown as RuntimeMap) as any;
    return { sent, channel };
  }

  it("a notice addressed to a group never reaches Telegram", async () => {
    const { sent, channel } = makeChannel();

    const result = await channel.outbound.sendText({
      accountId: "default",
      to: "-5350166084",
      text: "⚠️ ✉️ Message failed",
    });

    assert.equal(sent.length, 0, "the notice went out to the group");
    assert.equal((result as any)?.skipped, "system-notice");
  });

  it("the same notice to a DM is delivered — the operator wants the telemetry", async () => {
    const { sent, channel } = makeChannel();

    const result = await channel.outbound.sendText({
      accountId: "default",
      to: "100200300",
      text: "⚠️ ✉️ Message failed",
    });

    assert.equal(sent.length, 1);
    assert.equal((result as any)?.ok, true);
  });

  it("a real group reply passes untouched", async () => {
    const { sent, channel } = makeChannel();

    const result = await channel.outbound.sendText({
      accountId: "default",
      to: "-5350166084",
      text: "Готово: учётка rtomovich, логин скинула.",
    });

    assert.equal(sent.length, 1);
    assert.equal((result as any)?.ok, true);
  });
});
