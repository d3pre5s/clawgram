import { createHash } from "node:crypto";
import { join } from "node:path";
import { InboundGuard, type GuardStatus } from "./inbound-guard";
import { resolveStateDir } from "./state-dir";
import { isSenderAllowed, resolveAccountScopes } from "./helpers";
import { isChatReadable } from "./history";
import { resolveAccountReadChats } from "./account-scopes";

export type GuardHandle = Pick<InboundGuard, "accept" | "status" | "start" | "stop">;
export type GuardRegistry = Map<string, GuardHandle>;

export function resolveGuardOwner(cfg: any, accountId: string): string {
  const entries = cfg?.commands?.ownerAllowFrom;
  const owners = new Set<string>(Array.isArray(entries)
    ? entries.filter((e: unknown) => typeof e === "string" && /^clawgram:[1-9][0-9]*$/.test(e)).map((e: string) => e.slice(9)) : []);
  if (owners.size !== 1) throw new Error("owner-unresolved");
  const owner = [...owners][0];
  if (!isSenderAllowed({ allowFrom: resolveAccountScopes(cfg, accountId).allowFrom, senderId: owner })
    || !isChatReadable(owner, resolveAccountReadChats(cfg, accountId))) throw new Error("access-denied");
  return owner;
}

export function createInboundGuard(args: {
  cfg: any; accountId: string; selfId?: string;
  readPage: (owner: string, args: { after: number; since: number; limit: number }) => Promise<unknown[]>;
  dispatch: (event: unknown) => Promise<boolean>;
}): GuardHandle {
  const enabled = args.cfg?.channels?.clawgram?.accounts?.[args.accountId]?.inboundGuard?.enabled === true;
  let errorCode: string | null = null;
  if (enabled) {
    try {
      const owner = resolveGuardOwner(args.cfg, args.accountId);
      if (!args.selfId || !/^[1-9][0-9]*$/.test(args.selfId) || owner === args.selfId) throw new Error("identity-unresolved");
      const identity = createHash("sha256").update(JSON.stringify([args.accountId, args.selfId, owner])).digest("hex");
      return new InboundGuard({
        accountId: args.accountId, selfId: args.selfId, ownerId: owner,
        storePath: join(resolveStateDir(), "state", "clawgram", `inbound-${identity}.json`),
        allowed: () => { try { return resolveGuardOwner(args.cfg, args.accountId) === owner; } catch { return false; } },
        readPage: (params) => args.readPage(owner, params), dispatch: args.dispatch,
      });
    } catch (error) {
      errorCode = [ "owner-unresolved", "access-denied", "identity-unresolved" ].includes((error as Error).message)
        ? (error as Error).message : "guard-unavailable";
    }
  }
  const status: GuardStatus = {
    enabled, running: false, errorCode, incident: 0, activatedAt: null,
    lastCheckAt: null, lastSuccessAt: null, recoveredCount: 0, uncertainCount: 0, pendingCount: 0, oldestPendingAt: null,
  };
  return { accept: args.dispatch, start() {}, stop() {}, status: () => ({ ...status }) };
}

/** Metadata only. Recovery cannot be invoked with caller-supplied text or identities. */
export function registerInboundGuardStatus(api: any, guards: GuardRegistry): void {
  api.registerGatewayMethod("clawgram.inboundGuard.status", ({ params, respond }: any) => {
    if (params && Object.keys(params).length) {
      respond(false, undefined, { code: "INVALID_REQUEST", message: "This method accepts no parameters" }); return;
    }
    respond(true, { version: 1, accounts: [...guards].map(([accountId, guard]) => ({ accountId, ...guard.status() })) });
  }, { scope: "operator.read" });
}
