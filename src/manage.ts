/**
 * Chat management — assembling a team chat, as opposed to speaking in it.
 *
 * Creating a group, adding and removing people, appointing admins and handing
 * the chat over are what a manager does with their own account, and the
 * account this plugin drives is exactly that. Telegram's Bot API forbids most
 * of this; MTProto does not, which is why these actions exist here and not in
 * a bot.
 *
 * Everything in this file is pure — parameter parsing, the management scope
 * gate, and readers for the TL shapes the calls return — so it can be tested
 * without a Telegram client. The transport lives in `GramJsClientManager`.
 *
 * The scope gate is deliberately opposite to reading: an absent `readChats`
 * means "read anywhere", an absent `manageChats` means "manage nothing".
 * Reading is what the plugin is for; rearranging chats and kicking people is
 * not something a fresh install may do because nobody said no.
 */

import { normalizeChatKey } from "./history";
import { readChatTargetParam } from "./helpers";

export type ManageToolContext = {
  currentChannelId?: string;
} | undefined;

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
}

/** A user reference: `@username` or a numeric id, as a trimmed string. */
function readUserRef(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(Math.trunc(value));
  }

  return readString(value);
}

function readTarget(params: Record<string, unknown>, toolContext: ManageToolContext, action: string): string {
  const raw = readChatTargetParam(params, toolContext);
  const target = readString(raw);
  if (!target) {
    throw new Error(`clawgram: ${action} requires a chatId`);
  }

  return target;
}

function readUserList(params: Record<string, unknown>): string[] {
  const raw = params.users ?? params.members ?? params.user ?? params.userId;
  const entries = Array.isArray(raw) ? raw : raw === undefined || raw === null ? [] : [ raw ];

  return entries
    .map(readUserRef)
    .filter((entry): entry is string => Boolean(entry));
}

function readSingleUser(params: Record<string, unknown>, action: string): string {
  const user = readUserRef(params.user ?? params.userId ?? params.member);
  if (!user) {
    throw new Error(`clawgram: ${action} requires a user`);
  }

  return user;
}

/** Only a literal `true` (or its string form) turns a dangerous flag on. */
function readFlag(value: unknown): boolean {
  return value === true || value === "true";
}

export type CreateGroupParams = {
  title: string;
  about?: string;
  users: string[];
};

export function parseCreateGroupParams(params: Record<string, unknown>): CreateGroupParams {
  const title = readString(params.title ?? params.name);
  if (!title) {
    throw new Error("clawgram: createGroup requires a title");
  }

  return {
    title,
    about: readString(params.about ?? params.description),
    users: readUserList(params),
  };
}

export type AddMembersParams = {
  target: string;
  users: string[];
};

export function parseAddMembersParams(
  params: Record<string, unknown>,
  toolContext: ManageToolContext,
): AddMembersParams {
  const target = readTarget(params, toolContext, "addMembers");
  const users = readUserList(params);
  if (users.length === 0) {
    throw new Error("clawgram: addMembers requires users to add");
  }

  return { target, users };
}

export type RemoveMemberParams = {
  target: string;
  user: string;
  /** True bans; false (the default) kicks so the person can be re-invited. */
  ban: boolean;
};

export function parseRemoveMemberParams(
  params: Record<string, unknown>,
  toolContext: ManageToolContext,
): RemoveMemberParams {
  return {
    target: readTarget(params, toolContext, "removeMember"),
    user: readSingleUser(params, "removeMember"),
    ban: readFlag(params.ban),
  };
}

/**
 * Admin rights as plain booleans; the client turns them into
 * `Api.ChatAdminRights`. Broadcast-only rights (posting and editing channel
 * posts) are carried for completeness but stay off: this plugin manages team
 * groups, not announcement channels.
 */
export type AdminRights = {
  changeInfo: boolean;
  postMessages: boolean;
  editMessages: boolean;
  deleteMessages: boolean;
  banUsers: boolean;
  inviteUsers: boolean;
  pinMessages: boolean;
  addAdmins: boolean;
  anonymous: boolean;
  manageCall: boolean;
  manageTopics: boolean;
};

/**
 * What a team admin gets: run the room, not the hierarchy. `addAdmins` and
 * `anonymous` are escalation and impersonation respectively, and each must be
 * an explicit choice, never a default.
 */
export const DEFAULT_ADMIN_RIGHTS: AdminRights = Object.freeze({
  changeInfo: true,
  postMessages: false,
  editMessages: false,
  deleteMessages: true,
  banUsers: true,
  inviteUsers: true,
  pinMessages: true,
  addAdmins: false,
  anonymous: false,
  manageCall: true,
  manageTopics: true,
});

export const NO_ADMIN_RIGHTS: AdminRights = Object.freeze({
  changeInfo: false,
  postMessages: false,
  editMessages: false,
  deleteMessages: false,
  banUsers: false,
  inviteUsers: false,
  pinMessages: false,
  addAdmins: false,
  anonymous: false,
  manageCall: false,
  manageTopics: false,
});

export type SetAdminParams = {
  target: string;
  user: string;
  isAdmin: boolean;
  rights: AdminRights;
  rank?: string;
};

