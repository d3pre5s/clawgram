import readline from "node:readline";
import { TelegramClient } from "telegram";
import { StringSession } from "telegram/sessions";
import { readConfigFileSnapshotForWrite, type OpenClawConfig } from "openclaw/plugin-sdk/config-runtime";
import { CHANNEL_ID } from "./constants";
import { buildTelegramClientOptions, describeProxy } from "./proxy-config";
import { createConfigBackup, updateConfigFileDirectly } from "./update-config";

type TelegramAuthResult = {
  apiId: number;
  apiHash: string;
  sessionString: string;
};

type PromptApi = {
  ask: (question: string) => Promise<string>;
  askRequired: (question: string) => Promise<string>;
  askPositiveInteger: (question: string) => Promise<number>;
  askYesNo: (question: string, defaultValue?: boolean) => Promise<boolean>;
  close: () => void;
};

type CliFlags = {
  hello?: boolean;
  auth?: boolean;
};

function printRestartNotice(): void {
  console.log("");
  console.log("After applying config changes, restart OpenClaw:");
  console.log("openclaw gateway restart");
}

// Printed only right before a fragment that carries apiHash and sessionString,
// i.e. when the operator declined the automatic config write and has to paste
// the values by hand.
function printSecretWarning(): void {
  console.log("WARNING: the fragment below contains apiHash and sessionString.");
  console.log("They grant full access to this Telegram account. Do not paste them");
  console.log("into chats, issues or CI logs, and clear your terminal scrollback.");
  console.log("");
}

function createPrompt(): PromptApi {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const ask = (question: string): Promise<string> =>
    new Promise((resolve) => {
      rl.question(question, resolve);
    });

  return {
    ask,
    async askRequired(question: string): Promise<string> {
      for (;;) {
        const answer = (await ask(question)).trim();
        if (answer) {
          return answer;
        }

        console.log("Value is required.");
      }
    },
    async askPositiveInteger(question: string): Promise<number> {
      for (;;) {
        const answer = (await ask(question)).trim();
        if (!/^[1-9]\d*$/.test(answer)) {
          console.log("Enter a positive integer.");
          continue;
        }

        const parsed = Number(answer);
        if (!Number.isSafeInteger(parsed)) {
          console.log("Number is too large.");
          continue;
        }

        return parsed;
      }
    },
    async askYesNo(question: string, defaultValue = false): Promise<boolean> {
      for (;;) {
        const answer = (await ask(question)).trim().toLowerCase();
        if (!answer) {
          return defaultValue;
        }

        if ([ "y", "yes", "да", "д" ].includes(answer)) {
          return true;
        }

        if ([ "n", "no", "нет", "н" ].includes(answer)) {
          return false;
        }

        console.log("Please answer yes or no.");
      }
    },
    close(): void {
      rl.close();
    },
  };
}

function resolveDefaultAccountId(config: OpenClawConfig): string {
  const accounts = config?.channels?.[ CHANNEL_ID ]?.accounts;
  if (!accounts || typeof accounts !== "object") {
    return "default";
  }

  const firstAccountId = Object.keys(accounts).find((accountId) => accountId.trim());
  return firstAccountId?.trim() || "default";
}

function buildAccountConfigFragment(auth: TelegramAuthResult): Record<string, unknown> {
  return {
    enabled: true,
    apiId: auth.apiId,
    apiHash: auth.apiHash,
    sessionString: auth.sessionString,
    allowFrom: [ "*" ],
    groups: {
      "*": {
        enabled: true,
        groupPolicy: "mention",
        allowFrom: [ "*" ],
      },
    },
  };
}

function buildConfigFragment(accountId: string, auth: TelegramAuthResult): Record<string, unknown> {
  return {
    channels: {
      [ CHANNEL_ID ]: {
        accounts: {
          [ accountId ]: buildAccountConfigFragment(auth),
        },
      },
    },
  };
}

/**
 * The proxy the account this login is for already uses, if any.
 *
 * The login handshake carries the phone number, the code and the 2FA password,
 * and it used to go out from the host's real IP even on a deployment whose
 * whole point is that Telegram never sees it: this flow built its own client
 * and read no proxy at all. An unresolved SecretRef throws out of
 * `buildTelegramClientOptions` rather than silently falling back to a direct
 * connection — the same fail-closed rule the channel follows.
 */
function resolveAuthProxy(config: OpenClawConfig, accountId: string): unknown {
  return (config as any)?.channels?.[ CHANNEL_ID ]?.accounts?.[ accountId ]?.proxy;
}

