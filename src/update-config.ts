import { promises as fs } from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { CHANNEL_ID } from "./constants";

type TelegramAuthResult = {
  apiId: number;
  apiHash: string;
  sessionString: string;
};

type TextFormat = {
  eol: string;
  indentUnit: string;
};

type ObjectProperty = {
  key: string;
  keyStart: number;
  valueStart: number;
  valueEnd: number;
  valueKind: "object" | "array" | "string" | "scalar";
  delimiter: "," | "}";
};

function formatBackupTimestamp(date: Date): string {
  const year = String(date.getUTCFullYear());
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  const seconds = String(date.getUTCSeconds()).padStart(2, "0");

  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

function buildConfigBackupPath(configPath: string): string {
  const dir = path.dirname(configPath);
  const fileName = path.basename(configPath);
  const suffix = `${formatBackupTimestamp(new Date())}-clawgram-auth`;
  return path.join(dir, `${fileName}.bak-${suffix}`);
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function buildAccountPayload(auth: TelegramAuthResult): Record<string, unknown> {
  return {
    enabled: true,
    apiId: auth.apiId,
    apiHash: auth.apiHash,
    sessionString: auth.sessionString,
  };
}

function buildAccountConfigFragment(auth: TelegramAuthResult): Record<string, unknown> {
  return {
    ...buildAccountPayload(auth),
    allowFrom: [ "*" ],
    groups: {
      "*": {
        enabled: true,
        groupPolicy: "mention",
        allowFrom: [ "*" ],
      },
    },
  };
}

function applyAuthToConfig(config: OpenClawConfig, accountId: string, auth: TelegramAuthResult): OpenClawConfig {
  const channels = config.channels && typeof config.channels === "object" ? config.channels : {};
  const channelConfig = channels[ CHANNEL_ID ] && typeof channels[ CHANNEL_ID ] === "object" ? channels[ CHANNEL_ID ] : {};
  const accounts = channelConfig.accounts && typeof channelConfig.accounts === "object" ? channelConfig.accounts : {};
  const existingAccount = accounts[ accountId ] && typeof accounts[ accountId ] === "object" ? accounts[ accountId ] : {};

  return {
    ...config,
    channels: {
      ...channels,
      [ CHANNEL_ID ]: {
        ...channelConfig,
        accounts: {
          ...accounts,
          [ accountId ]: {
            ...existingAccount,
            ...buildAccountPayload(auth),
            enabled: existingAccount.enabled ?? true,
            allowFrom: existingAccount.allowFrom ?? [ "*" ],
            groups: existingAccount.groups ?? {
              "*": {
                enabled: true,
                groupPolicy: "mention",
                allowFrom: [ "*" ],
              },
            },
          },
        },
      },
    },
  };
}

function detectTextFormat(raw: string): TextFormat {
  const eol = raw.includes("\r\n") ? "\r\n" : "\n";
  const indentMatch = raw.match(/^[ \t]+(?=(?:\"|')?[A-Za-z0-9_$-]+(?:\"|')?\s*:)/m);

  return {
    eol,
    indentUnit: indentMatch?.[0] || "  ",
  };
}

function getLineStart(raw: string, index: number): number {
  const lineStart = raw.lastIndexOf("\n", index - 1);
  return lineStart === -1 ? 0 : lineStart + 1;
}

function getLineIndent(raw: string, index: number): string {
  const lineStart = getLineStart(raw, index);
  let cursor = lineStart;

  while (cursor < raw.length && (raw[cursor] === " " || raw[cursor] === "\t")) {
    cursor += 1;
  }

  return raw.slice(lineStart, cursor);
}

function skipTrivia(raw: string, start: number): number {
  let index = start;

  while (index < raw.length) {
    const char = raw[index];

    if (char === " " || char === "\t" || char === "\n" || char === "\r") {
      index += 1;
      continue;
    }

    if (char === "/" && raw[index + 1] === "/") {
      index += 2;
      while (index < raw.length && raw[index] !== "\n") {
        index += 1;
      }
      continue;
    }

    if (char === "/" && raw[index + 1] === "*") {
      index += 2;
      while (index + 1 < raw.length && !(raw[index] === "*" && raw[index + 1] === "/")) {
        index += 1;
      }
      index = Math.min(index + 2, raw.length);
      continue;
    }

    break;
  }

  return index;
}

function readQuotedString(raw: string, start: number): { value: string; end: number } {
  const quote = raw[start];
  let index = start + 1;

  while (index < raw.length) {
    const char = raw[index];

    if (char === "\\") {
      if (index + 1 >= raw.length) {
        throw new Error("Unterminated escape sequence in config string.");
      }

      index += 2;
      continue;
    }

    if (char === quote) {
      return {
        value: JSON5.parse(raw.slice(start, index + 1)) as string,
        end: index + 1,
      };
    }

    index += 1;
  }

  throw new Error("Unterminated string in config file.");
}

function readIdentifier(raw: string, start: number): { value: string; end: number } | null {
  const first = raw[start];
  if (!/[A-Za-z_$]/.test(first)) {
    return null;
  }

  let end = start + 1;
  while (end < raw.length && /[A-Za-z0-9_$-]/.test(raw[end])) {
    end += 1;
  }

  return {
    value: raw.slice(start, end),
    end,
  };
}

function scanEnclosedValue(raw: string, start: number, openChar: "{" | "[", closeChar: "}" | "]"): number {
  let depth = 1;
  let index = start + 1;

  while (index < raw.length) {
    const char = raw[index];

    if (char === "\"" || char === "'") {
      index = readQuotedString(raw, index).end;
      continue;
    }

    if (char === "/" && raw[index + 1] === "/") {
      index = skipTrivia(raw, index);
      continue;
    }

    if (char === "/" && raw[index + 1] === "*") {
      index = skipTrivia(raw, index);
      continue;
    }

    if (char === openChar) {
      depth += 1;
      index += 1;
      continue;
    }

    if (char === closeChar) {
      depth -= 1;
      index += 1;
      if (depth === 0) {
        return index;
      }
      continue;
    }

    if (openChar === "{" && char === "[") {
      index = scanEnclosedValue(raw, index, "[", "]");
      continue;
    }

    if (openChar === "[" && char === "{") {
      index = scanEnclosedValue(raw, index, "{", "}");
      continue;
    }

    index += 1;
  }

  throw new Error("Unterminated structured value in config file.");
}

function scanValue(raw: string, start: number): { end: number; kind: ObjectProperty["valueKind"] } {
  const char = raw[start];

  if (char === "{") {
    return {
      end: scanEnclosedValue(raw, start, "{", "}"),
      kind: "object",
    };
  }

  if (char === "[") {
    return {
      end: scanEnclosedValue(raw, start, "[", "]"),
      kind: "array",
    };
  }

  if (char === "\"" || char === "'") {
    return {
      end: readQuotedString(raw, start).end,
      kind: "string",
    };
  }

  let end = start;
  while (end < raw.length) {
    const current = raw[end];
    if (
      current === "," ||
      current === "}" ||
      current === "]" ||
      current === "\n" ||
      current === "\r" ||
      current === "\t" ||
      current === " " ||
      (current === "/" && (raw[end + 1] === "/" || raw[end + 1] === "*"))
    ) {
      break;
    }
    end += 1;
  }

  return {
    end,
    kind: "scalar",
  };
}

function findObjectEnd(raw: string, objectStart: number): number {
  return scanEnclosedValue(raw, objectStart, "{", "}");
}

function listObjectProperties(raw: string, objectStart: number): ObjectProperty[] {
  const properties: ObjectProperty[] = [];
  const objectEnd = findObjectEnd(raw, objectStart);
  let cursor = skipTrivia(raw, objectStart + 1);

  while (cursor < objectEnd) {
    if (raw[cursor] === "}") {
      break;
    }

    const keyToken = raw[cursor] === "\"" || raw[cursor] === "'"
      ? readQuotedString(raw, cursor)
      : readIdentifier(raw, cursor);

    if (!keyToken) {
      throw new Error(`Unable to parse config object key near index ${cursor}.`);
    }

    const afterKey = skipTrivia(raw, keyToken.end);
    if (raw[afterKey] !== ":") {
      throw new Error(`Expected ":" after config key "${keyToken.value}".`);
    }

    const valueStart = skipTrivia(raw, afterKey + 1);
    const scannedValue = scanValue(raw, valueStart);
    const afterValue = skipTrivia(raw, scannedValue.end);
    const delimiter = raw[afterValue];

    if (delimiter !== "," && delimiter !== "}") {
      throw new Error(`Unexpected token after config key "${keyToken.value}".`);
    }

    properties.push({
      key: keyToken.value,
      keyStart: cursor,
      valueStart,
      valueEnd: scannedValue.end,
      valueKind: scannedValue.kind,
      delimiter,
    });

    if (delimiter === "}") {
      break;
    }

    cursor = skipTrivia(raw, afterValue + 1);
  }

  return properties;
}

function findObjectProperty(raw: string, objectStart: number, key: string): ObjectProperty | null {
  return listObjectProperties(raw, objectStart).find((entry) => entry.key === key) ?? null;
}

function formatConfigValue(value: unknown, propertyIndent: string, format: TextFormat): string {
  const serialized = JSON.stringify(value, null, 2);
  if (serialized === undefined) {
    throw new Error("Unable to serialize config value.");
  }

  return serialized
    .split("\n")
    .map((line, index) => {
      if (index === 0) {
        return line;
      }

      const indentMatch = line.match(/^ +/);
      const level = indentMatch ? Math.floor(indentMatch[0].length / 2) : 0;
      return `${propertyIndent}${format.indentUnit.repeat(level)}${line.trimStart()}`;
    })
    .join(format.eol);
}

function replaceRange(raw: string, start: number, end: number, value: string): string {
  return `${raw.slice(0, start)}${value}${raw.slice(end)}`;
}

function insertObjectProperty(raw: string, objectStart: number, key: string, value: unknown, format: TextFormat): string {
  const objectEnd = findObjectEnd(raw, objectStart);
  const parentIndent = getLineIndent(raw, objectStart);
  const propertyIndent = `${parentIndent}${format.indentUnit}`;
  const propertyText = `${JSON.stringify(key)}: ${formatConfigValue(value, propertyIndent, format)}`;
  const properties = listObjectProperties(raw, objectStart);

  if (properties.length === 0) {
    const insertion = `${format.eol}${propertyIndent}${propertyText}${format.eol}${parentIndent}`;
    return replaceRange(raw, objectEnd, objectEnd, insertion);
  }

  let insertAt = objectEnd;
  while (insertAt > objectStart + 1 && /[ \t\r\n]/.test(raw[insertAt - 1])) {
    insertAt -= 1;
  }

  const separator = properties[properties.length - 1]?.delimiter === "," ? "" : ",";
  const insertion = `${separator}${format.eol}${propertyIndent}${propertyText}`;
  return replaceRange(raw, insertAt, insertAt, insertion);
}

function replaceObjectPropertyValue(raw: string, property: ObjectProperty, value: unknown, format: TextFormat): string {
  const propertyIndent = getLineIndent(raw, property.keyStart);
  const formattedValue = formatConfigValue(value, propertyIndent, format);
  return replaceRange(raw, property.valueStart, property.valueEnd, formattedValue);
}

function buildUpdatedConfigText(raw: string, accountId: string, auth: TelegramAuthResult): string {
  const parsed = JSON5.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error("OpenClaw config root must be an object.");
  }

  const updatedConfig = applyAuthToConfig(parsed as OpenClawConfig, accountId, auth);
  const updatedChannels = isPlainObject(updatedConfig.channels) ? updatedConfig.channels : {};

  const format = detectTextFormat(raw);
  const rootStart = skipTrivia(raw, 0);
  if (raw[rootStart] !== "{") {
    throw new Error("OpenClaw config file is not a JSON object.");
  }

  const channelsProperty = findObjectProperty(raw, rootStart, "channels");
  if (!channelsProperty) {
    return insertObjectProperty(raw, rootStart, "channels", updatedChannels, format);
  }

  return replaceObjectPropertyValue(raw, channelsProperty, updatedChannels, format);
}

/**
 * The config this writes holds `apiHash` and `sessionString` in plaintext, so
 * the permissions of the file it replaces are part of the credential's
 * protection. `writeFile`'s own `mode` is masked by the process umask (0644
 * under the usual 022), which is how a 0600 config came back world-readable
 * after `--auth`; the explicit `chmod` on the temp file is what actually
 * fixes it, and it happens before the rename so the config is never briefly
 * readable at the wrong mode.
 */
const SECRET_FILE_MODE = 0o600;

async function readFileMode(filePath: string): Promise<number> {
  const stats = await fs.stat(filePath).catch(() => null);
  return stats ? stats.mode & 0o777 : SECRET_FILE_MODE;
}

async function writeConfigAtomically(configPath: string, raw: string): Promise<void> {
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  const mode = await readFileMode(configPath);

  try {
    await fs.writeFile(tempPath, raw, { encoding: "utf8", mode });
    await fs.chmod(tempPath, mode);
    await fs.rename(tempPath, configPath);
  } catch (error) {
    await fs.unlink(tempPath).catch(() => undefined);
    throw error;
  }
}

export async function createConfigBackup(configPath: string): Promise<string | null> {
  const raw = await fs.readFile(configPath, "utf8").catch(() => null);
  if (raw === null) {
    return null;
  }

  // The backup is a verbatim copy of a credential file and it is never cleaned
  // up, so it inherits the original's mode rather than the umask default.
  const mode = await readFileMode(configPath);
  const backupPath = buildConfigBackupPath(configPath);
  await fs.writeFile(backupPath, raw, { encoding: "utf8", mode });
  await fs.chmod(backupPath, mode);
  return backupPath;
}

export async function updateConfigFileDirectly(configPath: string, accountId: string, auth: TelegramAuthResult): Promise<void> {
  const raw = await fs.readFile(configPath, "utf8");
  const nextRaw = buildUpdatedConfigText(raw, accountId, auth);

  if (nextRaw === raw) {
    return;
  }

  await writeConfigAtomically(configPath, nextRaw);
}
