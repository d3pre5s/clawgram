import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { InboundGuard } from "../src/inbound-guard";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const epoch = Date.parse("2026-01-01T12:00:00Z");
function harness(over: Record<string, any> = {}) {
  const root = mkdtempSync(join(tmpdir(), "inbound-guard-")); roots.push(root);
  let now = epoch;
  const messages: any[] = [], calls: number[] = [];
  const options = {
    accountId: "default", selfId: "900", ownerId: "100", storePath: join(root, "state.json"),
    now: () => now, allowed: () => true,
    readPage: async ({ after, since, limit }: any) => messages.filter(m => m.id > after && m.date * 1000 >= since).slice(0, limit),
    dispatch: async (event: any) => { calls.push(event.message.id); return true; }, ...over,
  };
  const guard = new InboundGuard(options);
  const add = (id: number, extra = {}) => {
    const m = { id, chatId: "100", senderId: "100", peerId: { userId: "100" }, date: (epoch + 1000) / 1000, message: "private body", ...extra };
    messages.push(m); return { message: m };
  };
  return { guard, calls, add, options, messages, time: (ms: number) => { now = epoch + ms; } };
}

test("recovers a missed DM and rejects the later live duplicate, including after restart", async () => {
  const h = harness(); const event = h.add(11); h.time(120000);
  await h.guard.check(); await h.guard.accept(event);
  assert.deepEqual(h.calls, [11]);
  const restarted = new InboundGuard(h.options); await restarted.accept(event); await restarted.check();
  assert.deepEqual(h.calls, [11]); assert.equal(h.guard.status().recoveredCount, 1);
  assert.equal(readFileSync(h.options.storePath, "utf8").includes("private body"), false);
});

test("live receipt does not move history past an earlier missing message", async () => {
  const h = harness(); h.add(10); const later = h.add(12); h.time(120000);
  await h.guard.accept(later); await h.guard.check(); assert.deepEqual(h.calls, [12, 10]);
});

test("a live call racing the scan shares a claim even while the handler is pending", async () => {
  let finish!: () => void; const pending = new Promise<void>(r => { finish = r; }); let calls = 0;
  const h = harness({ dispatch: async () => { calls++; await pending; return true; } });
  const event = h.add(10); h.time(120000);
  const live = h.guard.accept(event); await h.guard.check(); assert.equal(calls, 1);
  finish(); await live; await h.guard.accept(event); assert.equal(calls, 1);
});

test("grace period does not advance the cursor past an unhandled young message", async () => {
  const h = harness(); h.add(10); h.time(30000); await h.guard.check(); assert.deepEqual(h.calls, []);
  h.time(120000); await h.guard.check(); assert.deepEqual(h.calls, [10]);
});

test("bounded batches keep every unprocessed message for subsequent passes", async () => {
  const h = harness(); for (let i = 1; i <= 12; i++) h.add(i);
  h.time(120000); await h.guard.check(); assert.equal(h.calls.length, 5);
  await h.guard.check(); await h.guard.check(); assert.deepEqual(h.calls, Array.from({ length: 12 }, (_, i) => i + 1));
});

test("failed dispatch is uncertain and is never retried on a new process", async () => {
  let calls = 0; const h = harness({ dispatch: async () => { calls++; return false; } }); h.add(1); h.time(120000);
  await h.guard.check(); const restarted = new InboundGuard(h.options); await restarted.check();
  assert.equal(calls, 1); assert.equal(restarted.status().uncertainCount, 1);
});

test("a persisted unfinished claim is uncertain after restart", async () => {
  let finish!: () => void; const pending = new Promise<void>(r => { finish = r; });
  const h = harness({ dispatch: async () => { await pending; return true; } }); const event = h.add(1);
  const live = h.guard.accept(event); const restarted = new InboundGuard(h.options);
  assert.equal(restarted.status().uncertainCount, 1);
  await restarted.accept(event); finish(); await live;
});

test("old history is excluded on first activation; expired new requests need review", async () => {
  const h = harness(); h.add(1, { date: (epoch - 10000) / 1000 }); h.add(2); h.time(25 * 3600000);
  await h.guard.check(); assert.deepEqual(h.calls, []); assert.equal(h.guard.status().uncertainCount, 1);
});

test("denied access and failed reads never dispatch or skip history", async () => {
  let allowed = false, failed = true;
  const h = harness({ allowed: () => allowed, readPage: async () => { if (failed) throw Error("private endpoint"); return h.messages; } });
  h.add(1); h.time(120000); await h.guard.check(); assert.equal(h.guard.status().errorCode, "access-denied");
  allowed = true; await h.guard.check(); assert.equal(h.guard.status().errorCode, "history-unavailable");
  failed = false; await h.guard.check(); assert.deepEqual(h.calls, [1]);
});

