import { createSubsystemLogger } from "openclaw/plugin-sdk/core";
import { normalizeScopeList } from "./history";
import { describeSendRefusal } from "./send-scope";

/**
 * Per-account scope as configured — the readers every action module shares.
 *
 * Lived at the top of `channel.ts` next to the dispatcher that used them;
 * moved out with the dispatcher's branches (audit B5-13, part 3). Pure
 * config readers: no runtime, no state.
 */

const actionLog = createSubsystemLogger("channels/clawgram");

/**
 * Read scope as configured for the account. Left `undefined` when the key is
 * absent so `isChatReadable` can tell "not configured" from "configured empty" —
 * the first means no restriction, the second denies everything.
 */
export function readAccountReadChats(account: any): string[] | undefined {
  return normalizeScopeList(account?.readChats);
}

export function resolveAccountReadChats(cfg: any, accountId: string): string[] | undefined {
  return readAccountReadChats(cfg?.channels?.[ "clawgram" ]?.accounts?.[ accountId ]);
}

/**
 * Outbound scope as configured. Handed to `isChatSendable` raw: an absent
 * value means "unrestricted" and an empty list means "deny", and only the
 * raw value tells those apart — same shape as `readChats`.
 */
export function resolveAccountSendChats(cfg: any, accountId: string): unknown {
  return cfg?.channels?.[ "clawgram" ]?.accounts?.[ accountId ]?.sendChats;
}

/** One refusal for every outbound action, so the three read the same. */
export function refuseOutboundOutsideScope(
  action: string,
  accountId: string,
  target: string,
): never {
  const refusal = describeSendRefusal(target);
  actionLog.warn(`clawgram ${action} refused: ${refusal.reason}`, { accountId, ...refusal.logFields });
  throw refusal.error;
}

/**
 * Who receives core's operational telemetry in a DM.
 */
export function resolveAccountOperatorIds(cfg: any, accountId: string): string[] {
  const account = cfg?.channels?.[ "clawgram" ]?.accounts?.[ accountId ];
  // Только явный список. Умолчание «operatorIds = allowFrom» делало
  // оператором каждого допущенного собеседника — и телеметрию с путями
  // secret-store получал любой из них (D2-03, A5-11). Не назван — не
  // назван: уведомления подавляются везде.
  const raw = account?.operatorIds;
  if (raw === undefined || raw === null) return [];
  const entries = Array.isArray(raw) ? raw : [ raw ];
  return entries.map((entry: unknown) => String(entry).trim()).filter(Boolean);
}

export function resolveAccountDiscoverChats(cfg: any, accountId: string): unknown {
  return cfg?.channels?.[ "clawgram" ]?.accounts?.[ accountId ]?.discoverChats;
}

/**
 * Management scope as configured. Handed to `isChatManageable` raw: unlike
 * `readChats`, an absent value already means "deny", so there is nothing to
 * tell apart — but the raw value keeps the two gates symmetrical.
 */
export function resolveAccountManageChats(cfg: any, accountId: string): unknown {
  return cfg?.channels?.[ "clawgram" ]?.accounts?.[ accountId ]?.manageChats;
}

/** Same normalization `readChats` gets, for the resolved-account copy. */
export function readAccountManageChats(account: any): string[] | undefined {
  return normalizeScopeList(account?.manageChats);
}
