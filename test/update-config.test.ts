import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import JSON5 from "json5";

import {
  createConfigBackup,
  keepSecretRefs,
  secretRefFieldsFor,
  updateConfigFileDirectly,
} from "../src/update-config";

/**
 * This module writes `apiHash` and `sessionString` into the operator's live
 * config, and had no tests at all (finding A6-17).
 *
 * What it must never do is as important as what it does: it edits one account
 * in place rather than reserialising the file, because the config is
 * hand-written JSON5 with comments an operator relies on, and it must not
 * overwrite a credential that has been moved into a secret store.
 */

const AUTH = {
  apiId: 12345678,
  apiHash: "fresh-hash",
  sessionString: "fresh-session",
  selfId: "100200300",
};

function withConfig(raw: string): string {
  const dir = mkdtempSync(join(tmpdir(), "clawgram-config-"));
  const file = join(dir, "openclaw.json");
  writeFileSync(file, raw, { encoding: "utf8", mode: 0o600 });
  return file;
}

describe("update-config", () => {
  test("comments and formatting around the edit survive", async () => {
    const raw = [
      "{",
      "  // Настройки шлюза — правил руками, не терять.",
      "  \"gateway\": { \"port\": 18789 },",
      "  \"channels\": {",
      "    \"clawgram\": {",
      "      \"accounts\": {",
      "        \"default\": {",
      "          \"enabled\": true,",
      "          \"apiId\": 1,",
      "          \"apiHash\": \"old\",",
      "          \"sessionString\": \"old-session\"",
      "        }",
      "      }",
      "    }",
      "  }",
      "}",
      "",
    ].join("\n");
    const file = withConfig(raw);

    await updateConfigFileDirectly(file, "default", AUTH);
    const next = readFileSync(file, "utf8");

    assert.ok(next.includes("// Настройки шлюза"), "the operator's comment is still there");
    assert.ok(next.includes("\"port\": 18789"), "untouched sections are untouched");
    assert.ok(next.includes("fresh-hash"));
    assert.ok(next.includes("fresh-session"));
    assert.ok(!next.includes("\"old-session\""), "the stale session is gone");
  });

  test("a second run with the same credentials changes nothing", async () => {
    const file = withConfig(JSON.stringify({
      channels: { clawgram: { accounts: { default: { enabled: true, apiId: 1, apiHash: "x" } } } },
    }, null, 2) + "\n");

    await updateConfigFileDirectly(file, "default", AUTH);
    const first = readFileSync(file, "utf8");
    await updateConfigFileDirectly(file, "default", AUTH);

    assert.equal(readFileSync(file, "utf8"), first, "idempotent: no churn in a credential file");
  });

  test("a missing channels section is created rather than refused", async () => {
    // Вставка клала свойство ЗА закрывающей скобкой корня: файл переставал
    // быть JSON вовсе. Путь замены (обычная переавторизация) этого не
    // задевал, поэтому дефект жил незамеченным (A6-17).
    const file = withConfig("{\n  // комментарий оператора\n  \"gateway\": { \"port\": 18789 }\n}\n");

    await updateConfigFileDirectly(file, "default", AUTH);
    const text = readFileSync(file, "utf8");
    const next = JSON5.parse(text);

    assert.equal(next.channels.clawgram.accounts.default.apiHash, "fresh-hash");
    assert.equal(next.gateway.port, 18789, "and the rest of the config stays");
    assert.ok(text.includes("// комментарий оператора"), "the comment survives the insert");
    assert.equal(text.trimEnd().endsWith("}"), true, "the root object is still closed last");
  });

  test("a second account is added beside the first, not instead of it", async () => {
    const file = withConfig(JSON.stringify({
      channels: {
        clawgram: {
          accounts: { first: { enabled: true, apiId: 7, apiHash: "keep", sessionString: "keep" } },
        },
      },
    }, null, 2) + "\n");

    await updateConfigFileDirectly(file, "second", AUTH);
    const next = JSON5.parse(readFileSync(file, "utf8"));

    assert.equal(next.channels.clawgram.accounts.first.apiHash, "keep", "the old account is intact");
    // Раньше `second` оказывался соседом `accounts` внутри `clawgram`: для
    // рантайма такого аккаунта просто не существовало.
    assert.equal(next.channels.clawgram.accounts.second.apiHash, "fresh-hash");
    assert.equal((next.channels.clawgram as any).second, undefined);
  });

  test("a credential moved to a secret store is not overwritten by re-auth", async () => {
    const ref = { source: "file", provider: "corp", id: "/telegram/api-hash" };
    const file = withConfig(JSON.stringify({
      channels: {
        clawgram: { accounts: { default: { enabled: true, apiId: 1, apiHash: ref } } },
      },
    }, null, 2) + "\n");

    const kept = await updateConfigFileDirectly(file, "default", AUTH);
    const next = JSON.parse(readFileSync(file, "utf8"));

    assert.deepEqual(kept, [ "apiHash" ], "the caller is told which reference stood");
    assert.deepEqual(next.channels.clawgram.accounts.default.apiHash, ref,
      "the reference wins — otherwise re-auth silently undoes the migration");
    assert.equal(next.channels.clawgram.accounts.default.sessionString, "fresh-session",
      "the field that was not a reference is still updated");
  });

  test("keepSecretRefs answers on the value, not on the field name", () => {
    const ref = { source: "file", provider: "corp", id: "/x" };
    const kept = keepSecretRefs({ apiHash: ref, sessionString: "plain" }, {
      apiHash: "new", sessionString: "new-session",
    });
    assert.deepEqual(kept.kept, [ "apiHash" ]);
    assert.deepEqual(kept.payload.apiHash, ref);
    assert.equal(kept.payload.sessionString, "new-session");
  });

  test("secretRefFieldsFor survives a config it cannot parse", () => {
    assert.deepEqual(secretRefFieldsFor("{ this is not json", "default"), []);
    assert.deepEqual(secretRefFieldsFor("{}", "default"), []);
  });

  test("the backup is a verbatim copy and keeps the original's mode", async () => {
    const raw = "{\n  \"channels\": {}\n}\n";
    const file = withConfig(raw);

    const backup = await createConfigBackup(file);

    assert.ok(backup, "a backup path is returned");
    assert.equal(readFileSync(backup as string, "utf8"), raw);
    assert.equal(statSync(backup as string).mode & 0o777, 0o600,
      "a copy of a credential file must not be world-readable");
  });

  test("no backup for a config that does not exist yet", async () => {
    assert.equal(await createConfigBackup(join(tmpdir(), "clawgram-missing-config.json")), null);
  });

  test("the edited file keeps its restrictive mode", async () => {
    const file = withConfig(JSON.stringify({ channels: {} }, null, 2) + "\n");

    await updateConfigFileDirectly(file, "default", AUTH);

    assert.equal(statSync(file).mode & 0o777, 0o600);
  });
});
