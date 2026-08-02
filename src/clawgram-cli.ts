#!/usr/bin/env node

import { readConfigFileSnapshotForWrite } from "openclaw/plugin-sdk/config-runtime";
import { runTelegramUserbotStandaloneCli } from "./cli-core";

async function main(): Promise<void> {
  const { snapshot } = await readConfigFileSnapshotForWrite();
  const exitCode = await runTelegramUserbotStandaloneCli(process.argv.slice(2), snapshot.config);
  if (exitCode !== 0) {
    process.exitCode = exitCode;
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.stack || error.message : String(error);
  console.error(message);
  process.exitCode = 1;
});
