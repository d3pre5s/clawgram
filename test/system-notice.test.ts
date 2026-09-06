import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import { readFileSync } from "node:fs";
import path from "node:path";

import { createChannelPlugin, resolveAccountOperatorIds } from "../src/channel";
import {
  classifySystemNotice, shouldSuppressGroupSystemNotice,
} from "../src/system-notice";
import type { RuntimeMap } from "../src/types";
import { forgetAccount, rememberAccount } from "../src/account-registry";

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

  it("keeps the telemetry in a DM to a named operator", () => {
    const toOperator = { targetKind: "user" as const, text: notice, to: "100200300", operatorIds: [ "100200300" ] };
    assert.equal(shouldSuppressGroupSystemNotice(toOperator), undefined);
  });

  it("suppresses it in a DM to anyone else", () => {
    // A DM is not the operator's console: it is open to everyone in allowFrom,
    // and a stranger whose turn tripped a tool used to receive the full shell
    // command and secret-store paths (A5-11).
    assert.equal(
      shouldSuppressGroupSystemNotice({ targetKind: "user", text: notice, to: "999", operatorIds: [ "100200300" ] }),
      "message-failed",
    );
  });

  it("suppresses it when no operator is named at all", () => {
    // Empty or wildcard means "the operator is not identified", and telemetry
    // to an unidentified reader is exactly the leak. Losing the diagnostic is
    // cheaper: the same failure sits in the run diagnostics and the gateway log.
    assert.equal(shouldSuppressGroupSystemNotice({ targetKind: "user", text: notice, to: "100200300" }), "message-failed");
    assert.equal(
      shouldSuppressGroupSystemNotice({ targetKind: "user", text: notice, to: "100200300", operatorIds: [ "*" ] }),
      "message-failed",
    );
    assert.equal(shouldSuppressGroupSystemNotice({ targetKind: undefined, text: notice }), "message-failed");
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

  it("the same notice reaches a DM only when that person is the named operator", async () => {
    const { sent, channel } = makeChannel();
    rememberAccount("default", { sendChats: undefined, operatorIds: [ "100200300" ] });
    try {
      const toOperator = await channel.outbound.sendText({
        accountId: "default",
        to: "100200300",
        text: "⚠️ ✉️ Message failed",
      });
      assert.equal(sent.length, 1);
      assert.equal((toOperator as any)?.ok, true);

      // Тот же текст постороннему — утечка раскладки инфраструктуры (A5-11).
      const toStranger = await channel.outbound.sendText({
        accountId: "default",
        to: "999000111",
        text: "⚠️ 🛠️ Bash failed: cat /opt/openclaw-secrets/secrets.json",
      });
      assert.equal(sent.length, 1, "уведомление ушло постороннему");
      assert.equal((toStranger as any)?.skipped, "system-notice");
    } finally {
      forgetAccount("default");
    }
  });

  it("with no operator named, a DM notice is suppressed too", async () => {
    const { sent, channel } = makeChannel();
    const result = await channel.outbound.sendText({
      accountId: "default",
      to: "100200300",
      text: "⚠️ ✉️ Message failed",
    });
    assert.equal(sent.length, 0);
    assert.equal((result as any)?.skipped, "system-notice");
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


describe("who counts as an operator", () => {
  it("only an explicit operatorIds list — allowFrom is not a fallback (D2-03)", () => {
    const cfgAllowOnly = { channels: { clawgram: { accounts: { default: { allowFrom: [ "100200300", "999" ] } } } } };
    assert.deepEqual(resolveAccountOperatorIds(cfgAllowOnly, "default"), [],
      "every allowed sender used to become an operator and receive secret-store paths");
    const cfgExplicit = { channels: { clawgram: { accounts: { default: { allowFrom: [ "*" ], operatorIds: [ " 100200300 " ] } } } } };
    assert.deepEqual(resolveAccountOperatorIds(cfgExplicit, "default"), [ "100200300" ]);
  });
});

describe("the direct-reply path filters core notices too", () => {
  it("the DM deliver closure calls the same filter as the group path (B5-01)", () => {
    // Wiring ratchet: the DM `deliver` lives inside handleInboundEvent's
    // closure behind core's dispatcher, which has no seam for a fake yet.
    // The filter function itself is covered above; this pins that the
    // direct branch calls it with targetKind "user" and the account's
    // operators, so a future split cannot drop it again (A5-11 did).
    const src = readFileSync(path.join(__dirname, "..", "..", "src", "inbound-pipeline.ts"), "utf8");
    const directBranch = src.slice(src.indexOf("suppressing silent direct reply"));
    assert.match(directBranch, /shouldSuppressGroupSystemNotice\(\{\s*targetKind: "user",\s*text: visibleText,\s*to: normalized\.chatId,\s*operatorIds: operatorIdsFor\(accountId\)/);
    assert.match(directBranch, /suppressing system notice in direct reply/);
  });
});
