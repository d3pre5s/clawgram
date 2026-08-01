import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test, { describe } from "node:test";
import { validateJsonSchemaValue } from "openclaw/plugin-sdk/config-schema";

const MANIFEST_PATH = path.resolve(__dirname, "..", "..", "openclaw.plugin.json");
const manifest = JSON.parse(readFileSync(MANIFEST_PATH, "utf8"));
const channelSchema = manifest.channelConfigs[ "telegram-userbot" ].schema;
const channelUiHints = manifest.channelConfigs[ "telegram-userbot" ].uiHints;

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
    cacheKey: "telegram-userbot:test:channel-config",
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
