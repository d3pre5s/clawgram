import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import { normalizeParseMode } from "../src/helpers";

/**
 * parseMode reaches GramJS and therefore a live human's screen: an unknown
 * mode must fail at the action boundary, not silently deliver markup as
 * literal text. Absence must keep the pre-2.3.0 plain-text behaviour for
 * every existing caller.
 */
describe("normalizeParseMode", () => {
  it("absent, null and empty mean plain text — the pre-2.3.0 behaviour", () => {
    assert.equal(normalizeParseMode(undefined), undefined);
    assert.equal(normalizeParseMode(null), undefined);
    assert.equal(normalizeParseMode(""), undefined);
  });

  it("accepts markdown under both spellings, case-insensitively", () => {
    assert.equal(normalizeParseMode("md"), "markdown");
    assert.equal(normalizeParseMode("markdown"), "markdown");
    assert.equal(normalizeParseMode("Markdown"), "markdown");
  });

  it("accepts html", () => {
    assert.equal(normalizeParseMode("html"), "html");
    assert.equal(normalizeParseMode("HTML"), "html");
  });

  it("refuses anything else loudly", () => {
    assert.throws(() => normalizeParseMode("bbcode"), /invalid parseMode/);
    assert.throws(() => normalizeParseMode("markdownv2"), /invalid parseMode/);
  });
});

import { resolveOutboundParseMode, resolveReplyParseMode } from "../src/helpers";

describe("resolveReplyParseMode (reply pipeline, 2.3.1)", () => {
  const withMode = (m: unknown) => ({ channels: { clawgram: { accounts: { default: { replyParseMode: m } } } } });

  it("absent means plain text — pre-2.3.1 behaviour", () => {
    assert.equal(resolveReplyParseMode({ channels: { clawgram: { accounts: { default: {} } } } }, "default"), undefined);
    assert.equal(resolveReplyParseMode({}, "default"), undefined);
  });

  it("reads markdown and html from the account config", () => {
    assert.equal(resolveReplyParseMode(withMode("markdown"), "default"), "markdown");
    assert.equal(resolveReplyParseMode(withMode("md"), "default"), "markdown");
    assert.equal(resolveReplyParseMode(withMode("html"), "default"), "html");
  });

  it("falls back to the channel level when no account entry exists", () => {
    assert.equal(resolveReplyParseMode({ channels: { clawgram: { replyParseMode: "html" } } }, "default"), "html");
  });

  it("throws on an invalid value at config-read time", () => {
    assert.throws(() => resolveReplyParseMode(withMode("bbcode"), "default"), /invalid parseMode/);
  });
});

import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";

/**
 * resolveAccount builds PluginConfig field by field, so a setting missing
 * from that list is silently dropped between a valid config and the client
 * that reads it — which is exactly how 2.3.1 shipped a working, deployed and
 * completely inert replyParseMode.
 */
describe("resolveAccount carries the reply format through", () => {
  const channel = createChannelPlugin(new Map() as RuntimeMap) as any;
  const cfgWith = (mode: unknown) => ({
    channels: { clawgram: { accounts: { default: {
      apiId: 1, apiHash: "h", sessionString: "s", allowFrom: ["*"], replyParseMode: mode,
    } } } },
  });

  it("keeps replyParseMode on the resolved account", () => {
    const resolved = channel.config.resolveAccount(cfgWith("markdown"), "default");
    assert.equal(resolved.replyParseMode, "markdown");
  });

  it("leaves it undefined when unset", () => {
    const resolved = channel.config.resolveAccount(
      { channels: { clawgram: { accounts: { default: { apiId: 1, apiHash: "h", sessionString: "s" } } } } },
      "default",
    );
    assert.equal(resolved.replyParseMode, undefined);
  });
});

import { GramJsClientManager } from "../src/gramjs-client";

/**
 * The last unproven link in the chain: does sendText actually hand parseMode
 * to GramJS? Three releases were spent on layers above this one, each correct
 * in isolation, so this asserts on the call itself.
 */
