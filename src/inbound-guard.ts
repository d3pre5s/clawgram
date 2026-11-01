import { normalizeTelegramEvent } from "./normalize";
import { loadGuardState, saveGuardState, type GuardState } from "./inbound-guard-state";

export const GUARD_INTERVAL_MS = 120000;
export const GUARD_GRACE_MS = 60000;
export const GUARD_MAX_AGE_MS = 86400000;
export type GuardStatus = {
  enabled: boolean; running: boolean; errorCode: string | null; incident: number;
  activatedAt: number | null; lastCheckAt: number | null; lastSuccessAt: number | null;
  recoveredCount: number; uncertainCount: number; pendingCount: number;
  oldestPendingAt: number | null;
};
type Options = {
  accountId: string; selfId: string; ownerId: string; storePath: string;
  readPage: (args: { after: number; since: number; limit: number }) => Promise<unknown[]>;
  /** False means the pipeline observed an error; it does not permit an automatic retry. */
  dispatch: (event: unknown) => Promise<boolean>;
  allowed: () => boolean;
  now?: () => number;
  readTimeoutMs?: number;
};

/** One instance per running account. Claims are synchronous before the first await. */
export class InboundGuard {
  private state?: GuardState;
  private blocked = false;
  private stopped = false;
  private checking = false;
  private started = false;
  private timer?: ReturnType<typeof setTimeout>;
  private lastCheckAt: number | null = null;
  private failures = 0;
  private clock: () => number;
  private recoverSince: number;

  constructor(private options: Options) {
    this.clock = options.now ?? Date.now;
    // Earlier processes may have dispatched while this journal was disabled or
    // unwritable. Telegram dates have second precision: exclude the boundary second.
    this.recoverSince = Math.floor(this.clock() / 1000) * 1000 + 1000;
    try {
      this.state = loadGuardState(options.storePath, JSON.stringify([ options.accountId, options.selfId, options.ownerId ]), this.clock());
      this.persist();
    } catch { this.blocked = true; }
  }

  status(): GuardStatus {
    const entries = Object.values(this.state?.entries ?? {});
    return {
      enabled: true, running: !this.stopped && !this.blocked,
      errorCode: this.blocked ? "state-unavailable" : this.state?.errorCode ?? null,
      incident: this.state?.incident ?? 0, activatedAt: this.state?.activatedAt ?? null,
      lastCheckAt: this.lastCheckAt, lastSuccessAt: this.state?.lastSuccessAt ?? null,
      recoveredCount: this.state?.recoveredCount ?? 0,
      uncertainCount: entries.filter(e => e.phase === "uncertain").length,
      pendingCount: entries.filter(e => e.phase === "claimed").length,
      oldestPendingAt: entries.some(e => e.phase === "claimed")
        ? Math.min(...entries.filter(e => e.phase === "claimed").map(e => e.at)) : null,
    };
  }

  private persist(): boolean {
    if (this.blocked || !this.state) return false;
    try {
      for (const [id, e] of Object.entries(this.state.entries)) {
        if (Number(id) <= this.state.cursor && e.phase === "settled") delete this.state.entries[id];
      }
      if (Object.keys(this.state.entries).length > 10000) throw new Error("Guard state is full");
      saveGuardState(this.options.storePath, this.state); return true;
    } catch { this.blocked = true; return false; }
  }

  private error(code: string | null): void {
    if (this.stopped || !this.state) return;
    if (this.state.errorCode !== code) { this.state.errorCode = code; this.state.incident++; }
    this.persist();
  }

  private ownerMessage(event: unknown) {
    const n = normalizeTelegramEvent(event, this.options.accountId);
    return n?.chatType === "direct" && n.chatId === this.options.ownerId
      && n.senderId === this.options.ownerId && !n.isOutgoing ? n : undefined;
  }

