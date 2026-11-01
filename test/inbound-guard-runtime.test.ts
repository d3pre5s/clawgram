import { strict as assert } from "node:assert";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInboundGuard, resolveGuardOwner, registerInboundGuardStatus } from "../src/inbound-guard-runtime";
import { InboundGuard } from "../src/inbound-guard";
import { GramJsClientManager } from "../src/gramjs-client";
import { handleInboundEvent } from "../src/inbound-pipeline";

const config = () => ({ commands: { ownerAllowFrom: [ "clawgram:100" ] }, channels: { clawgram: { accounts: {
  default: { inboundGuard: { enabled: true }, allowFrom: [ "100" ], readChats: [ "100" ], operatorIds: [ "200" ] },
} } } });

test("owner resolution uses verified numeric owner entries, never operatorIds", () => {
  const cfg = config(); assert.equal(resolveGuardOwner(cfg, "default"), "100");
  cfg.commands.ownerAllowFrom = []; assert.throws(() => resolveGuardOwner(cfg, "default"));
  cfg.commands.ownerAllowFrom = [ "clawgram:100", "clawgram:200" ]; assert.throws(() => resolveGuardOwner(cfg, "default"));
  cfg.commands.ownerAllowFrom = [ "clawgram:100" ]; cfg.channels.clawgram.accounts.default.readChats = [];
  assert.throws(() => resolveGuardOwner(cfg, "default"));
});

test("status RPC requires read scope and does not accept recovery payloads", async () => {
  let registered: any;
  registerInboundGuardStatus({ registerGatewayMethod: (...args: any[]) => { registered = args; } }, new Map());
  assert.equal(registered[0], "clawgram.inboundGuard.status"); assert.equal(registered[2].scope, "operator.read");
  let response: any[];
  await registered[1]({ params: { message: "inject" }, respond: (...args: any[]) => { response = args; } });
  assert.equal(response![0], false);
  await registered[1]({ params: {}, respond: (...args: any[]) => { response = args; } });
  assert.deepEqual(response![1], { version: 1, accounts: [] });
});

test("raw history preserves message methods and queries in ascending order", async () => {
  const message = { id: 12, getReplyMessage: async () => ({ id: 1 }) };
  const queries: any[] = [];
  const manager: any = Object.create(GramJsClientManager.prototype);
  manager.resolvePeer = async () => ({ peer: "peer" });
  manager.client = { getMessages: async (_peer: any, args: any) => { queries.push(args); return [message]; } };
  const rows = await manager.readGuardHistory("100", { after: 0, since: 2000000, limit: 100 });
  assert.equal(rows[0], message); assert.equal(typeof rows[0].getReplyMessage, "function");
  assert.deepEqual(queries[0], { reverse: true, minId: 0, offsetDate: 1999, limit: 100 });
  await manager.readGuardHistory("100", { after: 12, since: 2000000, limit: 100 });
  assert.deepEqual(queries[1], { reverse: true, minId: 12, limit: 100 });
});

test("a swallowed inbound failure is reported to the guard", async () => {
  let errors = 0;
  await handleInboundEvent({ message: { id: 1, chatId: "100", senderId: "100", message: "hello", date: 1 } }, {
    accountId: "default", cfg: config(), client: {}, gram: {}, channelRuntime: {}, runtimes: new Map(),
    selfId: "900", selfLabel: "agent", selfUsername: "agent", log: {}, onInboundError: () => { errors++; },
  });
  assert.equal(errors, 1);
});

test("disable and re-enable never recover an already handled unjournalled DM", async t => {
  const root = mkdtempSync(join(tmpdir(), "inbound-runtime-"));
  const previous = process.env.OPENCLAW_STATE_DIR;
  process.env.OPENCLAW_STATE_DIR = root;
  t.after(() => { if (previous === undefined) delete process.env.OPENCLAW_STATE_DIR; else process.env.OPENCLAW_STATE_DIR = previous; rmSync(root, { recursive: true, force: true }); });
  let now = Date.parse("2026-01-01T12:00:00Z");
  t.mock.method(Date, "now", () => now);
  const cfg = config(); let calls = 0;
  const message = { id: 10, chatId: "100", senderId: "100", peerId: { userId: "100" }, date: now / 1000 + 1, message: "hello" };
  const args = { cfg, accountId: "default", selfId: "900", readPage: async (_owner: string, params: { after: number }) => params.after < 10 ? [message] : [], dispatch: async () => { calls++; return true; } };
  const first = createInboundGuard(args); first.stop();
  cfg.channels.clawgram.accounts.default.inboundGuard.enabled = false;
  const disabled = createInboundGuard(args); await disabled.accept({ message }); disabled.stop();
  cfg.channels.clawgram.accounts.default.inboundGuard.enabled = true; now += 120000;
  const next = createInboundGuard(args); assert.ok(next instanceof InboundGuard);
  await next.accept({ message }); await next.check();
  assert.equal(calls, 1); assert.equal(next.status().uncertainCount, 1); next.stop();
});
