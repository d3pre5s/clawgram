import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { createConfigBackup, updateConfigFileDirectly } from "../src/update-config";

/**
 * `--auth` writes `apiHash` and `sessionString` into `openclaw.json` in
 * plaintext, so the mode of that file is part of the credential's protection.
 * Both writers used `fs.writeFile` with no mode, and `writeFile`'s mode is
 * masked by the umask anyway — a config the owner had locked to 0600 came back
 * 0644, and the never-cleaned backup copy was created 0644 from the start.
 *
 * These tests run entirely under a throwaway temp dir: `~/.openclaw` is the
 * live Gateway's state and must never be touched by a test run.
 */

const AUTH = {
  apiId: 12345678,
  apiHash: "0123456789abcdef0123456789abcdef",
  sessionString: "1BQAhaGVsbG8gd29ybGQgdGhpcyBpcyBub3QgYSByZWFsIHNlc3Npb24",
};

const modeOf = async (filePath: string) => (await stat(filePath)).mode & 0o777;

async function makeConfig(mode: number): Promise<{ dir: string; configPath: string }> {
  const dir = await mkdtemp(path.join(tmpdir(), "clawgram-perm-"));
  const configPath = path.join(dir, "openclaw.json");
  await writeFile(configPath, JSON.stringify({ channels: {} }, null, 2), { encoding: "utf8", mode });
  return { dir, configPath };
}

describe("config writes keep the credential file's permissions", () => {
  test("a 0600 config is still 0600 after an auth write", async () => {
    const { configPath } = await makeConfig(0o600);

    await updateConfigFileDirectly(configPath, "default", AUTH);

    assert.equal(await modeOf(configPath), 0o600);
    const written = await readFile(configPath, "utf8");
    assert.match(written, /sessionString/);
  });

  test("the backup copy is created with the config's own mode, not the umask default", async () => {
    const { configPath } = await makeConfig(0o600);

    const backupPath = await createConfigBackup(configPath);

    assert.ok(backupPath, "expected a backup path");
    assert.equal(await modeOf(backupPath as string), 0o600);
  });

  test("a deliberately wider mode is inherited rather than forced to 0600", async () => {
    const { configPath } = await makeConfig(0o640);

    await updateConfigFileDirectly(configPath, "default", AUTH);

    assert.equal(await modeOf(configPath), 0o640);
  });

  test("a config that does not exist yet is created 0600 by the atomic write", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "clawgram-perm-"));
    await mkdir(path.join(dir, "nested"), { recursive: true });
    const configPath = path.join(dir, "nested", "openclaw.json");
    await writeFile(configPath, JSON.stringify({ channels: {} }), { encoding: "utf8", mode: 0o600 });

    await updateConfigFileDirectly(configPath, "default", AUTH);

    assert.equal(await modeOf(configPath), 0o600);
  });
});
