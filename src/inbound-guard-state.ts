import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

export type GuardState = {
  version: 1;
  binding: string;
  activatedAt: number;
  cursor: number;
  recoveredCount: number;
  incident: number;
  errorCode: string | null;
  lastSuccessAt: number | null;
  entries: Record<string, { phase: "claimed" | "settled" | "uncertain"; at: number }>;
};

export function loadGuardState(path: string, binding: string, now: number): GuardState {
  if (!existsSync(path)) return {
    version: 1, binding, activatedAt: Math.floor(now / 1000) * 1000, cursor: 0,
    recoveredCount: 0, incident: 0, errorCode: null, lastSuccessAt: null, entries: {},
  };
  const s = JSON.parse(readFileSync(path, "utf8")) as GuardState;
  const nonnegative = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  if (s?.version !== 1 || s.binding !== binding || !nonnegative(s.activatedAt) || s.activatedAt > now
    || !nonnegative(s.cursor) || !nonnegative(s.recoveredCount) || !nonnegative(s.incident)
    || !(s.lastSuccessAt === null || nonnegative(s.lastSuccessAt))
    || !(s.errorCode === null || typeof s.errorCode === "string")
    || !s.entries || typeof s.entries !== "object" || Array.isArray(s.entries)
    || Object.keys(s.entries).length > 10000) throw new Error("Invalid inbound guard state");
  for (const [id, entry] of Object.entries(s.entries)) {
    if (!/^[1-9][0-9]*$/.test(id) || !nonnegative(Number(id)) || !entry
      || ![ "claimed", "settled", "uncertain" ].includes(entry.phase) || !nonnegative(entry.at)) {
      throw new Error("Invalid inbound guard entry");
    }
    if (entry.phase === "claimed") { entry.phase = "uncertain"; s.incident++; }
  }
  return s;
}

/** Rename and directory fsync make a successful claim durable before any dispatch. */
export function saveGuardState(path: string, state: GuardState): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  let fd: number | undefined;
  try {
    fd = openSync(temp, "wx", 0o600);
    writeFileSync(fd, JSON.stringify(state)); fsyncSync(fd); closeSync(fd); fd = undefined;
    renameSync(temp, path);
    fd = openSync(dirname(path), "r"); fsyncSync(fd);
  } finally {
    if (fd !== undefined) closeSync(fd);
    try { unlinkSync(temp); } catch { /* renamed, or creation failed */ }
  }
}
