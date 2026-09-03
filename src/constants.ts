const CHANNEL_ID = "clawgram";
const CLI_COMMAND = "clawgram";

/**
 * Telegram's own service account: login codes, password-reset notices and
 * termination warnings arrive from it. Its messages are dropped on the way in
 * and refused on the way out — a login code reaching the agent is an account
 * takeover, not a privacy nuisance, so no `readChats` entry may enable it.
 */
const TELEGRAM_SERVICE_CHAT_ID = "777000";

export { CHANNEL_ID, CLI_COMMAND, TELEGRAM_SERVICE_CHAT_ID };
