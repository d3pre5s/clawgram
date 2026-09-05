/**
 * A Map whose entries stop existing on their own.
 *
 * Three module-level maps kept per-message state — the address a group reply
 * greets, when a visible reply went out, when the turn last spoke for itself
 * — and only one of them ever swept anything. The other two grew by one entry
 * per dispatched group message and per agent send, and nothing removed an
 * entry that was never read back: an unanswered mention, a send whose echo
 * never came. The gateway is restarted rarely by design, so the leak is slow
 * and permanent rather than dramatic (finding A6-16).
 *
 * Two bounds rather than one, because they fail differently:
 *
 * - **Time.** An entry is gone once its TTL passes, whether or not anyone
 *   asks for it. Sweeping happens on write, so a quiet process does no work
 *   and a busy one pays a little on each message.
 * - **Count.** A cap covers the case time cannot: many distinct keys inside
 *   one TTL window. When it is hit the entry expiring soonest goes first —
 *   it was closest to worthless anyway.
 *
 * `now` is a parameter everywhere so tests can move time without sleeping,
 * the way the callers already did.
 */
export class ExpiringMap<V> {
  private readonly entries = new Map<string, { value: V; expiresAt: number }>();

  constructor(
    private readonly ttlMs: number,
    private readonly maxEntries = 1000,
  ) {}

  set(key: string, value: V, now: number = Date.now()): void {
    this.prune(now);
    this.entries.set(key, { value, expiresAt: now + this.ttlMs });
    this.evictOverflow();
  }

  /** The value while it is still alive; an expired entry is dropped, not returned. */
  get(key: string, now: number = Date.now()): V | undefined {
    const stored = this.entries.get(key);
    if (!stored) {
      return undefined;
    }

    if (stored.expiresAt <= now) {
      this.entries.delete(key);
      return undefined;
    }

    return stored.value;
  }

  /** Reads and removes in one step — for state a single consumer owns. */
  take(key: string, now: number = Date.now()): V | undefined {
    const value = this.get(key, now);
    // The delete happens even when the entry was already expired: `get` has
    // dropped it in that case, and deleting a missing key is a no-op.
    this.entries.delete(key);
    return value;
  }

  delete(key: string): void {
    this.entries.delete(key);
  }

  /** Test seam: module state must not leak between suites. */
  clear(): void {
    this.entries.clear();
  }

  get size(): number {
    return this.entries.size;
  }

  prune(now: number = Date.now()): void {
    for (const [ key, stored ] of this.entries.entries()) {
      if (stored.expiresAt <= now) {
        this.entries.delete(key);
      }
    }
  }

  private evictOverflow(): void {
    if (this.entries.size <= this.maxEntries) {
      return;
    }

    // Insertion order is not expiry order once a key is rewritten, so the
    // victim is chosen by expiry rather than by being first in the map.
    let oldestKey: string | undefined;
    let oldestExpiry = Infinity;
    for (const [ key, stored ] of this.entries.entries()) {
      if (stored.expiresAt < oldestExpiry) {
        oldestExpiry = stored.expiresAt;
        oldestKey = key;
      }
    }

    if (oldestKey !== undefined) {
      this.entries.delete(oldestKey);
    }
  }
}
