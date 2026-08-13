import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/config-schema";

const MANIFEST_PATH = path.resolve(__dirname, "..", "..", "openclaw.plugin.json");
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const channelSchema = manifest.channelConfigs[ "clawgram" ].schema;
const channelUiHints = manifest.channelConfigs[ "clawgram" ].uiHints;

const BASE_ACCOUNT = {
  enabled: true,
  apiId: 12345678,
  apiHash: "apiHash",
  sessionString: "sessionString",
  allowFrom: [ "*" ],
};

function validateAccount(account: Record<string, unknown>) {
  return validateJsonSchemaValue({
    schema: channelSchema,
    cacheKey: "clawgram:test:channel-config",
    value: { accounts: { default: account } },
  });
}

type ValidationResult = ReturnType<typeof validateJsonSchemaValue>;

// The repo compiles with `strict: false`, so the `ok` discriminant does not narrow here.
function errorText(result: ValidationResult): string {
  const errors = (result as { errors?: { path?: string; message?: string }[] }).errors;
  if (!errors) {
    return "";
  }

  return errors.map((issue) => `${issue.path}: ${issue.message}`).join("; ");
}

describe("openclaw.plugin.json account proxy schema", () => {
  test("accepts an account without a proxy", () => {
    const result = validateAccount({ ...BASE_ACCOUNT });

    assert.equal(result.ok, true, errorText(result));
  });

  test("accepts a full SOCKS5 proxy", () => {
    const result = validateAccount({
      ...BASE_ACCOUNT,
      proxy: {
        ip: "proxy.example.com",
        port: 1080,
        socksType: 5,
        username: "proxy-user",
        password: "proxy-pass",
        timeout: 10,
      },
    });

    assert.equal(result.ok, true, errorText(result));
  });

  test("accepts a minimal SOCKS4 proxy", () => {
    const result = validateAccount({
      ...BASE_ACCOUNT,
      proxy: {
        ip: "203.0.113.10",
        port: 1081,
        socksType: 4,
      },
    });

    assert.equal(result.ok, true, errorText(result));
  });

  test("rejects an invalid socksType", () => {
    for (const socksType of [ 0, 3, 6, "5" ]) {
      const result = validateAccount({
        ...BASE_ACCOUNT,
        proxy: { ip: "proxy.example.com", port: 1080, socksType },
      });

      assert.equal(result.ok, false, `socksType=${String(socksType)} should be rejected`);
    }
  });

  test("rejects out-of-range ports", () => {
    for (const port of [ 0, -1, 65536, 1080.5 ]) {
      const result = validateAccount({
        ...BASE_ACCOUNT,
        proxy: { ip: "proxy.example.com", port, socksType: 5 },
      });

      assert.equal(result.ok, false, `port=${String(port)} should be rejected`);
    }
  });

  test("rejects an empty or whitespace-only proxy host", () => {
    for (const ip of [ "", "   " ]) {
      const result = validateAccount({
        ...BASE_ACCOUNT,
        proxy: { ip, port: 1080, socksType: 5 },
      });

      assert.equal(result.ok, false, `ip=${JSON.stringify(ip)} should be rejected`);
    }
  });

  test("rejects a non-positive timeout", () => {
    for (const timeout of [ 0, -1 ]) {
      const result = validateAccount({
        ...BASE_ACCOUNT,
        proxy: { ip: "proxy.example.com", port: 1080, socksType: 5, timeout },
      });

      assert.equal(result.ok, false, `timeout=${String(timeout)} should be rejected`);
    }
  });

  test("rejects unknown proxy properties", () => {
    for (const extra of [ { MTProxy: false }, { secret: "deadbeef" }, { host: "proxy.example.com" } ]) {
      const result = validateAccount({
        ...BASE_ACCOUNT,
        proxy: { ip: "proxy.example.com", port: 1080, socksType: 5, ...extra },
      });

      assert.equal(result.ok, false, `${Object.keys(extra)[0]} should be rejected`);
    }
  });

  test("requires ip, port and socksType when a proxy is present", () => {
    const full = { ip: "proxy.example.com", port: 1080, socksType: 5 };

    for (const missing of [ "ip", "port", "socksType" ] as const) {
      const proxy = { ...full };
      delete proxy[ missing ];

      const result = validateAccount({ ...BASE_ACCOUNT, proxy });

      assert.equal(result.ok, false, `missing ${missing} should be rejected`);
    }
  });

  test("keeps additionalProperties disabled for accounts and proxy", () => {
    const accountSchema = channelSchema.properties.accounts.additionalProperties;

    assert.equal(accountSchema.additionalProperties, false);
    assert.equal(accountSchema.properties.proxy.additionalProperties, false);
  });
});

