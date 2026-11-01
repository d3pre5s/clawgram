import assert from "node:assert/strict";
import { test } from "node:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { ensureNpmRelease, readNpmRelease, retryClawhub, ensureClawhubRelease, readClawhubPublication, verifyClawhubRelease } from "../scripts/release-automation.mjs";

const release = { name: "clawgram", version: "2.31.0", commit: "a".repeat(40) };
const published = { name: release.name, version: release.version, gitHead: release.commit };
const quiet = () => {};

test("ClawHub verifies exact version source even when that version is no longer latest", async () => {
  const metadata = {
    package: { name: release.name },
    version: { version: release.version, verification: { sourceRepo: "d3pre5s/clawgram", sourceCommit: release.commit } },
  };
  await verifyClawhubRelease(release, { fetch: async () => Response.json(metadata) });
  await assert.rejects(verifyClawhubRelease({ ...release, commit: "b".repeat(40) }, {
    fetch: async () => Response.json(metadata),
  }), /does not match/);
});

test("ClawHub read falls back to exact version on an older registry", async () => {
  const urls = [];
  const result = await readClawhubPublication(release, {
    fetch: async (url) => {
      urls.push(url);
      return url.endsWith("/publication") ? new Response("missing", { status: 404 }) : Response.json({ version: {} });
    },
  });
  assert.equal(result.state, "published");
  assert.equal(urls.length, 2);
});

test("ClawHub recovery waits for an existing scan without uploading again", async () => {
  let reads = 0;
  let verified = false;
  await ensureClawhubRelease(release, {
    read: async () => ({ state: ++reads < 3 ? "pending" : "published" }),
    publish: () => assert.fail("must not upload a pending version again"),
    verify: async () => { verified = true; }, sleep: async () => {}, log: quiet,
  });
  assert.equal(reads, 3);
  assert.equal(verified, true);
});

test("ClawHub publication checks fail closed on failed or unknown states", async () => {
  for (const state of ["failed", "unexpected"]) {
    await assert.rejects(ensureClawhubRelease(release, {
      read: async () => ({ state }), publish: () => assert.fail("must not upload"),
      verify: () => assert.fail("must not accept"), log: quiet,
    }), /ClawHub/);
  }
  await assert.rejects(readClawhubPublication(release, {
    fetch: async () => new Response(JSON.stringify({ name: release.name, version: release.version, state: "unknown" })),
  }), /Invalid/);
});

test("ClawHub uploads an absent release once, then verifies its source", async () => {
  let reads = 0;
  let writes = 0;
  let verified = false;
  await ensureClawhubRelease(release, {
    read: async () => ({ state: ++reads === 1 ? "absent" : "published" }),
    publish: async () => { writes++; }, verify: async () => { verified = true; }, log: quiet,
  });
  assert.equal(writes, 1);
  assert.equal(verified, true);
});

test("ClawHub pending timeout stays a failure", async () => {
  await assert.rejects(ensureClawhubRelease(release, {
    read: async () => ({ state: "pending" }), polls: 3, sleep: async () => {}, log: quiet,
    publish: () => assert.fail("must not upload"), verify: () => assert.fail("must not accept"),
  }), /still pending/);
});

test("npm retry skips an already published version from the same commit", async () => {
  let writes = 0;
  const result = await ensureNpmRelease(release, {
    read: async () => published, publish: () => { writes++; }, log: quiet,
  });
  assert.equal(result, "already-published");
  assert.equal(writes, 0);
});

test("npm refuses a version owned by a different commit, including recovery", async () => {
  for (const recovery of [false, true]) {
    await assert.rejects(ensureNpmRelease(release, {
      recovery, read: async () => ({ ...published, gitHead: "b".repeat(40) }),
      publish: () => assert.fail("must not publish"), log: quiet,
    }), /does not match/);
  }
});

test("ClawHub recovery requires an existing matching npm version and never publishes npm", async () => {
  await assert.rejects(ensureNpmRelease(release, {
    recovery: true, read: async () => null,
    publish: () => assert.fail("must not publish"), log: quiet,
  }), /not published/);
});

test("new npm release publishes once and checks the resulting version", async () => {
  let reads = 0;
  let writes = 0;
  assert.equal(await ensureNpmRelease(release, {
    read: async () => ++reads === 1 ? null : published,
    publish: () => { writes++; }, sleep: async () => {}, log: quiet,
  }), "published");
  assert.equal(writes, 1);
  assert.equal(reads, 2);
});

