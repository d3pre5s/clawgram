import { createSubsystemLogger, jsonResult } from "openclaw/plugin-sdk/core";

import type { ActionContext } from "./action-context";
import { resolveAccountManageChats } from "./account-scopes";
import { MANAGE_ACTIONS } from "./actions";
import {
  isChatManageable,
  isManagementEnabled,
  parseAddMembersParams,
  parseCreateGroupParams,
  parseDemoteAdminParams,
  parseInviteLinkParams,
  parsePromoteAdminParams,
  parseRemoveMemberParams,
  parseTransferOwnershipParams,
} from "./manage";

/**
 * The chat-management actions, gated by `manageChats`.
 *
 * Cut out of `handleAction` in `channel.ts` unchanged (audit B5-13, part 3);
 * the probe is the proof. Answers `undefined` for any other action.
 */

const actionLog = createSubsystemLogger("channels/clawgram");

export async function handleManageAction(ctx: ActionContext): Promise<unknown> {
  const { canonical, params, cfg, accountId, dryRun, toolContext, resolveRuntimeAccountId, requireRuntimeFor } = ctx;

  // ---- Chat management (2.12.0) ----
  //
  // Assembling a chat rather than speaking in it: create a supergroup,
  // add and remove people, appoint admins, hand the chat over, issue an
  // invite link. All of it is possible only because this is a personal
  // MTProto account — a bot could do almost none of this.
  //
  // Every branch is gated by the account's `manageChats` scope, which is
  // opt-in (absent = deny, see manage.ts) — these are the first actions
  // that change a chat rather than write into it. Parsing runs before
  // the gate so a malformed call fails on its own shape, and `dryRun`
  // returns after the gate so a dry run exercises the same refusals a
  // real call would hit. People's ids stay out of the logs throughout;
  // the JSON result carries them to the caller, the journal does not.
  const manageAction = MANAGE_ACTIONS.has(canonical) ? canonical : undefined;
  if (manageAction) {
    const manageAccountId = resolveRuntimeAccountId(cfg, accountId);
    if (!manageAccountId) {
      throw new Error("clawgram: no configured account found");
    }
    const manageScope = resolveAccountManageChats(cfg, manageAccountId);
    const requireRuntime = () => requireRuntimeFor(manageAccountId);

    /**
     * The scaffold every management action shares.
     *
     * Six actions used to spell it out one after another: resolve the
     * account, check the scope, log, answer a dry run, call the
     * runtime, log again, build the result. A change to any of those —
     * the dry-run contract, say — was a six-place edit in the plugin's
     * largest file, and the one deliberate exception (createGroup does
     * not check a chat scope, because the chat does not exist yet) was
     * invisible among the copies (finding A12-06).
     *
     * The differences stay written at each call site: what to parse,
     * what to log, what to run, what to answer. Only the scaffold moved.
     */
    const runManage = async <P, R>(spec: {
      /** Log name; promote and demote deliberately share `setAdmin`. */
      name: string;
      parse: () => P;
      /** The chat this touches, or nothing when it does not exist yet. */
      target: (parsed: P) => string | undefined;
      before: (parsed: P) => Record<string, unknown>;
      /** Checked after the gate, before any call. */
      precondition?: (gram: ReturnType<typeof requireRuntime>) => void;
      run: (gram: ReturnType<typeof requireRuntime>, parsed: P) => Promise<R>;
      after: (parsed: P, result: R) => Record<string, unknown>;
      result: (parsed: P, result: R) => Record<string, unknown>;
    }) => {
      const parsed = spec.parse();
      const target = spec.target(parsed);

      if (target === undefined) {
        // Nothing to check a scope against yet, so the gate is coarser:
        // management must be enabled at all for this account.
        if (!isManagementEnabled(manageScope)) {
          actionLog.warn(`clawgram ${spec.name} refused: management is not enabled`, {
            accountId: manageAccountId,
          });
          throw new Error(
            "clawgram: chat management is not enabled for this account — "
            + `set channels.clawgram.accounts.${manageAccountId}.manageChats`,
          );
        }
      } else if (!isChatManageable(target, manageScope)) {
        actionLog.warn("clawgram management refused: chat outside manage scope", {
          accountId: manageAccountId,
          action: manageAction,
          target,
        });
        throw new Error(`clawgram: not-managed-chat ${target}`);
      }

      actionLog.info(`clawgram handleAction ${spec.name}`, {
        accountId: manageAccountId,
        dryRun: dryRun === true,
        ...spec.before(parsed),
      });

      if (dryRun === true) {
        return jsonResult({
          ok: true,
          dryRun: true,
          accountId: manageAccountId,
          ...(target === undefined ? {} : { chatId: target }),
        });
      }

      const gram = requireRuntime();
      spec.precondition?.(gram);
      const result = await spec.run(gram, parsed);

      actionLog.info(`clawgram handleAction ${spec.name} completed`, {
        accountId: manageAccountId,
        ...spec.after(parsed, result),
      });

      return jsonResult({ ok: true, accountId: manageAccountId, ...spec.result(parsed, result) });
    };

    if (manageAction === "createGroup") {
      return await runManage({
        name: "createGroup",
        parse: () => parseCreateGroupParams(params),
        // A group being created is not in any scope yet.
        target: () => undefined,
        before: (p) => ({ users: p.users.length, hasAbout: Boolean(p.about) }),
        run: (gram, p) => gram.createGroup(p),
        after: (_p, created) => ({ chatId: created.chatId ?? null, missing: created.missing.length }),
        result: (_p, created) => ({ chatId: created.chatId, missing: created.missing }),
      });
    }

    if (manageAction === "addMembers") {
      return await runManage({
        name: "addMembers",
        parse: () => parseAddMembersParams(params, toolContext),
        target: (p) => p.target,
        before: (p) => ({ target: p.target, users: p.users.length }),
        run: (gram, p) => gram.addChatMembers(p),
        after: (p, added) => ({
          target: p.target,
          requested: p.users.length,
          missing: added.missing.length,
        }),
        result: (p, added) => ({
          chatId: added.chatId ?? p.target,
          requested: p.users.length,
          // Telegram refuses silently-restricted invites per user; the
          // caller gets the ids so it can hand them an invite link.
          missing: added.missing,
        }),
      });
    }

    if (manageAction === "removeMember") {
      return await runManage({
        name: "removeMember",
        parse: () => parseRemoveMemberParams(params, toolContext),
        target: (p) => p.target,
        before: (p) => ({ target: p.target, ban: p.ban }),
        run: (gram, p) => gram.removeChatMember(p),
        after: (p) => ({ target: p.target, ban: p.ban }),
        result: (p) => ({ chatId: p.target, user: p.user, banned: p.ban }),
      });
    }

    if (manageAction === "promoteAdmin" || manageAction === "demoteAdmin") {
      const promote = manageAction === "promoteAdmin";
      return await runManage({
        // Both spellings log as `setAdmin`, as they always have.
        name: "setAdmin",
        parse: () => (promote
          ? parsePromoteAdminParams(params, toolContext)
          : parseDemoteAdminParams(params, toolContext)),
        target: (p) => p.target,
        before: (p) => ({ target: p.target, isAdmin: p.isAdmin, hasRank: Boolean(p.rank) }),
        run: (gram, p) => gram.setChatAdmin(p),
        after: (p) => ({ target: p.target, isAdmin: p.isAdmin }),
        result: (p) => ({
          chatId: p.target,
          user: p.user,
          isAdmin: p.isAdmin,
          ...(p.rank ? { rank: p.rank } : {}),
        }),
      });
    }

    if (manageAction === "transferOwnership") {
      return await runManage({
        name: "transferOwnership",
        parse: () => parseTransferOwnershipParams(params, toolContext),
        target: (p) => p.target,
        before: (p) => ({ target: p.target }),
        // The password stays inside the runtime: it is read from the
        // account config at start-up and never travels through dispatch
        // arguments, which are one log call away from the journal.
        precondition: (gram) => {
          if (!gram.twoFaPassword) {
            throw new Error(
              "clawgram: ownership transfer requires twoFaPassword in the account config "
              + "(the account's Telegram 2FA password, as a literal or a SecretRef)",
            );
          }
        },
        run: (gram, p) => gram.transferChatOwnership(p),
        after: (p) => ({ target: p.target }),
        result: (p) => ({ chatId: p.target, newOwner: p.user }),
      });
    }

    // inviteLink — the only management action left.
    return await runManage({
      name: "inviteLink",
      parse: () => parseInviteLinkParams(params, toolContext),
      target: (p) => p.target,
      before: (p) => ({
        target: p.target,
        hasExpiry: p.expireDate !== undefined,
        usageLimit: p.usageLimit ?? null,
        requestNeeded: p.requestNeeded,
      }),
      run: (gram, p) => gram.exportChatInviteLink(p),
      after: (p, exported) => ({ target: p.target, hasLink: Boolean(exported.link) }),
      result: (p, exported) => ({ chatId: p.target, link: exported.link }),
    });
  }

  return undefined;
}