test("corrupt or mismatched state blocks recovery without blocking new live messages", async () => {
  const h = harness(); writeFileSync(h.options.storePath, "broken");
  const broken = new InboundGuard(h.options); const event = h.add(1);
  await broken.check(); assert.equal(broken.status().errorCode, "state-unavailable");
  await broken.accept(event); assert.deepEqual(h.calls, [1]);
});

test("an expired read and a read completed after stop cannot dispatch", async () => {
  let finish!: (rows: any[]) => void;
  const h = harness({ readTimeoutMs: 5, readPage: () => new Promise(r => { finish = r; }) }); h.add(1); h.time(120000);
  await h.guard.check(); assert.equal(h.guard.status().errorCode, "history-unavailable");
  finish(h.messages); await new Promise(r => setImmediate(r)); assert.deepEqual(h.calls, []);
  const checking = h.guard.check(); h.guard.stop(); finish(h.messages); await checking; assert.deepEqual(h.calls, []);
});

test("history with a wrong peer is refused before claiming anything", async () => {
  const h = harness(); h.add(1, { chatId: "200", senderId: "200", peerId: { userId: "200" } }); h.time(120000);
  await h.guard.check(); assert.deepEqual(h.calls, []); assert.equal(h.guard.status().errorCode, "history-invalid");
});

test("pagination crosses outgoing history without losing the next incoming page", async () => {
  const h = harness();
  for (let i = 1; i <= 100; i++) h.add(i, { out: true, senderId: "900" });
  h.add(101); h.time(120000); await h.guard.check(); assert.deepEqual(h.calls, [101]);
});

test("account identity mismatch refuses reuse of a journal", async () => {
  const h = harness(); const mismatched = new InboundGuard({ ...h.options, selfId: "901" });
  assert.equal(mismatched.status().errorCode, "state-unavailable");
});

test("state write failure stops recovery but live messages still reach the pipeline", async () => {
  const h = harness(); const event = h.add(1); h.time(120000);
  // The parent becomes a regular file, making atomic state writes impossible.
  const parent = h.options.storePath.slice(0, h.options.storePath.lastIndexOf('/'));
  rmSync(parent, { recursive: true }); writeFileSync(parent, "not a directory");
  await h.guard.check(); assert.equal(h.guard.status().errorCode, "state-unavailable");
  await h.guard.accept(event); assert.deepEqual(h.calls, [1]);
});

test("a stopping instance cannot overwrite the journal of its replacement", async () => {
  let finish!: () => void; const pending = new Promise<void>(r => { finish = r; });
  const h = harness({ dispatch: async () => { await pending; return true; } });
  const live = h.guard.accept(h.add(1)); h.guard.stop();
  const next = new InboundGuard({ ...h.options, dispatch: async () => true });
  await next.accept(h.add(2)); const saved = readFileSync(h.options.storePath, "utf8");
  finish(); await live; assert.equal(readFileSync(h.options.storePath, "utf8"), saved);
});

test("stopping before the timer fires performs no history read", async () => {
  let reads = 0; const h = harness({ readPage: async () => { reads++; return []; } });
  h.guard.start(); h.guard.stop(); await new Promise(r => setTimeout(r, 5)); assert.equal(reads, 0);
});

test("live receipt remains journalled while recovery permission is revoked", async () => {
  let allowed = false;
  const h = harness({ allowed: () => allowed }); const event = h.add(10); h.time(120000);
  await h.guard.accept(event); allowed = true; await h.guard.check();
  assert.deepEqual(h.calls, [10]); assert.equal(h.guard.status().recoveredCount, 0);
});

test("an unjournalled interval before restart is uncertain, never replayed", async () => {
  const h = harness(); const event = h.add(10); h.guard.stop();
  // Disabled/broken guard: ordinary channel handled the message without a claim.
  await h.options.dispatch(event); h.time(120000);
  const next = new InboundGuard(h.options); await next.check(); await next.accept(event);
  assert.deepEqual(h.calls, [10]); assert.equal(next.status().uncertainCount, 1);
});

test("a late failed history read cannot overwrite the replacement journal", async () => {
  let reject!: (reason: Error) => void;
  const h = harness({ readPage: () => new Promise((_resolve, fail) => { reject = fail; }) });
  const check = h.guard.check(); h.guard.stop();
  const next = new InboundGuard(h.options); await next.accept(h.add(10));
  const saved = readFileSync(h.options.storePath, "utf8");
  reject(new Error("late failure")); await check;
  assert.equal(readFileSync(h.options.storePath, "utf8"), saved);
});
