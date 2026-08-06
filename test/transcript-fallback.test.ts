import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";
import { readLatestAssistantFallbackFromTranscript } from "../src/helpers";

/**
 * The fallback exists to salvage a reply that was written to the transcript
 * but lost on the way out through stdout. What it must never do is reach
 * further back: on a turn that aborted with zero output, the newest
 * assistant entry is by definition from an EARLIER turn, and sending it
 * again produces a duplicate of an old message addressed to a new one.
 *
 * That was not hypothetical. 2026-08-06: a turn tripped over a dead
 * background workflow, aborted in 664ms with zero bytes, and the fallback
 * re-sent the previous reply — twice, to two different questions
 * (note 0054 in the control repo).
 */

const NOW = Date.parse("2026-08-06T16:17:10.000Z");
const EARLIER = "2026-08-06T16:15:00.000Z";
const DURING = "2026-08-06T16:17:15.000Z";

function transcriptSetup(entries: Array<Record<string, unknown>>) {
  const dir = mkdtempSync(path.join(tmpdir(), "clawgram-fallback-"));
  const storePath = path.join(dir, "sessions.json");
  const sessionId = "test-session";
  writeFileSync(storePath, JSON.stringify({ "agent:main:probe": { sessionId } }));
  writeFileSync(
    path.join(dir, `${sessionId}.jsonl`),
    entries.map((entry) => JSON.stringify(entry)).join("\n") + "\n",
  );
  return storePath;
}

function assistantEntry(text: string, timestamp?: string) {
  return {
    type: "message",
    ...(timestamp ? { timestamp } : {}),
    message: { role: "assistant", content: [ { type: "text", text } ] },
  };
}

describe("readLatestAssistantFallbackFromTranscript: turn boundary", () => {
  test("salvages a reply written during the current turn", () => {
    const storePath = transcriptSetup([
      assistantEntry("прошлый ответ", EARLIER),
      assistantEntry("ответ этого хода", DURING),
    ]);
    assert.equal(
      readLatestAssistantFallbackFromTranscript("agent:main:probe", storePath, NOW),
      "ответ этого хода",
    );
  });

  test("refuses a reply older than the turn — the duplicate scenario", () => {
    const storePath = transcriptSetup([
      assistantEntry("Запустила глубокое исследование — займёт время", EARLIER),
    ]);
    assert.equal(
      readLatestAssistantFallbackFromTranscript("agent:main:probe", storePath, NOW),
      undefined,
    );
  });

  test("does not skip past an old entry to an even older one", () => {
    const storePath = transcriptSetup([
      assistantEntry("совсем старый", "2026-08-06T12:00:00.000Z"),
      assistantEntry("просто старый", EARLIER),
    ]);
    assert.equal(
      readLatestAssistantFallbackFromTranscript("agent:main:probe", storePath, NOW),
      undefined,
    );
  });

  test("an entry without a timestamp cannot prove it is fresh, so it does not count", () => {
    const storePath = transcriptSetup([ assistantEntry("без даты") ]);
    assert.equal(
      readLatestAssistantFallbackFromTranscript("agent:main:probe", storePath, NOW),
      undefined,
    );
  });

  test("without a boundary the old behaviour stands (legacy callers, none in channel.ts)", () => {
    const storePath = transcriptSetup([ assistantEntry("прошлый ответ", EARLIER) ]);
    assert.equal(
      readLatestAssistantFallbackFromTranscript("agent:main:probe", storePath),
      "прошлый ответ",
    );
  });
});

// Static guard, same reasoning as the reply-quote wiring test: nothing in the
// type system forces the call site to pass the boundary, and dropping the
// argument silently restores the duplicate bug.
describe("fallback call site wiring", () => {
  test("channel.ts passes the dispatch start to the fallback", () => {
    const source = readFileSync(path.resolve(__dirname, "..", "..", "src", "channel.ts"), "utf8");
    assert.ok(
      /readLatestAssistantFallbackFromTranscript\(\s*route\.sessionKey,\s*storePath,\s*dispatchStartedAt\s*\)/.test(source),
      "expected the call site to pass dispatchStartedAt",
    );
    assert.ok(source.includes("const dispatchStartedAt = Date.now()"));
  });
});
