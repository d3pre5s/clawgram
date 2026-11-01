#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, appendFileSync } from "node:fs";
import { ensureNpmRelease } from "./release-automation.mjs";

try {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  const commit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const ref = process.env.RELEASE_REF;
  const recovery = process.env.RECOVER_CLAWHUB === "true";
  const dryRun = process.env.DRY_RUN === "true";
  if (pkg.name !== "clawgram" || !/^\d+\.\d+\.\d+$/.test(pkg.version)) {
    throw new Error("Expected a stable clawgram package version.");
  }
  if ((!dryRun || recovery) && ref !== `v${pkg.version}`) {
    throw new Error("Release tag does not match package.json version.");
  }
  const publish = () => {
    // No NODE_AUTH_TOKEN fallback: the workflow must authenticate through OIDC.
    if (!dryRun && (!process.env.ACTIONS_ID_TOKEN_REQUEST_URL || !process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN)) {
      throw new Error("GitHub OIDC is unavailable; grant id-token: write to the npm job.");
    }
    // Modern npm rejects publish --dry-run for versions already on npm.
    // Build/tests ran explicitly in CI; pack verifies the rehearsal artifact.
    const args = dryRun ? ["pack", "--dry-run"] : ["publish", "--access", "public", "--provenance"];
    execFileSync("npm", args, { stdio: "inherit" });
  };
  if (dryRun) publish();
  else await ensureNpmRelease({ name: pkg.name, version: pkg.version, commit }, { recovery, publish });

  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `commit=${commit}\nrelease_ref=${ref}\n`);
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
