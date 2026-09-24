import { strict as assert } from "node:assert";
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";

/**
 * `scripts/check-pii.mjs` is the net that keeps a real person's Telegram
 * identity out of git and npm. Audit r3 found four holes in it at once:
 * a handle written without `@` or in another case passed the denylist
 * (V1-05), the "unix seconds" exemption waved through today's real ids
 * (V1-07), the script silently did not run from a path with a space,
 * Cyrillic or a symlink (V1-08), and it did not read what actually ships —
 * `dist/`, the manifest (V1-09).
 *
 * The real-looking values below are assembled at runtime on purpose: written
 * out, they would be exactly what the script refuses in this very file.
 */

const SCRIPT = path.resolve(__dirname, "..", "..", "scripts", "check-pii.mjs");
const REAL_USER = [ "17", "34", "51", "29", "86" ].join("");   // ten digits, 17…: a current user id
const REAL_SHORT = [ "73", "45", "12", "98", "6" ].join("");   // nine digits
const REAL_CHAT = "-100" + REAL_USER;                          // a current supergroup
const HANDLE = [ "probe", "handle", "q" ].join("_");

const scratch = mkdtempSync(path.join(os.tmpdir(), "clawgram-check-pii-"));
after(() => rmSync(scratch, { recursive: true, force: true }));

let fixtures = 0;
/** A package laid out like this one, with the real script copied in. */
function fixture(files: Record<string, string>, dirName = `pkg-${++fixtures}`) {
  const root = path.join(scratch, dirName);
  const all: Record<string, string> = {
    "package.json": JSON.stringify({
      name: "probe",
      author: "Maintainer Probe (maint_probe_x)",
      files: [ "dist", "openclaw.plugin.json", "README.md" ],
    }),
    "README.md": "# probe\n",
    "openclaw.plugin.json": "{ \"id\": \"probe\" }\n",
    "src/index.ts": "export const id = \"500000001\";\n",
    "dist/index.js": "exports.id = \"500000001\";\n",
    ...files,
  };
  for (const [ rel, text ] of Object.entries(all)) {
    mkdirSync(path.dirname(path.join(root, rel)), { recursive: true });
    writeFileSync(path.join(root, rel), text);
  }
  mkdirSync(path.join(root, "scripts"), { recursive: true });
  copyFileSync(SCRIPT, path.join(root, "scripts", "check-pii.mjs"));
  return root;
}

function denylist(lines: string[]) {
  const file = path.join(scratch, `denylist-${++fixtures}.txt`);
  writeFileSync(file, lines.join("\n") + "\n");
  return file;
}

function check(scriptPath: string, env: Record<string, string | undefined> = {}) {
  const childEnv = { ...process.env, ...env };
  delete childEnv.GITHUB_ACTIONS;
  if (!("CLAWGRAM_PII_DENYLIST" in env)) delete childEnv.CLAWGRAM_PII_DENYLIST;
  for (const [ k, v ] of Object.entries(childEnv)) if (v === undefined) delete childEnv[ k ];
  const r = spawnSync(process.execPath, [ scriptPath ], { encoding: "utf8", env: childEnv });
  return { status: r.status, out: `${r.stdout}${r.stderr}` };
}

const scriptIn = (root: string) => path.join(root, "scripts", "check-pii.mjs");

describe("check-pii: the shape net (V1-07)", () => {
  const load = async () => await import(pathToFileURL(SCRIPT).href);

  it("does not take a current user id or supergroup for a timestamp", async () => {
    const { looksSynthetic, shapeHits } = await load();
    assert.equal(looksSynthetic(REAL_USER), false);
    assert.equal(looksSynthetic(REAL_SHORT), false);
    for (const text of [
      `peerId: { userId: ${REAL_USER} }`,
      `chatId: "${REAL_CHAT}"`,
      `target: "clawgram:${REAL_CHAT}"`,
      `{ channelId: ${REAL_USER}n }`,
      `id: ${REAL_USER.replace(/(\d)(?=(\d{3})+$)/g, "$1_")}`,
      `senderId: ${REAL_SHORT},`,
      `t.me/c/${REAL_USER}/5`,
    ]) {
      assert.equal(shapeHits(text).length, 1, `missed: ${text.replace(/\d{6,}/g, "<id>")}`);
    }
  });

  it("still lets through what a person typed on purpose", async () => {
    const { looksSynthetic, shapeHits } = await load();
    for (const digits of [ "500000001", "1000000002", "123456789", "1001234567", "9876543210", "2147483647" ]) {
      assert.equal(looksSynthetic(digits), true, digits);
    }
    for (const text of [
      "chatId: \"-1002000000001\"",
      "const BASE = 1_785_000_000;",
      "\"maximum\": 9007199254740991",
      "to: \"+79991234567\"",
      "openclaw.json.bak-20260805-084914",
      "version 2.29.1, sha 3f2a" + REAL_USER + "bc",
      "ratio 0." + REAL_USER,
    ]) {
      assert.deepEqual(shapeHits(text), [], text.replace(/\d{9,}/g, "<n>"));
    }
  });

  it("a real-shaped id in a test fails the run", () => {
    const root = fixture({ "test/a.test.ts": `const chat = "${REAL_CHAT}";\n` });
    const r = check(scriptIn(root));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /test\/a\.test\.ts:1: looks like a real Telegram id/);
  });
});