describe("openclaw.plugin.json proxy uiHints", () => {
  test("marks the proxy password as sensitive", () => {
    assert.equal(channelUiHints[ "accounts.*.proxy.password" ].sensitive, true);
  });

  test("documents every proxy field", () => {
    for (const field of [ "ip", "port", "socksType", "username", "password", "timeout" ]) {
      assert.ok(channelUiHints[ `accounts.*.proxy.${field}` ]?.label, `missing uiHint for proxy.${field}`);
    }
  });
});

/**
 * SecretRefs must pass the *schema*, not only the runtime.
 *
 * 2.2.0 shipped the resolver and the docs and left this out, so a config that
 * used a reference was rejected by `openclaw config validate` before the
 * resolver ever ran — the feature could not be turned on at all. Caught while
 * applying it to production, which is exactly the wrong place to find it.
 */
describe("openclaw.plugin.json accepts SecretRefs for credentials", () => {
  const FILE_REF = { source: "file", provider: "corp", id: "/channels/clawgram/api_hash" };

  test("apiHash accepts a file reference", () => {
    const result = validateAccount({ ...BASE_ACCOUNT, apiHash: FILE_REF });
    assert.equal(result.ok, true, errorText(result));
  });

  test("sessionString accepts a file reference", () => {
    const result = validateAccount({ ...BASE_ACCOUNT, sessionString: FILE_REF });
    assert.equal(result.ok, true, errorText(result));
  });

  test("both accept an env reference", () => {
    const envRef = { source: "env", provider: "default", id: "CLAWGRAM_API_HASH" };
    const result = validateAccount({ ...BASE_ACCOUNT, apiHash: envRef, sessionString: envRef });
    assert.equal(result.ok, true, errorText(result));
  });

  test("plain strings still validate", () => {
    const result = validateAccount(BASE_ACCOUNT);
    assert.equal(result.ok, true, errorText(result));
  });

  test("proxy credentials accept references too", () => {
    const result = validateAccount({
      ...BASE_ACCOUNT,
      proxy: { ip: "10.0.0.1", port: 1080, socksType: 5, username: FILE_REF, password: FILE_REF },
    });
    assert.equal(result.ok, true, errorText(result));
  });

  // A typo must not be mistaken for a reference and silently blank a credential.
  test("an incomplete reference is rejected", () => {
    const result = validateAccount({ ...BASE_ACCOUNT, apiHash: { source: "file", provider: "corp" } });
    assert.equal(result.ok, false, "an object without id should not validate");
  });

  test("an unknown source is rejected", () => {
    const result = validateAccount({
      ...BASE_ACCOUNT,
      apiHash: { source: "vault", provider: "corp", id: "/x" },
    });
    assert.equal(result.ok, false, "only env, file and exec are real sources");
  });

  test("a number is still rejected", () => {
    const result = validateAccount({ ...BASE_ACCOUNT, apiHash: 42 });
    assert.equal(result.ok, false, "a credential is a string or a reference, nothing else");
  });
});

/**
 * The plugin declares its version twice — in package.json and in
 * openclaw.plugin.json — and nothing kept them together. Both 2.2.0 and 2.2.1
 * shipped with the manifest still saying 2.1.0; npm reads package.json so it
 * looked fine, and only ClawHub's inspector noticed. Same shape of mistake as
 * the SecretRef schema: one half updated, the other silently left behind.
 */