describe("sendText hands parseMode to GramJS", () => {
  // The constructor builds a real StringSession, which a unit test has no
  // business creating: the object is built from the prototype so the method
  // and the getter can be exercised on their own.
  const build = (replyParseMode?: string) => {
    const mgr = Object.create(GramJsClientManager.prototype) as any;
    mgr.config = { apiId: 1, apiHash: "h", sessionString: "s", allowFrom: ["*"], groups: {},
      ...(replyParseMode ? { replyParseMode } : {}) };
    const calls: any[] = [];
    (mgr as any).client = { sendMessage: async (_peer: unknown, args: unknown) => { calls.push(args); return { id: 1 }; } };
    (mgr as any).resolvePeer = async () => ({ peer: {}, messageThreadId: undefined });
    return { mgr, calls };
  };

  it("passes md for markdown", async () => {
    const { mgr, calls } = build();
    await mgr.sendText({ target: "x", text: "[a](u)", parseMode: "markdown" } as any);
    assert.equal(calls[0].parseMode, "md");
  });

  it("passes html for html", async () => {
    const { mgr, calls } = build();
    await mgr.sendText({ target: "x", text: "<a href=u>a</a>", parseMode: "html" } as any);
    assert.equal(calls[0].parseMode, "html");
  });

  it("omits the key entirely when no mode is given", async () => {
    const { mgr, calls } = build();
    await mgr.sendText({ target: "x", text: "plain" } as any);
    assert.equal("parseMode" in calls[0], false);
  });

  it("exposes the account setting for the reply path", () => {
    const { mgr } = build("markdown");
    assert.equal(mgr.replyParseMode, "markdown");
  });

  it("renders markdown into HTML before an html-mode send (2.15.0)", async () => {
    // This is the last link the 2026-08-12 00:13 report broke on: the text
    // reached GramJS's HTML parser with its markdown untouched, so a work
    // chat read `**Разбор работы…**` asterisks and all.
    const { mgr, calls } = build();
    await mgr.sendText({ target: "x", text: "**жирный** и <a href=\"https://x.y/\">линк</a>", parseMode: "html" } as any);
    assert.equal(calls[0].message, "<b>жирный</b> и <a href=\"https://x.y/\">линк</a>");
    assert.equal(calls[0].parseMode, "html");
  });

  it("leaves markdown-mode and plain text untouched", async () => {
    const { mgr, calls } = build();
    await mgr.sendText({ target: "x", text: "**как есть**", parseMode: "markdown" } as any);
    await mgr.sendText({ target: "x", text: "**как есть**" } as any);
    assert.equal(calls[0].message, "**как есть**");
    assert.equal(calls[1].message, "**как есть**");
  });

  it("passes parseMode: false for none — GramJS's absent is not plain", async () => {
    const { mgr, calls } = build();
    await mgr.sendText({ target: "x", text: "**дословно**", parseMode: "none" } as any);
    assert.equal(calls[0].message, "**дословно**");
    assert.equal(calls[0].parseMode, false);
  });
});

describe("sendMedia captions render like messages (2.15.0)", () => {
  // Captions carry the same agent prose (`caption ?? text` on the outbound
  // path) and used to carry no mode at all — which was not plain text but
  // GramJS's default markdown pass, a third behavior nobody configured.
  const build = () => {
    const mgr = Object.create(GramJsClientManager.prototype) as any;
    mgr.config = { apiId: 1, apiHash: "h", sessionString: "s" };
    const calls: any[] = [];
    (mgr as any).client = { sendFile: async (_peer: unknown, args: unknown) => { calls.push(args); return { id: 1 }; } };
    (mgr as any).resolvePeer = async () => ({ peer: {}, messageThreadId: undefined });
    return { mgr, calls };
  };

  it("renders an html-mode caption", async () => {
    const { mgr, calls } = build();
    await mgr.sendMedia({ target: "x", file: "/tmp/a.png", caption: "**отчёт** за июль", parseMode: "html" } as any);
    assert.equal(calls[0].caption, "<b>отчёт</b> за июль");
    assert.equal(calls[0].parseMode, "html");
  });

  it("keeps an unset mode exactly as before — no key, GramJS default", async () => {
    const { mgr, calls } = build();
    await mgr.sendMedia({ target: "x", file: "/tmp/a.png", caption: "**отчёт**" } as any);
    assert.equal(calls[0].caption, "**отчёт**");
    assert.equal("parseMode" in calls[0], false);
  });

  it("passes parseMode: false for none", async () => {
    const { mgr, calls } = build();
    await mgr.sendMedia({ target: "x", file: "/tmp/a.png", caption: "**дословно**", parseMode: "none" } as any);
    assert.equal(calls[0].caption, "**дословно**");
    assert.equal(calls[0].parseMode, false);
  });
});

/**
 * The account setting used to cover only the reply pipeline. The `send` action
 * took parseMode per call, so a send that omitted it went out as plain text —
 * from an account explicitly configured for HTML.
 *
 * 2026-08-09, 22:30 UTC: a long answer in a work chat arrived with its
 * markdown visible, `**Вне каталога — Telegram**` and all, because that one
 * call omitted the parameter. Two sends half an hour earlier had passed it by
 * hand and rendered correctly — which is the tell: correctness depended on
 * remembering, every single time.
 */
describe("resolveOutboundParseMode (send action, 2.13.0)", () => {
  const cfg = (replyParseMode?: string) => ({
    channels: { clawgram: { accounts: { default: { ...(replyParseMode ? { replyParseMode } : {}) } } } },
  });

  it("falls back to the account setting when the call omits parseMode", () => {
    assert.equal(resolveOutboundParseMode(undefined, cfg("html"), "default"), "html");
    assert.equal(resolveOutboundParseMode({}, cfg("html"), "default"), "html");
  });

  it("lets an explicit per-call value win", () => {
    // A caller that knows its text is markdown must still be able to say so.
    assert.equal(resolveOutboundParseMode({ parseMode: "markdown" }, cfg("html"), "default"), "markdown");
  });

  it("keeps plain text available against a configured account", () => {
    // Empty string is the escape hatch: send this exactly as typed. "none"
    // (2.15.0) is what delivers on that — an undefined mode at the GramJS
    // boundary re-enables GramJS's default markdown parser.
    assert.equal(resolveOutboundParseMode({ parseMode: "" }, cfg("html"), "default"), "none");
    assert.equal(resolveOutboundParseMode({ parseMode: "none" }, cfg("html"), "default"), "none");
  });

  it("stays plain when nothing is configured anywhere", () => {
    assert.equal(resolveOutboundParseMode({}, cfg(), "default"), undefined);
    assert.equal(resolveOutboundParseMode({}, {}, "default"), undefined);
  });

  it("still refuses an invalid per-call value", () => {
    assert.throws(() => resolveOutboundParseMode({ parseMode: "rtf" }, cfg("html"), "default"), /invalid parseMode/);
  });
});
