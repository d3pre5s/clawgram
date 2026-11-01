#!/usr/bin/env node
// Invoked by the ClawHub CI job, from the checked-out release directory.
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { ensureNpmRelease, ensureClawhubRelease, retryClawhub } from "./release-automation.mjs";

const token = process.env.CLAWHUB_TOKEN;
const redact = (text) => token ? text.replaceAll(token, "[REDACTED]") : text;

async function clawhub(args, options = {}) {
  return retryClawhub(() => {
    try {
      return execFileSync("clawhub", args, { encoding: "utf8", stdio: "pipe", timeout: 1900000, maxBuffer: 4 * 1024 * 1024 });
    } catch (error) {
      // execFileSync's default error message includes argv (the login token).
      throw new Error(redact(`${error.stdout ?? ""}\n${error.stderr ?? ""}`.trim()) || "ClawHub command failed without diagnostics.");
    }
  }, options);
}

try {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tag = `v${pkg.version}`;
  const dryRun = process.argv.includes("--dry-run");
  if (pkg.name !== "clawgram" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error("Expected a stable clawgram version.");
  if (!dryRun && process.env.RELEASE_REF !== tag) throw new Error("Release tag/version mismatch.");
  if (!dryRun) await ensureNpmRelease({ name: pkg.name, version: pkg.version, commit }, { recovery: true });

  const publish = async () => {
    if (!token) throw new Error("CLAWHUB_TOKEN is required for ClawHub publication.");
    await clawhub(["login", "--token", token], { readOnly: true });
    const args = ["package", "publish", ".", "--family", "code-plugin", "--version", pkg.version,
      "--source-repo", "d3pre5s/clawgram", "--source-ref", tag, "--source-commit", commit];
    if (dryRun) args.push("--dry-run");
    else args.push("--wait", "--wait-timeout", "1800");
    args.push("--json");
    const result = JSON.parse(await clawhub(args, { readOnly: dryRun }));
    console.log(redact(JSON.stringify(result, null, 2)));
    if (!dryRun && result.publicationStatus !== "published") throw new Error("ClawHub did not confirm definitive publication.");
  };
  if (dryRun) await publish();
  else await ensureClawhubRelease({ name: pkg.name, version: pkg.version, commit }, { publish });
} catch (error) {
  console.error(redact(error.message));
  process.exitCode = 1;
}
