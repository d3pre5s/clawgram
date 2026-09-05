import { promises as fs } from "node:fs";
import path from "node:path";
import JSON5 from "json5";
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { CHANNEL_ID } from "./constants";
import { asSecretRef } from "./secret-refs";
import { isPlainObject } from "./util";

type TelegramAuthResult = {
  apiId: number;
  apiHash: string;
  sessionString: string;
  selfId?: string;
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

function buildAccountPayload(auth: TelegramAuthResult): Record<string, unknown> {
  return {
    enabled: true,
    apiId: auth.apiId,
    apiHash: auth.apiHash,
    sessionString: auth.sessionString,
  };
}

/** Первый конфиг закрыт: см. одноимённую функцию в cli-core.ts. */
function buildAccountConfigFragment(auth: TelegramAuthResult): Record<string, unknown> {
  return {
    ...buildAccountPayload(auth),
    allowFrom: auth.selfId ? [ auth.selfId ] : [],
    readChats: [],
  };
}

/**
 * Credentials already moved into the secret store must survive re-auth.
 *
 * An account whose apiHash/sessionString were migrated to `{source, provider,
 * id}` had them overwritten with the literal strings typed during the
 * interactive flow: the spread put the fresh payload on top of the reference.
 * So an operator re-authorising after a session expiry silently undid the
 * migration and left plaintext credentials in a file that gets backed up and
 * synced — the exact thing secret-refs.ts was written to prevent.
 *
 * The reference wins. The new value is handed back so the caller can tell the
 * operator to store it where the reference points; it is never written to the
 * config, and never printed here.
 */
export function keepSecretRefs(
  existingAccount: Record<string, unknown>,
  payload: Record<string, unknown>,
): { payload: Record<string, unknown>; kept: string[] } {
  const next = { ...payload };
  const kept: string[] = [];
  for (const field of [ "apiHash", "sessionString" ]) {
    if (asSecretRef(existingAccount?.[ field ])) {
      next[ field ] = existingAccount[ field ];
      kept.push(field);
    }
  }
  return { payload: next, kept };
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
            ...keepSecretRefs(existingAccount, buildAccountPayload(auth)).payload,
            enabled: existingAccount.enabled ?? true,
            // Существующие настройки не трогаем — повторная авторизация не
            // повод переписать чужие решения. Отсутствующие садятся закрытыми.
            allowFrom: existingAccount.allowFrom ?? (auth.selfId ? [ auth.selfId ] : []),
            readChats: existingAccount.readChats ?? [],
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

/**
 * Позиция СРАЗУ ЗА закрывающей скобкой объекта — как `end` у среза.
 *
 * Имя обманывало: `scanEnclosedValue` возвращает индекс после `}`, а вставка
 * свойства обращалась с этим числом как с позицией самой скобки и клала
 * свойство ЗА объектом. Итог — испорченный конфиг: аккаунт, добавленный к
 * существующему `accounts`, оказывался соседом `accounts` внутри `clawgram`,
 * а при отсутствующем `channels` вставка уезжала за корневую `}` и файл
 * переставал быть JSON вовсе. Ловилось только на путях вставки, а обычная
 * переавторизация идёт путём замены — поэтому и жило (находка A6-17).
 */
function findObjectEndExclusive(raw: string, objectStart: number): number {
  return scanEnclosedValue(raw, objectStart, "{", "}");
}

/** Позиция самой закрывающей скобки — точка, ПЕРЕД которой вставляют. */
function findObjectCloseBrace(raw: string, objectStart: number): number {
  return findObjectEndExclusive(raw, objectStart) - 1;
}

function listObjectProperties(raw: string, objectStart: number): ObjectProperty[] {
  const properties: ObjectProperty[] = [];
  const objectEnd = findObjectEndExclusive(raw, objectStart);
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
  const closeBrace = findObjectCloseBrace(raw, objectStart);
  const parentIndent = getLineIndent(raw, objectStart);
  const propertyIndent = `${parentIndent}${format.indentUnit}`;
  const propertyText = `${JSON.stringify(key)}: ${formatConfigValue(value, propertyIndent, format)}`;
  const properties = listObjectProperties(raw, objectStart);

  if (properties.length === 0) {
    const insertion = `${format.eol}${propertyIndent}${propertyText}${format.eol}${parentIndent}`;
    return replaceRange(raw, closeBrace, closeBrace, insertion);
  }

  let insertAt = closeBrace;
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

/**
 * Спуск по пути объектов. Недостающие звенья создаются пустыми объектами.
 *
 * Возвращает и текст, и позицию начала найденного объекта: после вставки
 * прежние смещения указывают не туда.
 */
function descend(raw: string, objectStart: number, path: readonly string[]):
{ objectStart: number; missing: readonly string[] } {
  let start = objectStart;
  for (let i = 0; i < path.length; i += 1) {
    const property = findObjectProperty(raw, start, path[ i ]);
    // Недостающее звено не достраивается по одному: вставить пустой объект и
    // тут же найти его снова — значит положиться на разбор свойств сразу
    // после правки текста, а это самое хрупкое место здесь. Вместо этого
    // вызывающий вставляет весь остаток пути одним литералом.
    if (!property) return { objectStart: start, missing: path.slice(i) };
    const valueStart = skipTrivia(raw, property.valueStart);
    if (raw[ valueStart ] !== "{") {
      throw new Error(`clawgram: ${path[ i ]} в конфиге не объект — правка вручную безопаснее`);
    }
    start = valueStart;
  }
  return { objectStart: start, missing: [] };
}

/** Вложенный литерал `{a: {b: {c: value}}}` для недостающего остатка пути. */
function nest(path: readonly string[], value: unknown): unknown {
  return path.reduceRight((inner, key) => ({ [ key ]: inner }), value as any);
}

/**
 * Правится один аккаунт, а не весь блок `channels`.
 *
 * Раньше блок находился хирургически, а его значение целиком пересобиралось
 * через `JSON.stringify`: пропадали все комментарии JSON5, висячие запятые и
 * ручное форматирование — включая блоки ДРУГИХ каналов, к авторизации
 * отношения не имеющих. Файл потому и JSON5, что в нём пишут пояснения; после
 * каждой переавторизации они исчезали, а diff тонул в переформатировании,
 * пряча ровно то изменение, ради которого всё делалось (находка A6-06).
 *
 * Чего это НЕ спасает: комментарии внутри самого правимого аккаунта. Его
 * значение пересобирается — там меняются учётные данные, и разбирать его
 * посвойственно значит полагаться на разбор комментариев в позициях, который
 * здесь и так самое хрупкое место. Всё за пределами этого аккаунта остаётся
 * как было.
 */
function buildUpdatedConfigText(raw: string, accountId: string, auth: TelegramAuthResult): string {
  const parsed = JSON5.parse(raw);
  if (!isPlainObject(parsed)) {
    throw new Error("OpenClaw config root must be an object.");
  }

  const format = detectTextFormat(raw);
  const rootStart = skipTrivia(raw, 0);
  if (raw[rootStart] !== "{") {
    throw new Error("OpenClaw config file is not a JSON object.");
  }

  // Что должно оказаться в аккаунте — считает та же функция, что и раньше:
  // правила про SecretRef и закрытый посев живут в одном месте.
  const updatedConfig = applyAuthToConfig(parsed as OpenClawConfig, accountId, auth);
  const account = (updatedConfig as any)?.channels?.[ CHANNEL_ID ]?.accounts?.[ accountId ] ?? {};

  const path = [ "channels", CHANNEL_ID, "accounts" ];
  const { objectStart, missing } = descend(raw, rootStart, path);
  if (missing.length) {
    // Раздела нет — вставляем недостающий остаток вместе с аккаунтом.
    return insertObjectProperty(raw, objectStart, missing[ 0 ],
      nest(missing.slice(1), { [ accountId ]: account }), format);
  }

  const existing = findObjectProperty(raw, objectStart, accountId);
  return existing
    ? replaceObjectPropertyValue(raw, existing, account, format)
    : insertObjectProperty(raw, objectStart, accountId, account, format);
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

/**
 * Which credentials stayed as secret-store references, so the caller can say
 * so. Silence here would be the worst outcome: the operator would believe the
 * freshly issued credential is in the config and find out at the next start.
 */
export function secretRefFieldsFor(raw: string, accountId: string): string[] {
  let parsed: unknown;
  try { parsed = JSON5.parse(raw); } catch { return []; }
  if (!isPlainObject(parsed)) return [];
  const channels = isPlainObject(parsed.channels) ? parsed.channels : {};
  const channel = isPlainObject(channels[ CHANNEL_ID ]) ? channels[ CHANNEL_ID ] as Record<string, unknown> : {};
  const accounts = isPlainObject(channel.accounts) ? channel.accounts as Record<string, unknown> : {};
  const account = isPlainObject(accounts[ accountId ]) ? accounts[ accountId ] as Record<string, unknown> : {};
  return [ "apiHash", "sessionString" ].filter((field) => asSecretRef(account[ field ]));
}

export async function updateConfigFileDirectly(configPath: string, accountId: string, auth: TelegramAuthResult): Promise<string[]> {
  const raw = await fs.readFile(configPath, "utf8");
  const keptRefs = secretRefFieldsFor(raw, accountId);
  const nextRaw = buildUpdatedConfigText(raw, accountId, auth);

  if (nextRaw === raw) {
    return keptRefs;
  }

  await writeConfigAtomically(configPath, nextRaw);
  return keptRefs;
}
