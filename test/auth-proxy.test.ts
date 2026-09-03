import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";

import { buildTelegramClientOptions } from "../src/proxy-config";

/**
 * The `--auth` login carries the phone number, the code and the 2FA password.
 * It built its own `TelegramClient` and read no proxy at all, so on a
 * deployment whose entire point is that Telegram never sees the host's address
 * the login handshake went out from exactly that address.
 *
 * The flow itself needs live credentials and cannot run here, so the wiring is
 * asserted statically — the same technique the no-secret-logging suite uses —
 * plus the behaviour of the options builder it now calls.
 */
const SRC = path.resolve(__dirname, "..", "..", "src");
const cliCore = readFileSync(path.join(SRC, "cli-core.ts"), "utf8");

describe("the auth flow connects the way the account does", () => {
  test("the client is built from the shared proxy options builder", () => {
    assert.match(cliCore, /buildTelegramClientOptions\(proxy\)/);
    assert.match(cliCore, /new TelegramClient\(new StringSession\(""\), apiId, apiHash, clientOptions\)/);
    assert.doesNotMatch(
      cliCore,
      /new TelegramClient\([\s\S]{0,120}connectionRetries: 5,\s*\}\)/,
      "the hand-rolled options object is what skipped the proxy",
    );
  });

  test("the account's proxy is looked up before the login, not after", () => {
    assert.match(cliCore, /resolveAuthProxy\(config, authAccountId\)/);
    assert.match(cliCore, /accounts\?\.\[ accountId \]\?\.proxy/);
  });

  test("an account with a proxy yields client options carrying it", () => {
    const options = buildTelegramClientOptions({
      ip: "proxy.example.com",
      port: 1080,
      socksType: 5,
    });

    assert.equal(options.proxy?.socksType, 5);
    assert.equal(options.proxy?.ip, "proxy.example.com");
  });

  test("an account without a proxy still connects directly, as before", () => {
    assert.equal(buildTelegramClientOptions(undefined).proxy, undefined);
  });

  test("an unresolved SecretRef refuses rather than falling back to a direct connection", () => {
    // `--auth` has no secret resolver, so a proxy password held in the store
    // cannot be substituted here. Failing is the correct outcome: the
    // alternative is a login handshake leaving from the host's own address.
    assert.throws(
      () => buildTelegramClientOptions({
        ip: "proxy.example.com",
        port: 1080,
        socksType: 5,
        password: { source: "file", provider: "corp", id: "/integrations/proxy/password" },
      }),
      /unresolved secret reference/,
    );

    // A malformed credential is refused too — never silently dropped, which
    // would leave a proxy configured without the password it needs.
    assert.throws(
      () => buildTelegramClientOptions({
        ip: "proxy.example.com",
        port: 1080,
        socksType: 5,
        password: { id: "/integrations/proxy/password" },
      }),
      /must be a string or a secret reference/,
    );
  });
});