describe("check-pii: the denylist (V1-05)", () => {
  it("finds a handle written without @ and in another case", () => {
    const list = denylist([ "# comment", `@${HANDLE.toUpperCase()}` ]);
    for (const form of [ HANDLE, HANDLE.toUpperCase(), `@${HANDLE}`, `t.me/${HANDLE}` ]) {
      const root = fixture({ "test/b.test.ts": `const who = { username: "${form}" };\n` });
      const r = check(scriptIn(root), { CLAWGRAM_PII_DENYLIST: list });
      assert.equal(r.status, 1, `passed: ${form}\n${r.out}`);
      assert.match(r.out, /test\/b\.test\.ts:1: value from the denylist/);
      assert.equal(r.out.toLowerCase().includes(HANDLE), false, "the report must not repeat the value");
    }
  });

  it("finds a denylisted supergroup by its bare channel id too", () => {
    const list = denylist([ REAL_CHAT ]);
    const root = fixture({ "src/c.ts": `// a chat\nconst c = { channelId: "${REAL_USER}" };\n` });
    const r = check(scriptIn(root), { CLAWGRAM_PII_DENYLIST: list });
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /src\/c\.ts:2: value from the denylist/);
  });

  it("leaves the maintainer's public identity in package.json alone", () => {
    const list = denylist([ "@MAINT_PROBE_X" ]);
    const root = fixture({});
    const r = check(scriptIn(root), { CLAWGRAM_PII_DENYLIST: list });
    assert.equal(r.status, 0, r.out);
  });

  it("a named denylist that does not exist is an error, not a quiet shape-only run", () => {
    const root = fixture({});
    const r = check(scriptIn(root), { CLAWGRAM_PII_DENYLIST: path.join(scratch, "missing.txt") });
    assert.notEqual(r.status, 0, r.out);
  });

  it("without a denylist it still checks the shape, and says so", () => {
    const clean = check(scriptIn(fixture({})));
    assert.equal(clean.status, 0, clean.out);
    assert.match(clean.out, /shape check only/);

    const dirty = check(scriptIn(fixture({ "src/d.ts": `const id = ${REAL_USER};\n` })));
    assert.equal(dirty.status, 1, dirty.out);
  });
});

describe("check-pii: runs wherever it is started from (V1-08)", () => {
  const violation = { "test/e.test.ts": `const chat = "${REAL_CHAT}";\n` };

  for (const dirName of [ "with space", "кириллица", "кириллица с пробелом" ]) {
    it(`from a path with "${dirName}"`, () => {
      const r = check(scriptIn(fixture(violation, dirName)));
      assert.equal(r.status, 1, `exit ${r.status}, output: ${JSON.stringify(r.out)}`);
    });
  }

  it("through a symlink", () => {
    const root = fixture(violation);
    const link = path.join(scratch, `link-${++fixtures}`);
    symlinkSync(root, link, "dir");
    const r = check(scriptIn(link));
    assert.equal(r.status, 1, `exit ${r.status}, output: ${JSON.stringify(r.out)}`);
  });
});

describe("check-pii: reads what ships (V1-09)", () => {
  it("the built dist/", () => {
    const r = check(scriptIn(fixture({ "dist/index.js": `exports.chat = "${REAL_CHAT}";\n` })));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /dist\/index\.js:1/);
  });

  it("the plugin manifest", () => {
    const r = check(scriptIn(fixture({ "openclaw.plugin.json": `{ "examples": [ "${REAL_CHAT}" ] }\n` })));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /openclaw\.plugin\.json:1/);
  });

  it("scripts and workflows, not only src and test", () => {
    const r = check(scriptIn(fixture({ ".github/workflows/x.yml": `env:\n  CHAT: "${REAL_CHAT}"\n` })));
    assert.equal(r.status, 1, r.out);
    assert.match(r.out, /\.github\/workflows\/x\.yml:2/);
  });
});

describe("check-pii: CI hands it the denylist (V1-06)", () => {
  for (const workflow of [ "ci.yml", "release.yml" ]) {
    it(`${workflow} writes the secret to a file before the tests run`, () => {
      const text = readFileSync(path.resolve(__dirname, "..", "..", ".github", "workflows", workflow), "utf8");
      const secret = text.indexOf("secrets.CLAWGRAM_PII_DENYLIST");
      const test = text.indexOf("run: npm test");
      assert.ok(secret !== -1, `${workflow} never reads the CLAWGRAM_PII_DENYLIST secret`);
      assert.ok(test !== -1 && secret < test, `${workflow} reads the secret after the tests`);
      assert.match(text, /CLAWGRAM_PII_DENYLIST=.*>> "\$GITHUB_ENV"/);
    });
  }
});