test("ambiguous npm write succeeds only if the exact release is found afterwards", async () => {
  for (const landed of [true, false]) {
    let reads = 0;
    let writes = 0;
    const action = ensureNpmRelease(release, {
      read: async () => ++reads === 1 || !landed ? null : published,
      publish: () => { writes++; throw new Error("connection lost"); },
      sleep: async () => {}, log: quiet,
    });
    if (landed) assert.equal(await action, "published");
    else await assert.rejects(action, /connection lost/);
    assert.equal(writes, 1, "never retry an ambiguous write");
  }
});

test("registry reads retry transient failures; only HTTP 404 means absent", async () => {
  let reads = 0;
  const waits = [];
  assert.equal(await readNpmRelease(release, {
    fetch: async () => {
      reads++;
      return new Response(reads < 3 ? "unavailable" : "not found", { status: reads < 3 ? 503 : 404 });
    }, sleep: async (ms) => waits.push(ms),
  }), null);
  assert.equal(reads, 3);
  assert.equal(waits.length, 2);
  await assert.rejects(readNpmRelease(release, {
    fetch: async () => new Response("forbidden", { status: 403 }),
    sleep: async () => assert.fail("must not retry authorization"),
  }), /HTTP 403/);
});

test("invalid registry JSON is a failure, not an unpublished version", async () => {
  await assert.rejects(readNpmRelease(release, {
    fetch: async () => new Response("not JSON", { status: 200 }),
  }), /JSON/);
});

test("ClawHub waits for explicit throttling and preserves the eventual result", async () => {
  let calls = 0;
  const waits = [];
  assert.equal(await retryClawhub(async () => {
    if (++calls < 3) throw new Error("Too many writes (reset in 17s)");
    return "published";
  }, { sleep: async (ms) => waits.push(ms), log: quiet }), "published");
  assert.deepEqual(waits, [18000, 18000]);
});

test("ClawHub auth and ambiguous network failures are not retried", async () => {
  for (const message of ["401 Unauthorized", "connection reset"]) {
    let calls = 0;
    await assert.rejects(retryClawhub(async () => {
      calls++;
      throw new Error(message);
    }, { sleep: async () => assert.fail("must not wait"), log: quiet }), new RegExp(message));
    assert.equal(calls, 1);
  }
});

test("persistent ClawHub throttling fails after bounded retries", async () => {
  let calls = 0;
  const waits = [];
  await assert.rejects(retryClawhub(async () => {
    calls++;
    throw new Error("HTTP 429 reset in 900s");
  }, { sleep: async (ms) => waits.push(ms), log: quiet }), /429/);
  assert.equal(calls, 4);
  assert.deepEqual(waits, [61000, 61000, 61000]);
});

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "clawgram-release-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: release.name, version: release.version }));
  writeFileSync(join(bin, "git"), `#!/bin/sh\nprintf '%s\\n' '${release.commit}'\n`, { mode: 0o755 });
  writeFileSync(join(bin, "npm"), '#!/bin/sh\nprintf "%s\\n" "$*" >> "$CALLS"\n', { mode: 0o755 });
  const env = {
    PATH: `${bin}:${dirname(process.execPath)}:/usr/bin:/bin`,
    CALLS: join(root, "calls"), RELEASE_REF: "v2.31.0", GITHUB_OUTPUT: join(root, "output"),
  };
  return {
    root, bin, env,
    run(script, args = []) {
      return spawnSync(process.execPath, [fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)), ...args], {
        cwd: root, env, encoding: "utf8", timeout: 5000,
      });
    },
  };
}

test("npm rehearsal needs no npm token or OIDC and publishes only with --dry-run", (t) => {
  const f = fixture(t);
  f.env.DRY_RUN = "true";
  const result = f.run("release-npm.mjs");
  assert.equal(result.status, 0, result.stderr);
  assert.equal(readFileSync(f.env.CALLS, "utf8"), "publish --access public --dry-run\n");
  assert.match(readFileSync(f.env.GITHUB_OUTPUT, "utf8"), new RegExp(`commit=${release.commit}`));
});

test("npm CLI rejects a mismatched tag before registry access or publishing", (t) => {
  const f = fixture(t);
  f.env.RELEASE_REF = "v9.9.9";
  const result = f.run("release-npm.mjs");
  assert.equal(result.status, 1);
  assert.match(result.stderr, /does not match/);
});

test("ClawHub login errors preserve diagnostics while redacting credentials and avoiding publish", (t) => {
  const f = fixture(t);
  f.env.CLAWHUB_TOKEN = "dummy-test-token";
  writeFileSync(join(f.bin, "clawhub"), '#!/bin/sh\necho "401 Unauthorized: $3" >&2\nexit 1\n', { mode: 0o755 });
  const result = f.run("publish-clawhub.mjs", ["--dry-run"]);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /401 Unauthorized/);
  assert.doesNotMatch(result.stderr + result.stdout, /dummy-test-token/);
});
