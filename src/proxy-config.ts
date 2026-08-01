import type { TelegramClient } from "telegram";

type TelegramClientParams = ConstructorParameters<typeof TelegramClient>[3];

/**
 * GramJS SOCKS proxy shape, derived from the public TelegramClient constructor.
 *
 * GramJS decides between MTProxy and SOCKS with `"MTProxy" in proxy`, so a SOCKS
 * proxy must never carry an `MTProxy` key — not even `MTProxy: false`. `secret`
 * belongs to Telegram MTProxy only and is intentionally unsupported here.
 */
export type TelegramProxyConfig = Extract<NonNullable<TelegramClientParams["proxy"]>, {
  socksType: 4 | 5;
}>;

export type TelegramClientOptions = {
  connectionRetries: number;
  proxy?: TelegramProxyConfig;
};

const CONNECTION_RETRIES = 5;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toFiniteNumber(value: unknown): number {
  if (typeof value === "number") {
    return value;
  }

  if (typeof value === "string" && value.trim()) {
    return Number(value.trim());
  }

  return Number.NaN;
}

function resolveProxyHost(value: unknown): string {
  const host = typeof value === "string" ? value.trim() : "";
  if (!host) {
    throw new Error("telegram-userbot: proxy.ip must be a non-empty hostname or IP address.");
  }

  return host;
}

function resolveProxyPort(value: unknown): number {
  const port = toFiniteNumber(value);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error("telegram-userbot: proxy.port must be an integer between 1 and 65535.");
  }

  return port;
}

function resolveSocksType(value: unknown): 4 | 5 {
  const socksType = toFiniteNumber(value);
  if (socksType !== 4 && socksType !== 5) {
    throw new Error("telegram-userbot: proxy.socksType must be 4 (SOCKS4) or 5 (SOCKS5).");
  }

  return socksType;
}

function resolveProxyCredential(value: unknown, field: "username" | "password"): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (typeof value !== "string") {
    throw new Error(`telegram-userbot: proxy.${field} must be a string.`);
  }

  return value.trim() ? value : undefined;
}

function resolveProxyTimeout(value: unknown): number | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  const timeout = toFiniteNumber(value);
  if (!Number.isFinite(timeout) || timeout <= 0) {
    throw new Error("telegram-userbot: proxy.timeout must be a positive number of seconds.");
  }

  return timeout;
}

/**
 * Normalizes and validates the optional per-account `proxy` config.
 * Returns `undefined` when no proxy is configured; throws when one is
 * configured but unusable, so a broken proxy never silently falls back to a
 * direct connection.
 */
function resolveProxyConfig(value: unknown): TelegramProxyConfig | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }

  if (!isPlainObject(value)) {
    throw new Error("telegram-userbot: proxy must be an object.");
  }

  const ip = resolveProxyHost(value.ip);
  const port = resolveProxyPort(value.port);
  const socksType = resolveSocksType(value.socksType);
  const username = resolveProxyCredential(value.username, "username");
  const password = resolveProxyCredential(value.password, "password");
  const timeout = resolveProxyTimeout(value.timeout);

  return {
    ip,
    port,
    socksType,
    ...(username ? { username } : {}),
    ...(password ? { password } : {}),
    ...(timeout !== undefined ? { timeout } : {}),
  };
}

/**
 * Builds the TelegramClient options. Without a proxy the options stay exactly as
 * before this feature existed.
 */
function buildTelegramClientOptions(proxy: unknown): TelegramClientOptions {
  const resolved = resolveProxyConfig(proxy);
  if (!resolved) {
    return {
      connectionRetries: CONNECTION_RETRIES,
    };
  }

  return {
    connectionRetries: CONNECTION_RETRIES,
    proxy: resolved,
  };
}

/** Credential-free proxy summary safe to log. */
function describeProxy(proxy: TelegramProxyConfig | undefined): string | undefined {
  return proxy ? `socks${proxy.socksType}` : undefined;
}

export {
  resolveProxyConfig,
  buildTelegramClientOptions,
  describeProxy,
};
