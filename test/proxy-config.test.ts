import assert from "node:assert/strict";
import test, { describe } from "node:test";
import {
  buildTelegramClientOptions,
  describeProxy,
  resolveProxyConfig,
} from "../src/proxy-config";

const SOCKS5_PROXY = {
  ip: "proxy.example.com",
  port: 1080,
  socksType: 5,
};

const SOCKS4_PROXY = {
  ip: "203.0.113.10",
  port: 1081,
  socksType: 4,
};

describe("buildTelegramClientOptions", () => {
  test("keeps the previous TelegramClient options when no proxy is configured", () => {
    for (const value of [ undefined, null ]) {
      const options = buildTelegramClientOptions(value);

      assert.deepEqual(options, { connectionRetries: 5 });
      assert.equal("proxy" in options, false);
    }
  });

  test("passes a SOCKS5 proxy to GramJS", () => {
    const options = buildTelegramClientOptions(SOCKS5_PROXY);

    assert.deepEqual(options, {
      connectionRetries: 5,
      proxy: {
        ip: "proxy.example.com",
        port: 1080,
        socksType: 5,
      },
    });
  });

  test("passes a SOCKS4 proxy to GramJS", () => {
    const options = buildTelegramClientOptions(SOCKS4_PROXY);

    assert.deepEqual(options, {
      connectionRetries: 5,
      proxy: {
        ip: "203.0.113.10",
        port: 1081,
        socksType: 4,
      },
    });
  });

  test("never sets MTProxy or secret on a SOCKS proxy", () => {
    const options = buildTelegramClientOptions({ ...SOCKS5_PROXY, username: "user", password: "pass" });
    const proxy = options.proxy as unknown as Record<string, unknown>;

    assert.equal("MTProxy" in proxy, false);
    assert.equal("secret" in proxy, false);
  });
});

describe("resolveProxyConfig", () => {
  test("returns undefined when the proxy is absent", () => {
    assert.equal(resolveProxyConfig(undefined), undefined);
    assert.equal(resolveProxyConfig(null), undefined);
  });

  test("preserves optional username, password and timeout", () => {
    const proxy = resolveProxyConfig({
      ...SOCKS5_PROXY,
      username: "proxy-user",
      password: "proxy-pass",
      timeout: 10,
    });

    assert.deepEqual(proxy, {
      ip: "proxy.example.com",
      port: 1080,
      socksType: 5,
      username: "proxy-user",
      password: "proxy-pass",
      timeout: 10,
    });
  });

  test("omits credential keys when they are absent or blank", () => {
    const proxy = resolveProxyConfig({ ...SOCKS5_PROXY, username: "   ", password: "" }) as unknown as Record<string, unknown>;

    assert.equal("username" in proxy, false);
    assert.equal("password" in proxy, false);
    assert.equal("timeout" in proxy, false);
  });

  test("keeps passwords that contain meaningful whitespace", () => {
    const proxy = resolveProxyConfig({ ...SOCKS5_PROXY, password: " pa ss " });

    assert.equal(proxy?.password, " pa ss ");
  });

  test("trims the host", () => {
    const proxy = resolveProxyConfig({ ...SOCKS5_PROXY, ip: "  proxy.example.com  " });

    assert.equal(proxy?.ip, "proxy.example.com");
  });

  test("accepts numeric strings for port and socksType", () => {
    const proxy = resolveProxyConfig({ ip: "proxy.example.com", port: "1080", socksType: "5" });

    assert.equal(proxy?.port, 1080);
    assert.equal(proxy?.socksType, 5);
  });

  test("rejects an invalid socksType", () => {
    for (const socksType of [ 0, 3, 6, "socks5", null ]) {
      assert.throws(
        () => resolveProxyConfig({ ...SOCKS5_PROXY, socksType }),
        /proxy\.socksType must be 4 \(SOCKS4\) or 5 \(SOCKS5\)/,
      );
    }
  });

  test("rejects out-of-range and non-integer ports", () => {
    for (const port of [ 0, -1, 65536, 1080.5, "abc", undefined ]) {
      assert.throws(
        () => resolveProxyConfig({ ...SOCKS5_PROXY, port }),
        /proxy\.port must be an integer between 1 and 65535/,
      );
    }
  });

  test("rejects a missing or empty host", () => {
    for (const ip of [ undefined, "", "   ", 42 ]) {
      assert.throws(
        () => resolveProxyConfig({ ...SOCKS5_PROXY, ip }),
        /proxy\.ip must be a non-empty hostname or IP address/,
      );
    }
  });

  test("rejects a non-positive or non-numeric timeout", () => {
    for (const timeout of [ 0, -1, "soon" ]) {
      assert.throws(
        () => resolveProxyConfig({ ...SOCKS5_PROXY, timeout }),
        /proxy\.timeout must be a positive number of seconds/,
      );
    }
  });

  test("rejects non-string credentials", () => {
    assert.throws(() => resolveProxyConfig({ ...SOCKS5_PROXY, username: 1 }), /proxy\.username must be a string/);
    assert.throws(() => resolveProxyConfig({ ...SOCKS5_PROXY, password: 1 }), /proxy\.password must be a string/);
  });

  test("rejects a non-object proxy", () => {
    for (const value of [ "socks5://proxy.example.com:1080", 1080, [ SOCKS5_PROXY ] ]) {
      assert.throws(() => resolveProxyConfig(value), /proxy must be an object/);
    }
  });

  test("never leaks credentials through validation errors", () => {
    assert.throws(
      () => resolveProxyConfig({ ip: "proxy.example.com", port: 0, socksType: 5, username: "leaky-user", password: "leaky-pass" }),
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        assert.equal(message.includes("leaky-user"), false);
        assert.equal(message.includes("leaky-pass"), false);
        return true;
      },
    );
  });
});

describe("describeProxy", () => {
  test("returns undefined without a proxy", () => {
    assert.equal(describeProxy(undefined), undefined);
  });

  test("reports only the SOCKS version, never credentials or host", () => {
    const proxy = resolveProxyConfig({
      ip: "proxy.example.com",
      port: 1080,
      socksType: 5,
      username: "proxy-user",
      password: "proxy-pass",
    });
    const summary = describeProxy(proxy);

    assert.equal(summary, "socks5");
    for (const secret of [ "proxy-user", "proxy-pass", "proxy.example.com", "1080" ]) {
      assert.equal(String(summary).includes(secret), false);
    }
  });

  test("reports socks4 for SOCKS4 proxies", () => {
    assert.equal(describeProxy(resolveProxyConfig(SOCKS4_PROXY)), "socks4");
  });
});
