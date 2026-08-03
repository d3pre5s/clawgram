import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

import {
  applyAccountSecrets,
  collectAccountSecretRefs,
  hasUnresolvedSecretRef,
  readSecretInput,
  secretRefKey,
} from "../src/secret-refs";

const REF = { source: "file", provider: "corp", id: "/integrations/telegram/api-hash" };

describe("secretRefKey", () => {
  // Must match how OpenClaw keys its resolution map, or every lookup misses
  // and every secret silently looks unresolvable.
  it("matches the source:provider:id form OpenClaw resolves by", () => {
    assert.equal(secretRefKey(REF as any), "file:corp:/integrations/telegram/api-hash");
  });
});

describe("collectAccountSecretRefs", () => {
  it("finds nothing in an account that uses plain strings", () => {
    const refs = collectAccountSecretRefs({
      apiHash: "plain",
      sessionString: "plain",
      proxy: { ip: "10.0.0.1", port: 1080, socksType: 5, username: "u", password: "p" },
    });

    assert.deepEqual(refs, []);
  });

  it("collects a reference from apiHash", () => {
    const refs = collectAccountSecretRefs({ apiHash: REF });

    assert.equal(refs.length, 1);
    assert.equal(refs[ 0 ].id, REF.id);
  });

  it("collects references from every credential field, proxy included", () => {
    const refs = collectAccountSecretRefs({
      apiHash: { source: "file", provider: "corp", id: "/a" },
      sessionString: { source: "file", provider: "corp", id: "/b" },
      proxy: {
        ip: "10.0.0.1",
        port: 1080,
        socksType: 5,
        username: { source: "env", provider: "default", id: "PROXY_USER" },
        password: { source: "env", provider: "default", id: "PROXY_PASS" },
      },
    });

    assert.deepEqual(refs.map((ref) => ref.id).sort(), [ "/a", "/b", "PROXY_PASS", "PROXY_USER" ]);
  });

  it("reports the same reference once even when two fields share it", () => {
    const refs = collectAccountSecretRefs({ apiHash: REF, sessionString: { ...REF } });

    assert.equal(refs.length, 1);
  });

  it("ignores objects that only look like references", () => {
    const refs = collectAccountSecretRefs({
      apiHash: { source: "file", provider: "corp" },
      sessionString: { id: "/b" },
    });

    assert.deepEqual(refs, []);
  });

  it("survives an account with no proxy and no credentials", () => {
    assert.deepEqual(collectAccountSecretRefs({}), []);
    assert.deepEqual(collectAccountSecretRefs(undefined), []);
  });
});

