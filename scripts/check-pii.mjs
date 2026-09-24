#!/usr/bin/env node
// Refuses to publish a real person's Telegram identity.
//
// 2.27.0–2.29.0 shipped a third party's numeric id in `dist/` through a source
// comment, and the tests carried real handles and chat ids from the deployment
// that motivated each fix. A fixture is written from memory of an incident, so
// the incident's real values slip in; nothing downstream looks for them, and
// npm cannot take a published version back.
//
// Two nets, over everything the repository and the package show the world —
// every tracked file (sources, tests, scripts, workflows, README, CHANGELOG)
// plus what `files` in package.json ships (the built `dist/`, the manifest):
//   1. a denylist kept OUTSIDE git — the values themselves must not be here.
//      Path: $CLAWGRAM_PII_DENYLIST, else the control repository's
//      tests/denylist.local.txt next to this checkout, else skipped with a note.
//      Matched without regard to case and to a leading `@`: the file holds
//      `@handle`, a fixture writes `username: "Handle"` (audit r3 V1-05);
//   2. a shape check: a standalone 9–10 digit number or a -100 supergroup id
//      that is not visibly synthetic. Synthetic means typed on purpose — few
//      distinct digits, a round number, a counting run, or a listed fixture. There is no
//      "looks like a unix timestamp" exemption any more: 15…–19… is exactly
//      where today's user ids and supergroup ids live (audit r3 V1-07). Write
//      instants as `Date.UTC(…) / 1000` instead of a ten-digit literal.
//
// Exit 1 names file:line and the kind of hit, never the denylisted value.

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Scanned even outside a git checkout (an unpacked tarball, a test fixture). */
const SOURCES = ['src', 'test', 'scripts', '.github', 'README.md', 'CHANGELOG.md', 'openclaw.plugin.json'];
/** Third-party hashes and URLs; nothing a person typed. */
const SKIP_FILES = new Set(['npm-shrinkwrap.json', 'package-lock.json']);
const SKIP_DIRS = new Set(['node_modules', 'dist-test', '.git']);
const BINARY = /\.(png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|tgz|gz|zip)$/i;

/**
 * Ids that are fixtures by declaration. The rules below already accept most
 * of them; the list is for the rare synthetic value that does not look it.
 */
export const SYNTHETIC_IDS = new Set([
  '500000001', '500000002', '500000003',
  '1000000001', '1000000002', '2000000001',
  '100200300', '2147483647', '4294967295',
]);

/** A synthetic id is what a person types on purpose; a real one is noise. */
export function looksSynthetic(digits) {
  if (SYNTHETIC_IDS.has(digits)) return true;
  if (new Set(digits).size <= 4) return true;                  // 500000001, 1000000002
  if (/0{6}$/.test(digits)) return true;                       // 1_785_000_000: a round number
  // A counting run of seven anywhere: 123456789, 1001234567, 9876543210.
  if (/0123456|1234567|2345678|3456789|9876543|8765432|7654321|6543210/.test(digits)) return true;
  return false;
}

// `-100` + 9–10 digits (a supergroup/channel), or a bare 9–10 digit number
// (a user, a basic group, a channel id without its prefix). `_` separators
// and a BigInt `n` are the same number. Not preceded by a letter, a digit or a
// dot (hashes, versions, decimals); not followed by a letter or digit.
const SHAPE = /(?<![0-9A-Za-z.])(-100(?:_?\d){9,10}|-?\d(?:_?\d){8,9})n?(?![0-9A-Za-z])/g;

export function shapeHits(text) {
  const hits = [];
  for (const m of text.matchAll(SHAPE)) {
    const plain = m[1].replace(/_/g, '');
    const digits = plain.replace(/^-100(?=\d{9,10}$)/, '').replace(/^-/, '');
    if (!looksSynthetic(digits)) hits.push({ index: m.index, value: m[1] });
  }
  return hits;
}

/**
 * Denylist lines → lowercase needles without the leading `@`. A `-100…` chat
 * id also yields its bare form: the same chat appears as `channelId: <digits>`.
 * The maintainer's own public identity (author, repository URL) is in
 * package.json on purpose; the control repository's denylist forbids it
 * there, not here.
 */
export function denylistNeedles(lines, published = '') {
  const pub = published.toLowerCase();
  const needles = new Set();
  for (const line of lines) {
    const v = line.trim().replace(/^@/, '').toLowerCase();
    if (!v || v.startsWith('#') || pub.includes(v)) continue;
    needles.add(v);
    const bare = v.replace(/^-100(?=\d{6,}$)/, '').replace(/^-(?=\d{6,}$)/, '');
    if (bare !== v) needles.add(bare);
  }
  return [...needles];
}

