import { normalizeChatKey } from "./history";

/**
 * Outbound scope for the account: who this account may write to.
 *
 * Reading has had a declared scope since 2.x (`readChats`), management has
 * one (`manageChats`), and sending had none: `send`, `upload-file` and
 * `react` resolved whatever target the caller named and delivered it. The
 * account is a person's own Telegram account, so an injected turn could
 * message strangers under the owner's name, or carry a work chat's content
 * into an attacker's DM one `send` at a time (finding A5-12).
 *
 * Two decisions worth stating, because both could reasonably have gone the
 * other way:
 *
 * 1. **An absent `sendChats` still allows sending.** `manageChats` denies by
 *    default because management arrived as a new capability; sending is what
 *    this plugin has always done, and flipping it to "current conversation
 *    only" would silence every existing deployment on upgrade — including
 *    scheduled digests that legitimately write to an id nobody is talking to
 *    right now. A deployment that wants the boundary writes `sendChats`, and
 *    then it is a boundary in code rather than a sentence in a prompt.
 *
 * 2. **A phone number is refused in every configuration**, wildcard included.
 *    Messaging a raw number starts a conversation with someone who never
 *    interacted with the account and hands them the account's identity;
 *    no deployment has a reason to do that from an assistant, and the
 *    address book is not the model's to walk.
 */

/** Anything that looks like a dialable number rather than a chat we know. */
export function isPhoneNumberTarget(target: unknown): boolean {
  const raw = String(target ?? "").trim();
  if (!raw) return false;
  // A Telegram chat id is digits (a user) or `-100…` (a group); a phone
  // number is what a person writes with a plus, spaces, dashes or brackets.
  // The `+` is the giveaway that survives normalisation, and a long digit
  // string with separators is the other spelling of the same thing.
  const compact = raw.replace(/[\s()\-.]/g, "");
  if (/^\+\d{6,15}$/.test(compact)) return true;
  return /[\s()\-.]/.test(raw) && /^\+?\d[\d\s()\-.]{5,}$/.test(raw);
}

function normalizeScope(sendChats: unknown): string[] {
  if (sendChats === undefined || sendChats === null) return [];
  return (Array.isArray(sendChats) ? sendChats : [ sendChats ])
    .map(normalizeChatKey)
    .filter(Boolean);
}

/** True while the account has a declared outbound scope at all. */
export function isSendScopeConfigured(sendChats: unknown): boolean {
  return sendChats !== undefined && sendChats !== null;
}

export function isChatSendable(target: unknown, sendChats?: unknown): boolean {
  if (isPhoneNumberTarget(target)) return false;

  if (!isSendScopeConfigured(sendChats)) return true;

  const entries = normalizeScope(sendChats);
  // A configured empty list is a decision, not an oversight: deny, the same
  // way `readChats: []` denies rather than reading everything.
  if (entries.length === 0) return false;
  if (entries.includes("*")) return true;

  return entries.includes(normalizeChatKey(target));
}


/**
 * Область отправки каждого аккаунта, запомненная при его старте.
 *
 * В `outbound.resolveTarget` и `sendText` конфига нет — ядро зовёт их с
 * `{ accountId, to }`, — а тащить её туда параметром значило бы менять
 * контракт ядра ради одной проверки. Тот же приём уже применён к списку
 * операторов (`system-notice.ts`), и по той же причине.
 *
 * Перезапуск канала при правке конфига обновляет запись; аккаунт, о котором
 * ничего не помним, ведёт себя как аккаунт без области — то есть отправка
 * разрешена, но телефонный адресат всё равно отвергнут.
 */
const sendScopeByAccount = new Map<string, unknown>();

export function rememberSendScope(accountId: string, sendChats: unknown): void {
  sendScopeByAccount.set(accountId, sendChats);
}

export function sendScopeFor(accountId: string): unknown {
  return sendScopeByAccount.get(accountId);
}

export function forgetSendScope(accountId: string): void {
  sendScopeByAccount.delete(accountId);
}
