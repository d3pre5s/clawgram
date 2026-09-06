/**
 * Core's operational chatter — and why a group chat never sees it.
 *
 * When a tool call fails or the model silently degrades, core appends a
 * status line to the turn's outbound payloads: `⚠️ 🛠️ Exec failed: …`,
 * `⚠️ ✉️ Message failed`, `↪️ Model Fallback: …`. In a DM with the owner that
 * is legitimate telemetry. In a group it is the assistant narrating its own
 * kitchen to an audience the message was never for — measured three days in a
 * row in the owner's work chat (2026-08-30 … 09-01): a jq stack trace with
 * server paths, a bare "Message failed", an exec step list. The people in the
 * chat cannot act on any of it, and the owner reads it as the assistant
 * being broken.
 *
 * Detection is by core's own exact prefixes, not by keyword: the assistant is
 * allowed to *say* "⚠️" or discuss a failure in its own words — only core's
 * machine-built notices match. The list mirrors what core actually emits
 * (`isCronToolWarning` matches `⚠️ 🛠️ ` verbatim; the message-failed check is
 * the same normalized comparison core uses; fallback notices are built by
 * `buildFallbackNotice`/`buildFallbackClearedNotice`).
 *
 * Nothing is lost by dropping them here: the same failures live in the run's
 * diagnostics, the cron job's `lastError` and the gateway log. The drop is
 * logged with the notice's class and length — never its text, which has
 * already been seen carrying secret-store paths and full shell commands.
 */

const TOOL_WARNING_PREFIX = "⚠️ 🛠️ ";
const MESSAGE_FAILED_PREFIX = "⚠️ ✉️ message failed";
const FALLBACK_NOTICE_PREFIX = "↪️ model fallback";

export type SystemNoticeKind = "tool-warning" | "message-failed" | "model-fallback";

/**
 * Classifies core's operational status lines. `undefined` means the text is a
 * real reply and must be delivered untouched.
 */
export function classifySystemNotice(text: string): SystemNoticeKind | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }

  if (trimmed.startsWith(TOOL_WARNING_PREFIX)) {
    return "tool-warning";
  }

  const lower = trimmed.toLowerCase();
  if (lower === MESSAGE_FAILED_PREFIX || lower.startsWith(`${MESSAGE_FAILED_PREFIX}:`)) {
    return "message-failed";
  }
  // Covers both "↪️ Model Fallback: …" and "↪️ Model Fallback cleared: …".
  if (lower.startsWith(FALLBACK_NOTICE_PREFIX)) {
    return "model-fallback";
  }

  return undefined;
}

/**
 * A notice glued to a real reply is not a notice: `classifySystemNotice` looks
 * at the start of the text on purpose, so an answer that quotes or discusses a
 * warning still goes out. Only a payload that IS the notice — the whole text,
 * possibly with the group-address prefix core adds — is suppressible.
 *
 * The address prefix ("@name, ") is applied by the channel after this check,
 * so the text seen here is core's payload verbatim.
 */
export function shouldSuppressGroupSystemNotice(params: {
  targetKind: "user" | "group" | "channel" | undefined;
  text: string;
  /**
   * Кому адресовано. Нужен только для лички: в группе решение не зависит от
   * адресата, а в личке — зависит целиком.
   */
  to?: string | number;
  /**
   * Кто считается оператором. `accounts.*.operatorIds`, а при его отсутствии —
   * `allowFrom`, если это конкретный список.
   */
  operatorIds?: readonly string[];
}): SystemNoticeKind | undefined {
  if (params.targetKind === "group" || params.targetKind === "channel") {
    return classifySystemNotice(params.text);
  }

  // Личка держала телеметрию на допущении «здесь читает тот, кто запустил
  // агента». Допущение неверно: в личку пишет всякий, кто попал в `allowFrom`,
  // и посторонний, чей ход уронил инструмент, получал `⚠️ 🛠️ Bash failed:`
  // с полной командой и путями вроде /opt/openclaw-secrets/… (A5-11).
  //
  // Поэтому телеметрия уходит только названному оператору. Список пуст или
  // содержит `*` — значит «оператор» не определён, и уведомление подавляется:
  // потерять диагностику дешевле, чем отдать раскладку инфраструктуры
  // незнакомцу, тем более что те же сбои лежат в диагностике прогона,
  // в `lastError` джоба и в логе gateway.
  if (!isOperatorRecipient(params.to, params.operatorIds)) {
    return classifySystemNotice(params.text);
  }

  return undefined;
}

export function isOperatorRecipient(
  to: string | number | undefined,
  operatorIds: readonly string[] | undefined,
): boolean {
  if (to === undefined || to === null || String(to).trim() === "") return false;
  if (!operatorIds || operatorIds.length === 0) return false;
  // `*` здесь не «все операторы», а «оператор не назван»: в списке отправителей
  // звёздочка означает «кто угодно», и телеметрию кому угодно слать нельзя.
  if (operatorIds.some((id) => String(id).trim() === "*")) return false;
  const target = String(to).trim().replace(/^@/, "").toLowerCase();
  return operatorIds.some((id) => String(id).trim().replace(/^@/, "").toLowerCase() === target);
}