async function runTelegramAuthorization(prompt: PromptApi, proxy?: unknown): Promise<TelegramAuthResult> {
  const apiId = await prompt.askPositiveInteger("Please enter your apiId: ");
  const apiHash = await prompt.askRequired("Please enter your apiHash: ");
  const clientOptions = buildTelegramClientOptions(proxy);
  if (clientOptions.proxy) {
    // Scheme only. The host, port and credentials are exactly what must not
    // reach a terminal, a screen share or CI scrollback.
    console.log(`Connecting through the account's ${describeProxy(clientOptions.proxy)} proxy.`);
  }
  const client = new TelegramClient(new StringSession(""), apiId, apiHash, clientOptions);

  try {
    await client.start({
      phoneNumber: async () => await prompt.askRequired("Please enter your number: "),
      password: async () => await prompt.askRequired("Please enter your password: "),
      phoneCode: async () => await prompt.askRequired("Please enter the code you received: "),
      onError: (error) => {
        console.log(error);
      },
    });

    return {
      apiId,
      apiHash,
      sessionString: String(client.session.save()),
    };
  } finally {
    await client.destroy().catch(() => undefined);
  }
}

async function runTelegramUserbotAuth(config: OpenClawConfig): Promise<void> {
  const prompt = createPrompt();

  try {
    console.log("Starting Clawgram authorization...");

    const authAccountId = resolveDefaultAccountId(config);
    const auth = await runTelegramAuthorization(prompt, resolveAuthProxy(config, authAccountId));
    console.log("Telegram authorization completed successfully.");
    console.log("");
    // The session string is a bearer secret for the whole Telegram account.
    // It is not printed here: stdout ends up in scrollback, CI logs and
    // screen-sharing. It is only shown below when the operator declines the
    // automatic config write and therefore has to paste it by hand.
    console.log(`Session string received (${auth.sessionString.length} chars) — kept out of this output.`);
    console.log("");

    const defaultAccountId = authAccountId;
    const rawAccountId = await prompt.ask(`Enter account id for config [${defaultAccountId}]: `);
    const accountId = rawAccountId.trim() || defaultAccountId;
    const shouldUpdateConfig = await prompt.askYesNo("Update OpenClaw config automatically? [y/N]: ", false);
    const { snapshot } = await readConfigFileSnapshotForWrite();

    if (!shouldUpdateConfig) {
      console.log("");
      printSecretWarning();
      console.log("JSON fragment for manual insertion:");
      console.log(JSON.stringify(buildConfigFragment(accountId, auth), null, 2));
      printRestartNotice();
      return;
    }

    if (!snapshot.exists || !snapshot.path) {
      console.log("");
      console.log("Automatic config update is unavailable because openclaw.json was not found.");
      console.log("");
      printSecretWarning();
      console.log("JSON fragment for manual insertion:");
      console.log(JSON.stringify(buildConfigFragment(accountId, auth), null, 2));
      printRestartNotice();
      return;
    }

    try {
      const backupPath = await createConfigBackup(snapshot.path);
      await updateConfigFileDirectly(snapshot.path, accountId, auth);

      console.log("");
      console.log(`OpenClaw config updated: ${snapshot.path}`);
      console.log(`Configured account id: ${accountId}`);
      if (backupPath) {
        console.log(`Config backup created: ${backupPath}`);
      }
      printRestartNotice();
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      console.log("");
      console.log(`Automatic config update failed: ${message}`);
      if (snapshot.issues.length > 0) {
        console.log("Current config validation issues:");
        for (const issue of snapshot.issues) {
          console.log(`- ${issue.path || "<root>"}: ${issue.message}`);
        }
      }
      console.log("");
      printSecretWarning();
      console.log("JSON fragment for manual insertion:");
      console.log(JSON.stringify(buildConfigFragment(accountId, auth), null, 2));
      printRestartNotice();
    }
  } finally {
    prompt.close();
  }
}

export async function runTelegramUserbotCliFlags(config: OpenClawConfig, options: CliFlags): Promise<void> {
  const enabledFlags = [ options.hello, options.auth ].filter(Boolean).length;

  if (enabledFlags === 0) {
    console.log("Specify one flag: --hello or --auth");
    return;
  }

  if (enabledFlags > 1) {
    console.log("Use only one flag at a time: --hello or --auth");
    return;
  }

  if (options.hello) {
    console.log("Hello from clawgram");
    return;
  }

  if (options.auth) {
    await runTelegramUserbotAuth(config);
  }
}

export async function runTelegramUserbotStandaloneCli(argv: string[], config: OpenClawConfig): Promise<number> {
  const flags = new Set(argv);
  const hasHelp = flags.has("-h") || flags.has("--help") || flags.has("help");

  if (argv.length === 0 || hasHelp) {
    console.log("Usage: clawgram-cli <--hello|--auth>");
    return 0;
  }

  const unsupportedArgs = argv.filter((arg) => ![ "--hello", "--auth" ].includes(arg));
  if (unsupportedArgs.length > 0) {
    console.log(`Unknown argument(s): ${unsupportedArgs.join(", ")}`);
    console.log("Usage: clawgram-cli <--hello|--auth>");
    return 1;
  }

  if (flags.has("--hello") || flags.has("--auth")) {
    await runTelegramUserbotCliFlags(config, {
      hello: flags.has("--hello"),
      auth: flags.has("--auth"),
    });
    return 0;
  }

  console.log("Specify one flag: --hello or --auth");
  return 1;
}