describe("applyAccountSecrets", () => {
  it("substitutes resolved values in place", () => {
    const { account, missing } = applyAccountSecrets(
      { apiId: 1, apiHash: REF, sessionString: "plain" },
      new Map([ [ secretRefKey(REF as any), "resolved-hash" ] ]),
    );

    assert.equal(account.apiHash, "resolved-hash");
    assert.equal(account.sessionString, "plain");
    assert.deepEqual(missing, []);
  });

  it("substitutes proxy credentials without disturbing the rest of the proxy", () => {
    const userRef = { source: "env", provider: "default", id: "PROXY_USER" };
    const { account } = applyAccountSecrets(
      { proxy: { ip: "10.0.0.1", port: 1080, socksType: 5, username: userRef, password: "kept" } },
      new Map([ [ secretRefKey(userRef as any), "resolved-user" ] ]),
    );

    assert.equal(account.proxy.username, "resolved-user");
    assert.equal(account.proxy.password, "kept");
    assert.equal(account.proxy.ip, "10.0.0.1");
    assert.equal(account.proxy.port, 1080);
  });

  // The failure this prevents is the ugly one: an unresolved ref stringifies to
  // "[object Object]" and Telegram rejects the login with a message about a bad
  // api_hash, sending the reader off to check their credentials.
  it("names the fields it could not resolve instead of stringifying them", () => {
    const { account, missing } = applyAccountSecrets({ apiHash: REF }, new Map());

    assert.deepEqual(missing, [ "apiHash" ]);
    assert.notEqual(account.apiHash, "[object Object]");
  });

  it("reports every unresolved field, not just the first", () => {
    const { missing } = applyAccountSecrets({
      apiHash: { source: "file", provider: "corp", id: "/a" },
      sessionString: { source: "file", provider: "corp", id: "/b" },
      proxy: { username: { source: "file", provider: "corp", id: "/c" } },
    }, new Map());

    assert.deepEqual(missing.sort(), [ "apiHash", "proxy.username", "sessionString" ]);
  });

  it("treats a non-string resolved value as unresolved rather than coercing it", () => {
    const { missing } = applyAccountSecrets(
      { apiHash: REF },
      new Map([ [ secretRefKey(REF as any), { nested: "object" } ] ]),
    );

    assert.deepEqual(missing, [ "apiHash" ]);
  });

  it("leaves an account of plain strings untouched", () => {
    const original = { apiId: 1, apiHash: "h", sessionString: "s" };
    const { account, missing } = applyAccountSecrets(original, new Map());

    assert.deepEqual(account, original);
    assert.deepEqual(missing, []);
  });

  it("does not mutate the config object it was given", () => {
    const original: any = { apiHash: REF };
    applyAccountSecrets(original, new Map([ [ secretRefKey(REF as any), "resolved" ] ]));

    assert.deepEqual(original.apiHash, REF);
  });
});

describe("hasUnresolvedSecretRef", () => {
  // Credentials must never reach a log or an error message, so the check that
  // guards them works on shape alone.
  it("spots a reference left in a credential field", () => {
    assert.equal(hasUnresolvedSecretRef({ apiHash: REF }), true);
    assert.equal(hasUnresolvedSecretRef({ proxy: { password: REF } }), true);
  });

  it("is false once everything is a string", () => {
    assert.equal(hasUnresolvedSecretRef({ apiHash: "h", sessionString: "s" }), false);
  });
});

describe("readSecretInput", () => {
  it("passes a plain string through", () => {
    assert.equal(readSecretInput("value"), "value");
  });

  it("turns absence into an empty string, as the config reader always has", () => {
    assert.equal(readSecretInput(undefined), "");
    assert.equal(readSecretInput(null), "");
  });

  // The bug this exists to prevent: String(ref) is "[object Object]", which
  // travels all the way into a Telegram login and comes back as a complaint
  // about the credential rather than about the missing secret.
  it("keeps a reference intact instead of stringifying it", () => {
    assert.deepEqual(readSecretInput(REF), REF);
  });

  it("stringifies anything else, preserving the old behaviour", () => {
    assert.equal(readSecretInput(42), "42");
  });
});

describe("the client refuses unresolved references", () => {
  // Defence in depth. If a reference ever reached GramJS it would be sent as
  // the literal "[object Object]" — a credential-shaped value going to
  // Telegram, and an error message pointing at the wrong thing.
  it("throws instead of logging in with a reference as the api hash", async () => {
    const { GramJsClientManager } = await import("../src/gramjs-client.js");

    assert.throws(
      () => new GramJsClientManager({
        apiId: 1,
        apiHash: REF,
        sessionString: "s",
        allowFrom: [],
        groups: {},
      } as any),
      /unresolved secret references/,
    );
  });

  it("throws when only a proxy credential is unresolved", async () => {
    const { GramJsClientManager } = await import("../src/gramjs-client.js");

    assert.throws(
      () => new GramJsClientManager({
        apiId: 1,
        apiHash: "h",
        sessionString: "s",
        allowFrom: [],
        groups: {},
        proxy: { ip: "10.0.0.1", port: 1080, socksType: 5, password: REF },
      } as any),
      /unresolved secret references/,
    );
  });
});