export function denylistHits(text, needles) {
  const lower = text.toLowerCase();
  const hits = [];
  for (const v of needles) {
    const i = lower.indexOf(v);
    if (i !== -1) hits.push({ index: i });
  }
  return hits;
}

function walk(root, rel) {
  const abs = join(root, rel);
  if (!existsSync(abs)) return [];
  const st = statSync(abs);
  if (st.isFile()) return [rel];
  if (!st.isDirectory()) return [];
  return readdirSync(abs, { withFileTypes: true })
    .filter((e) => !SKIP_DIRS.has(e.name))
    .flatMap((e) => walk(root, join(rel, e.name)));
}

function tracked(root) {
  try {
    // Tracked plus untracked-but-not-ignored: a new test file is exactly what
    // must be checked before its first commit, not after it.
    const out = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    // Only when root is the top of the checkout; a fixture inside another
    // repository must not borrow that repository's file list.
    const top = execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    if (realpathSync(top) !== realpathSync(root)) return null;
    return out.split('\0').filter(Boolean).map((p) => p.split('/').join(sep));
  } catch {
    return null;
  }
}

/** Everything the repository and the package publish, relative to root. */
export function filesToScan(root) {
  const notes = [];
  let pkg = {};
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    notes.push('no readable package.json — scanning sources only');
  }
  const shipped = Array.isArray(pkg.files) ? pkg.files : [];
  for (const entry of shipped) {
    if (!existsSync(join(root, entry))) notes.push(`${entry} is in "files" but absent — run the build first to scan what ships`);
  }
  const fromGit = tracked(root);
  const listed = fromGit ?? SOURCES.flatMap((p) => walk(root, p));
  const all = new Set([...listed, ...shipped.flatMap((p) => walk(root, p))]);
  const files = [...all]
    .filter((p) => !SKIP_FILES.has(p.split(sep).pop()) && !BINARY.test(p))
    .filter((p) => !p.split(sep).some((part) => SKIP_DIRS.has(part)))
    .filter((p) => existsSync(join(root, p)) && statSync(join(root, p)).isFile())
    .sort();
  return { files, notes };
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

/** The whole check, without touching the process: returns what it found. */
export function run({ root = ROOT, denylistPath = null } = {}) {
  const published = existsSync(join(root, 'package.json')) ? readFileSync(join(root, 'package.json'), 'utf8') : '';
  const needles = denylistPath ? denylistNeedles(readFileSync(denylistPath, 'utf8').split('\n'), published) : [];
  const { files, notes } = filesToScan(root);
  const problems = [];
  for (const rel of files) {
    const text = readFileSync(join(root, rel), 'utf8');
    for (const h of denylistHits(text, needles)) {
      problems.push(`${rel}:${lineOf(text, h.index)}: value from the denylist`);
    }
    for (const h of shapeHits(text)) {
      problems.push(`${rel}:${lineOf(text, h.index)}: looks like a real Telegram id (${h.value}) — use 500000001-style synthetic ids`);
    }
  }
  return { problems, files, notes, denylist: denylistPath ? { path: denylistPath, values: needles.length } : null };
}

function resolveDenylist(root) {
  const explicit = process.env.CLAWGRAM_PII_DENYLIST?.trim();
  if (explicit) {
    // Named but missing is a broken setup, not "no denylist": falling through
    // to shape-only would be a quiet green exactly where it was asked for.
    if (!existsSync(explicit)) {
      console.error('check-pii: CLAWGRAM_PII_DENYLIST points at a file that does not exist');
      process.exit(2);
    }
    return explicit;
  }
  const sibling = resolve(root, '../../AI-Assistant-Bot/tests/denylist.local.txt');
  return existsSync(sibling) ? sibling : null;
}

function main() {
  const denylistPath = resolveDenylist(ROOT);
  const { problems, files, notes, denylist } = run({ root: ROOT, denylistPath });
  for (const note of notes) console.log(`check-pii: ${note}`);
  if (!denylist) {
    const msg = 'no denylist found (set CLAWGRAM_PII_DENYLIST) — shape check only; known handles and chat names are NOT checked';
    console.log(process.env.GITHUB_ACTIONS ? `::warning::check-pii: ${msg}` : `check-pii: ${msg}`);
  }
  if (problems.length) {
    console.error(`check-pii: ${problems.length} hit(s)\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`check-pii: ok (${files.length} files${denylist ? `, denylist ${denylist.values} values` : ''})`);
}

// Compared as real paths: `import.meta.url` is percent-encoded and resolved
// through symlinks, argv[1] is whatever the shell passed. A textual
// comparison skipped main() — exit 0, no output — in any path with a space,
// Cyrillic, or a symlink (audit r3 V1-08).
function invokedDirectly() {
  try {
    return Boolean(process.argv[1])
      && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (invokedDirectly()) main();
