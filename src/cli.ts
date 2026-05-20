import type { OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { CLI_COMMAND } from "./constants";
import { runTelegramUserbotCliFlags } from "./cli-core";

export function registerTelegramUserbotCli(program: any, config: OpenClawConfig): void {
  program
    .command(CLI_COMMAND)
    .description("Telegram Userbot CLI utilities")
    .option("--hello", "Print a greeting from the telegram-userbot plugin")
    .option("--auth", "Authorize a Telegram account for telegram-userbot")
    .action(async (options: { hello?: boolean; auth?: boolean }) => {
      await runTelegramUserbotCliFlags(config, options);
    });
}

export function getTelegramUserbotCliDescriptors(): Array<{
  name: string;
  description: string;
  hasSubcommands: boolean;
}> {
  return [
    {
      name: CLI_COMMAND,
      description: "Telegram Userbot CLI utilities",
      hasSubcommands: false,
    },
  ];
}
