#!/usr/bin/env node
// Refuses to publish a real person's Telegram identity.
//
// 2.27.0–2.29.0 shipped a third party's numeric id in `dist/` through a source
// comment, and the tests carried real handles and chat ids from the deployment
// that motivated each fix. A fixture is written from memory of an incident, so
// the incident's real values slip in; nothing downstream looks for them, and
// npm cannot take a published version back.
//
// Two nets, both over what the package and the repository show the world
// (src, test, README, CHANGELOG):
//   1. a denylist kept OUTSIDE git — the values themselves must not be here.
//      Path: $CLAWGRAM_PII_DENYLIST, else the control repository's
//      tests/denylist.local.txt next to this checkout, else skipped with a note;
//   2. a shape check: a standalone 9–10 digit number (a user id) or a -100
//      supergroup id whose digits look like a real id rather than a synthetic
//      one (500000001, 1000000002, 123456789, a unix timestamp).
//
// Exit 1 names file:line and the kind of hit, never the denylisted value.

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SCAN = ['src', 'test', 'README.md', 'CHANGELOG.md'];

function files(path) {
  const abs = join(ROOT, path);
  if (!existsSync(abs)) return [];
  if (statSync(abs).isFile()) return [abs];
  return readdirSync(abs, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? files(join(path, e.name)) : [join(abs, e.name)]);
}

function denylist() {
  const candidates = [
    process.env.CLAWGRAM_PII_DENYLIST,
    resolve(ROOT, '../../AI-Assistant-Bot/tests/denylist.local.txt'),
  ].filter(Boolean);
  const path = candidates.find((p) => existsSync(p));
  if (!path) return { path: null, values: [] };
  // The maintainer's own public identity (author, repository URL) is in
  // package.json on purpose; the control repository's denylist forbids it
  // there, not here.
  const published = readFileSync(join(ROOT, 'package.json'), 'utf8');
  const values = readFileSync(path, 'utf8').split('\n')
    .map((l) => l.trim()).filter((l) => l && !l.startsWith('#') && !published.includes(l));
  return { path, values };
}

/** A synthetic id is what a person types on purpose; a real one is noise. */
export function looksSynthetic(digits) {
  if (new Set(digits).size <= 4) return true;                       // 500000001, 100200300
  if ('01234567890123'.includes(digits) || '98765432109876'.includes(digits)) return true;
  if (/^(12345678|98765432|1001234567)/.test(digits)) return true;  // sequences with a tail
  if (digits.length === 10 && /^1[5-9]\d{8}$/.test(digits)) return true; // unix seconds
  return false;
}

export function shapeHits(text) {
  const hits = [];
  const re = /(?<![0-9A-Za-z_.])(-100\d{10}|-?\d{9,10})(?![0-9A-Za-z_])/g;
  for (const m of text.matchAll(re)) {
    const digits = m[1].replace(/^-100(?=\d{10}$)/, '').replace(/^-/, '');
    if (!looksSynthetic(digits)) hits.push({ index: m.index, value: m[1] });
  }
  return hits;
}

function lineOf(text, index) {
  return text.slice(0, index).split('\n').length;
}

function main() {
  const { path: denyPath, values } = denylist();
  const problems = [];
  for (const file of SCAN.flatMap(files)) {
    const text = readFileSync(file, 'utf8');
    const rel = relative(ROOT, file);
    for (const v of values) {
      const i = text.indexOf(v);
      if (i !== -1) problems.push(`${rel}:${lineOf(text, i)}: value from the denylist`);
    }
    for (const h of shapeHits(text)) {
      problems.push(`${rel}:${lineOf(text, h.index)}: looks like a real Telegram id (${h.value}) — use 500000001-style synthetic ids`);
    }
  }
  if (!denyPath) console.log('check-pii: no denylist found (set CLAWGRAM_PII_DENYLIST) — shape check only');
  if (problems.length) {
    console.error(`check-pii: ${problems.length} hit(s)\n  ${problems.join('\n  ')}`);
    process.exit(1);
  }
  console.log(`check-pii: ok (${SCAN.flatMap(files).length} files${denyPath ? `, denylist ${values.length} values` : ''})`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