  async accept(event: unknown, recovered = false): Promise<boolean> {
    if (this.stopped) return false;
    const n = this.ownerMessage(event);
    // A broken recovery journal must not disable the ordinary inbound channel.
    if (!n || this.blocked || !this.state) {
      return recovered ? false : this.options.dispatch(event);
    }
    if (recovered && !this.options.allowed()) return false;
    const id = Number(n.messageId);
    if (!Number.isSafeInteger(id) || id <= 0 || !Number.isFinite(n.timestamp)) {
      return recovered ? false : this.options.dispatch(event);
    }
    if (id <= this.state.cursor || this.state.entries[id]) return false;
    if (n.timestamp! < this.state.activatedAt) return recovered ? false : this.options.dispatch(event);
    if (n.timestamp! < this.recoverSince) {
      this.state.entries[id] = { phase: "uncertain", at: this.clock() }; this.state.incident++;
      this.persist(); return false;
    }
    this.state.entries[id] = { phase: "claimed", at: this.clock() };
    if (!this.persist()) return recovered ? false : this.options.dispatch(event);
    let ok = false;
    try { ok = await this.options.dispatch(event); }
    catch { /* The action may already have happened. Do not replay. */ }
    // An old account instance must not overwrite the next instance's journal.
    if (this.stopped) return true;
    this.state.entries[id].phase = ok ? "settled" : "uncertain";
    if (!ok || recovered) this.state.incident++;
    if (ok && recovered) this.state.recoveredCount++;
    this.persist();
    return true;
  }

  private async page(): Promise<unknown[]> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.options.readPage({ after: this.state!.cursor, since: this.state!.activatedAt, limit: 100 }),
        new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error("History timeout")), this.options.readTimeoutMs ?? 15000); }),
      ]);
    } finally { if (timeout) clearTimeout(timeout); }
  }

  async check(): Promise<void> {
    if (this.stopped || this.blocked || this.checking || !this.state) return;
    this.checking = true; this.lastCheckAt = this.clock();
    try {
      if (!this.options.allowed()) { this.error("access-denied"); return; }
      let recovered = 0;
      for (let page = 0; page < 5; page++) {
        let rows: unknown[];
        try { rows = await this.page(); }
        catch { this.failures++; this.error("history-unavailable"); return; }
        if (this.stopped) return;
        if (!this.options.allowed()) { this.error("access-denied"); return; }
        const normalized = Array.isArray(rows) ? rows.map(message => normalizeTelegramEvent({ message }, this.options.accountId)) : [];
        let previous = this.state.cursor;
        if (!Array.isArray(rows) || rows.length > 100 || normalized.some(n => {
          const id = Number(n?.messageId);
          const invalid = !n || n.chatType !== "direct" || n.chatId !== this.options.ownerId
            || !Number.isSafeInteger(id) || id <= previous || !Number.isFinite(n.timestamp)
            || (!n.isOutgoing && n.senderId !== this.options.ownerId);
          previous = id; return invalid;
        })) { this.error("history-invalid"); return; }
        this.failures = 0; this.state.lastSuccessAt = this.clock(); this.error(null);
        for (let i = 0; i < rows.length; i++) {
          if (this.stopped || this.blocked) return;
          const n = normalized[i]!;
          const id = Number(n.messageId);
          if (!n.isOutgoing && n.timestamp! >= this.state.activatedAt && !this.state.entries[id]) {
            if (this.clock() - n.timestamp! < GUARD_GRACE_MS || recovered >= 5) return;
            if (n.timestamp! < this.recoverSince || this.clock() - n.timestamp! > GUARD_MAX_AGE_MS) {
              this.state.entries[id] = { phase: "uncertain", at: this.clock() }; this.state.incident++;
            } else {
              if (!this.options.allowed()) { this.error("access-denied"); return; }
              if (await this.accept({ message: rows[i] }, true)) recovered++;
              if (this.blocked || this.stopped) return;
            }
          }
          this.state.cursor = id;
          if (!this.persist()) return;
        }
        if (rows.length < 100) return;
      }
    } finally { this.checking = false; }
  }

  start(): void {
    if (this.started || this.stopped || this.blocked) return;
    this.started = true;
    const tick = async () => {
      this.timer = undefined;
      await this.check().catch(() => { this.failures++; this.error("check-failed"); });
      if (!this.stopped && !this.blocked) {
        this.timer = setTimeout(tick, GUARD_INTERVAL_MS * 2 ** Math.min(this.failures, 3));
        this.timer.unref?.();
      }
    };
    this.timer = setTimeout(tick, 0); this.timer.unref?.();
  }

  stop(): void { this.stopped = true; if (this.timer) clearTimeout(this.timer); this.timer = undefined; }
}