describe("plugin version is declared consistently", () => {
  test("openclaw.plugin.json matches package.json", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf8"));

    assert.equal(
      manifest.version,
      pkg.version,
      `openclaw.plugin.json says ${manifest.version}, package.json says ${pkg.version} — bump both`,
    );
  });
});

/**
 * A config key the code reads but the manifest schema rejects is worse than
 * a missing feature: `config validate` fails on production and the operator
 * has to roll back a config they were told to write. It happened to
 * `readChats` before 1.3.1 and again to `replyParseMode` on the day 2.3.1
 * shipped — the code honoured it, the schema refused it.
 */
describe("account schema accepts what the code reads", () => {
  test("replyParseMode is allowed with every value the code normalizes", () => {
    for (const mode of [ "markdown", "md", "html" ]) {
      const result = validateAccount({ ...BASE_ACCOUNT, replyParseMode: mode }) as ValidationResult;
      assert.equal(result.ok, true, `expected ${mode} to validate: ${JSON.stringify((result as any).errors ?? [])}`);
    }
  });

  test("replyParseMode is optional — absence stays valid", () => {
    const result = validateAccount({ ...BASE_ACCOUNT }) as ValidationResult;
    assert.equal(result.ok, true);
  });

  test("an unknown parse mode is refused by the schema, not at send time", () => {
    const result = validateAccount({ ...BASE_ACCOUNT, replyParseMode: "bbcode" }) as ValidationResult;
    assert.equal(result.ok, false);
  });

  // The chat-management gate (2.12.0). Same failure mode as readChats before
  // 1.3.1: the code honours the key, so the schema must not refuse it.
  test("manageChats is allowed as a list of chat ids or the wildcard", () => {
    for (const manageChats of [ [ "-100123" ], [ "*" ], [] ]) {
      const result = validateAccount({ ...BASE_ACCOUNT, manageChats }) as ValidationResult;
      assert.equal(result.ok, true, errorText(result));
    }
  });

  test("manageChats entries must be strings", () => {
    const result = validateAccount({ ...BASE_ACCOUNT, manageChats: [ -100123 ] }) as ValidationResult;
    assert.equal(result.ok, false, "a numeric chat id should be written as a string");
  });

  test("twoFaPassword is allowed as a string or a SecretRef", () => {
    const literal = validateAccount({ ...BASE_ACCOUNT, twoFaPassword: "correct horse" }) as ValidationResult;
    assert.equal(literal.ok, true, errorText(literal));

    const ref = validateAccount({
      ...BASE_ACCOUNT,
      twoFaPassword: { source: "file", provider: "corp", id: "/telegram/2fa" },
    }) as ValidationResult;
    assert.equal(ref.ok, true, errorText(ref));

    const number = validateAccount({ ...BASE_ACCOUNT, twoFaPassword: 42 }) as ValidationResult;
    assert.equal(number.ok, false, "a password is a string or a reference, nothing else");
  });
});

describe("openclaw.plugin.json twoFaPassword uiHints", () => {
  // The dashboard must mask this field exactly as it masks the proxy password.
  test("twoFaPassword is marked sensitive", () => {
    assert.equal(channelUiHints[ "accounts.*.twoFaPassword" ]?.sensitive, true);
  });
});

/**
 * The account schema is `additionalProperties: false`, so a config key the
 * manifest does not know about is not ignored — it fails validation and the
 * account never starts. A new capability is therefore only half-added until
 * its switch is in the schema.
 */
describe("chat discovery is a declared account switch", () => {
  test("accepts discoverChats", () => {
    const result = validateAccount({ ...BASE_ACCOUNT, discoverChats: true });

    assert.equal(result.ok, true, errorText(result));
  });

  test("still refuses a key nobody declared", () => {
    const result = validateAccount({ ...BASE_ACCOUNT, discoverEverything: true });

    assert.equal(result.ok, false);
  });
});
