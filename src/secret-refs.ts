/**
 * SecretRef support for the account's credentials.
 *
 * `apiHash` and `sessionString` are bearer credentials for the whole Telegram
 * account, and until now they could only live as plaintext in `openclaw.json` —
 * a file that gets backed up, copied between machines and pasted into issues.
 * Every other secret in this deployment is a reference resolved at start-up;
 * these were the exception. Proxy credentials are here for the same reason.
 *
 * A reference is `{ source, provider, id }`, and OpenClaw resolves a batch of
 * them into a map keyed by `source:provider:id`. Collecting and substituting is
 * kept pure so it can be tested without a secret store; the resolution call
 * itself lives in the channel's account start-up.
 *
 * Nothing here logs a value, and an unresolved reference is reported by field
 * name only. A missing secret is a configuration error, and the error message
 * for it must not become the leak it was meant to prevent.
 */

export type SecretRefLike = {
  source: string;
  provider: string;
  id: string;
};

/** Credential fields that accept a reference, in the order they are reported. */
const ACCOUNT_SECRET_FIELDS = [ "apiHash", "sessionString" ] as const;
const PROXY_SECRET_FIELDS = [ "username", "password" ] as const;

/**
 * Must match OpenClaw's own keying, or every lookup misses and a correctly
 * configured secret looks unresolvable.
 */
export function secretRefKey(ref: SecretRefLike): string {
  return `${ref.source}:${ref.provider}:${ref.id}`;
}

/**
 * Shape check only. A partially written reference is treated as "not a
 * reference" rather than as an error, so a typo cannot be mistaken for a
 * resolvable secret and silently blank a credential.
 */
function asSecretRef(value: unknown): SecretRefLike | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const candidate = value as Record<string, unknown>;
  const { source, provider, id } = candidate;
  if (typeof source !== "string" || typeof provider !== "string" || typeof id !== "string") {
    return undefined;
  }

  if (!source.trim() || !provider.trim() || !id.trim()) {
    return undefined;
  }

  return { source, provider, id };
}

/** Every credential slot, as `[path, value]` pairs — account fields and proxy alike. */
function* eachSecretSlot(account: any): Generator<[ string, unknown ]> {
  for (const field of ACCOUNT_SECRET_FIELDS) {
    yield [ field, account?.[ field ] ];
  }

  for (const field of PROXY_SECRET_FIELDS) {
    yield [ `proxy.${field}`, account?.proxy?.[ field ] ];
  }
}

/**
 * References this account needs resolved, deduplicated: two fields pointing at
 * the same secret must not become two lookups.
 */
export function collectAccountSecretRefs(account: any): SecretRefLike[] {
  const byKey = new Map<string, SecretRefLike>();

  for (const [ , value ] of eachSecretSlot(account)) {
    const ref = asSecretRef(value);
    if (ref) {
      byKey.set(secretRefKey(ref), ref);
    }
  }

  return [ ...byKey.values() ];
}

/**
 * Substitutes resolved values into a copy of the account.
 *
 * A value that did not resolve is left as the reference object and its field
 * named in `missing`. Writing the reference through as a string would produce
 * "[object Object]", which Telegram rejects with a complaint about the
 * credential itself — sending whoever reads it to check a secret that was
 * never the problem.
 */
export function applyAccountSecrets(
  account: any,
  values: Map<string, unknown>,
): { account: any; missing: string[] } {
  const missing: string[] = [];
  const resolved = { ...account };
  if (account?.proxy && typeof account.proxy === "object") {
    resolved.proxy = { ...account.proxy };
  }

  for (const field of ACCOUNT_SECRET_FIELDS) {
    const ref = asSecretRef(account?.[ field ]);
    if (!ref) {
      continue;
    }

    const value = values.get(secretRefKey(ref));
    if (typeof value === "string") {
      resolved[ field ] = value;
    } else {
      missing.push(field);
    }
  }

  for (const field of PROXY_SECRET_FIELDS) {
    const ref = asSecretRef(account?.proxy?.[ field ]);
    if (!ref) {
      continue;
    }

    const value = values.get(secretRefKey(ref));
    if (typeof value === "string") {
      resolved.proxy[ field ] = value;
    } else {
      missing.push(`proxy.${field}`);
    }
  }

  return { account: resolved, missing };
}

/**
 * True while any credential is still a reference. Used as a last gate before
 * handing the account to GramJS, where an unresolved value would travel into a
 * login attempt.
 */
export function hasUnresolvedSecretRef(account: any): boolean {
  for (const [ , value ] of eachSecretSlot(account)) {
    if (asSecretRef(value)) {
      return true;
    }
  }

  return false;
}

/**
 * Reads a credential straight out of the config.
 *
 * A reference is returned untouched, for resolution later; everything else is
 * stringified exactly as the config reader always did. The point is the first
 * half: `String(ref)` yields "[object Object]", which travels into a Telegram
 * login and returns as a complaint about the credential rather than about the
 * secret that failed to resolve.
 */
export function readSecretInput(value: unknown): string | SecretRefLike {
  const ref = asSecretRef(value);
  if (ref) {
    return ref;
  }

  return String(value ?? "");
}