export function parsePromoteAdminParams(
  params: Record<string, unknown>,
  toolContext: ManageToolContext,
): SetAdminParams {
  const target = readTarget(params, toolContext, "promoteAdmin");
  const user = readSingleUser(params, "promoteAdmin");

  const rights: AdminRights = { ...DEFAULT_ADMIN_RIGHTS };
  const overrides = params.rights;
  if (overrides && typeof overrides === "object") {
    for (const key of Object.keys(rights) as Array<keyof AdminRights>) {
      const value = (overrides as Record<string, unknown>)[ key ];
      // Only a real boolean overrides: a string "true" here would be a typo'd
      // config, and rights are not the place to guess.
      if (typeof value === "boolean") {
        rights[ key ] = value;
      }
    }
  }

  return {
    target,
    user,
    isAdmin: true,
    rights,
    rank: readString(params.rank ?? params.title),
  };
}

export function parseDemoteAdminParams(
  params: Record<string, unknown>,
  toolContext: ManageToolContext,
): SetAdminParams {
  return {
    target: readTarget(params, toolContext, "demoteAdmin"),
    user: readSingleUser(params, "demoteAdmin"),
    isAdmin: false,
    rights: { ...NO_ADMIN_RIGHTS },
  };
}

export type TransferOwnershipParams = {
  target: string;
  user: string;
};

export function parseTransferOwnershipParams(
  params: Record<string, unknown>,
  toolContext: ManageToolContext,
): TransferOwnershipParams {
  return {
    target: readTarget(params, toolContext, "transferOwnership"),
    user: readSingleUser(params, "transferOwnership"),
  };
}

export type InviteLinkParams = {
  target: string;
  /** Unix seconds. */
  expireDate?: number;
  usageLimit?: number;
  title?: string;
  requestNeeded: boolean;
};

function parseExpireDate(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return Math.trunc(value);
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      return Number.parseInt(trimmed, 10);
    }

    const parsed = Date.parse(trimmed);
    if (Number.isFinite(parsed)) {
      return Math.floor(parsed / 1000);
    }
  }

  // A link that was meant to expire and silently does not is a standing hole
  // in the chat's boundary — refuse rather than degrade.
  throw new Error("clawgram: inviteLink expireDate must be unix seconds or an ISO date");
}

function parseUsageLimit(value: unknown): number | undefined {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }

  const parsed = typeof value === "number" ? value : Number(String(value).trim());
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error("clawgram: inviteLink usageLimit must be a positive number");
  }

  return Math.trunc(parsed);
}

export function parseInviteLinkParams(
  params: Record<string, unknown>,
  toolContext: ManageToolContext,
): InviteLinkParams {
  return {
    target: readTarget(params, toolContext, "inviteLink"),
    expireDate: parseExpireDate(params.expireDate ?? params.expiresAt),
    usageLimit: parseUsageLimit(params.usageLimit ?? params.memberLimit),
    title: readString(params.title ?? params.label),
    requestNeeded: readFlag(params.requestNeeded ?? params.requireApproval),
  };
}

function normalizeScope(manageChats: unknown): string[] {
  if (manageChats === undefined || manageChats === null) {
    return [];
  }

  return (Array.isArray(manageChats) ? manageChats : [ manageChats ])
    .map(normalizeChatKey)
    .filter(Boolean);
}

/** True while the account is allowed to manage anything at all. */
export function isManagementEnabled(manageChats?: unknown): boolean {
  return normalizeScope(manageChats).length > 0;
}

/**
 * The management gate. Absent, null and empty all deny: management is opt-in,
 * and the wildcard has to be written down to mean "everywhere".
 */
export function isChatManageable(target: unknown, manageChats?: unknown): boolean {
  const entries = normalizeScope(manageChats);
  if (entries.length === 0) {
    return false;
  }

  if (entries.includes("*")) {
    return true;
  }

  return entries.includes(normalizeChatKey(target));
}

/**
 * The id of the supergroup a `channels.CreateChannel` call just created, read
 * from the `Updates` it returns, in the `-100…` form the rest of this plugin
 * speaks. GramJS carries ids as `big-integer` objects as often as native
 * numbers, so the id goes through `String` rather than arithmetic.
 */
export function resolveCreatedChannelId(updates: unknown): string | undefined {
  const chats = (updates as any)?.chats;
  if (!Array.isArray(chats)) {
    return undefined;
  }

  for (const chat of chats) {
    if (chat?.className !== "Channel") {
      continue;
    }

    const id = chat?.id;
    if (id === undefined || id === null) {
      continue;
    }

    const asString = String(id).trim();
    if (asString && asString !== "[object Object]") {
      return `-100${asString.replace(/^-100|-/, "")}`;
    }
  }

  return undefined;
}

/**
 * Who Telegram refused to add, as user ids. Privacy settings make this an
 * expected outcome, not an error: the caller is told exactly who still needs
 * an invite link instead of the whole call failing.
 */
export function summarizeMissingInvitees(result: unknown): string[] {
  const missing = (result as any)?.missingInvitees;
  if (!Array.isArray(missing)) {
    return [];
  }

  const ids: string[] = [];
  for (const entry of missing) {
    const id = entry?.userId;
    if (id === undefined || id === null) {
      continue;
    }

    const asString = String(id).trim();
    if (asString && asString !== "[object Object]") {
      ids.push(asString);
    }
  }

  return ids;
}

/** The link out of a `TypeExportedChatInvite`, or nothing when there is none. */
export function readInviteLink(result: unknown): string | undefined {
  return readString((result as any)?.link);
}
