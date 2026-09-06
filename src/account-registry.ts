import type { RuntimeMap } from "./types";

/**
 * What the plugin remembers about a started account, and the one place it
 * remembers it.
 *
 * `outbound.resolveTarget`, `sendText` and `sendMedia` are called by core with
 * `{ accountId, to }` and no config, yet both the send scope (`sendChats`,
 * A5-12) and the operator list (`operatorIds`, A5-11) must gate them. Each
 * was kept in its own module-level map, filled in `startAccount` and never
 * cleared when the account stopped — two registries with one lifecycle and
 * no stop (audit D2-11). One record per account now: written when the
 * account connects, dropped when it disconnects, read where core gives no
 * config. A restart of the channel after a config edit rewrites the record.
 *
 * An account with no record behaves like one with no scope configured: sends
 * are allowed (a phone-number target is still refused) and nobody is an
 * operator, so system notices are dropped.
 */
export type AccountRecord = {
  /** Raw `sendChats` as configured; absent = unrestricted, `[]` = deny. */
  sendChats: unknown;
  operatorIds: readonly string[];
};

const records = new Map<string, AccountRecord>();

export function rememberAccount(accountId: string, record: AccountRecord): void {
  records.set(accountId, { sendChats: record.sendChats, operatorIds: [ ...record.operatorIds ] });
}

export function forgetAccount(accountId: string): void {
  records.delete(accountId);
}

export function sendScopeFor(accountId: string): unknown {
  return records.get(accountId)?.sendChats;
}

export function operatorIdsFor(accountId: string): readonly string[] {
  return records.get(accountId)?.operatorIds ?? [];
}

/**
 * The connected runtime for an account, or a refusal naming it.
 *
 * One helper instead of the copies of this three-liner that used to sit in
 * each dispatch branch (A6-11 removed six; D2-11 the remaining seven).
 */
export function requireRuntime(runtimes: RuntimeMap, accountId: string) {
  const gram = runtimes.get(accountId);
  if (!gram) {
    throw new Error(`clawgram: runtime not found for account ${accountId}`);
  }

  return gram;
}
