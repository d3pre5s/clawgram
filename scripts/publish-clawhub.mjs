#!/usr/bin/env node
/**
 * Publishes the current version to ClawHub from this machine.
 *
 * Exists so the ClawHub token never has to be copied into GitHub. CI publishes
 * to npm — the registry that matters for `openclaw plugins install` — and skips
 * ClawHub when `CLAWHUB_TOKEN` is unset. This script closes that gap locally,
 * using the token the `clawhub` CLI already holds.
 *
 * Safe to re-run: if ClawHub already carries this version it does nothing.
 *
 *   npm run release:clawhub            # publish
 *   npm run release:clawhub -- --dry-run
 */

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");

function run(args, opts = {}) {
  return execFileSync("clawhub", args, { encoding: "utf8", stdio: opts.quiet ? "pipe" : "inherit" });
}

function capture(args) {
  try {
    return execFileSync("clawhub", args, { encoding: "utf8", stdio: [ "ignore", "pipe", "ignore" ] });
  } catch {
    return "";
  }
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" }).trim();
}

const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const version = pkg.version;

// A token the CLI cannot validate is the common failure, and its error is
// otherwise buried under a publish attempt.
const who = capture([ "whoami" ]).trim();
if (!who) {
  console.error("clawhub is not logged in — run `clawhub login` first");
  process.exit(1);
}
console.log(`publishing as ${who}`);

const published = (capture([ "package", "explore", "clawgram", "--family", "code-plugin" ])
  .match(/v(\d+\.\d+\.\d+)/) ?? [])[ 1 ];

if (published === version) {
  console.log(`ClawHub already carries ${version} — nothing to do`);
  process.exit(0);
}
console.log(`ClawHub has ${published ?? "nothing"}, package.json has ${version}`);

// The tag is what CI published to npm from; pointing ClawHub at the same commit
// keeps the two registries describing one artifact rather than two.
const tag = `v${version}`;
let commit;
try {
  commit = git([ "rev-parse", `${tag}^{commit}` ]);
} catch {
  console.error(`tag ${tag} does not exist — cut the release first, then publish here`);
  process.exit(1);
}

const args = [
  "package", "publish", ".",
  "--family", "code-plugin",
  "--version", version,
  "--source-repo", "d3pre5s/clawgram",
  "--source-ref", tag,
  "--source-commit", commit,
];

if (dryRun) {
  args.push("--dry-run");
}

run(args);
