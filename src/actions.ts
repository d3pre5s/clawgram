// Имена действий: что принимается и во что разрешается.
//
// Вынесено из channel.ts, который был единственным файлом на 3274 строки при
// следующем по величине 1165 (находка A6-11). Здесь нет ни рантайма, ни
// конфига — только словарь, поэтому читать и править его можно, не открывая
// диспетчер.

/**
 * Every accepted spelling of an action, mapped to its canonical name.
 *
 * One table, not three. The synonyms used to live in
 * `CORE_ACTION_SYNONYMS`, again in `MANAGE_ACTION_ALIASES`, and a third time
 * as `action === "…" || …` chains inside the dispatcher — and the dispatcher
 * read only the chains. A name could therefore be added to a table and to the
 * advertised list and still reach nothing, with the suite none the wiser:
 * it only ever dispatched the native spellings (finding A6-10).
 *
 * `canonicalAction` is now the only place a name is resolved, and
 * `CORE_ACTION_SYNONYMS` below is derived from this table rather than kept
 * beside it.
 */
const ACTION_ALIASES: Record<string, string> = {
  send: "send",

  read: "read",
  // `list` is accepted so a caller that guessed the other obvious name is not
  // silently refused.
  list: "read",

  react: "react",
  joins: "joins",

  "upload-file": "upload-file",
  sendAttachment: "upload-file",

  "fetch-media": "fetch-media",
  fetchMedia: "fetch-media",
  "download-media": "fetch-media",
  downloadMedia: "fetch-media",
  getMedia: "fetch-media",
  "download-file": "fetch-media",

  participants: "participants",
  members: "participants",
  "member-info": "participants",

  topics: "topics",
  forumTopics: "topics",
  "thread-list": "topics",

  dialogs: "dialogs",
  chats: "dialogs",
  "channel-list": "dialogs",

  chatInfo: "chatInfo",
  getChatInfo: "chatInfo",
  "channel-info": "chatInfo",
  chatMetadata: "chatInfo",
  getChatMetadata: "chatInfo",

  // Chat management. `kick` was already accepted; the rest were advertised
  // under names core does not know and were therefore never callable from the
  // tool at all — 2.19.4 gives them core's nearest name. `transferOwnership`
  // and `inviteLink` have no counterpart in that vocabulary and stay
  // gateway-only, as does `joins`.
  createGroup: "createGroup",
  createChat: "createGroup",
  "create-group": "createGroup",
  "channel-create": "createGroup",

  addMembers: "addMembers",
  addMember: "addMembers",
  "add-members": "addMembers",
  addParticipant: "addMembers",

  removeMember: "removeMember",
  removeMembers: "removeMember",
  "remove-member": "removeMember",
  kick: "removeMember",

  promoteAdmin: "promoteAdmin",
  promote: "promoteAdmin",
  "promote-admin": "promoteAdmin",
  setAdmin: "promoteAdmin",
  "role-add": "promoteAdmin",

  demoteAdmin: "demoteAdmin",
  demote: "demoteAdmin",
  "demote-admin": "demoteAdmin",
  "role-remove": "demoteAdmin",

  transferOwnership: "transferOwnership",
  transferOwner: "transferOwnership",
  "transfer-ownership": "transferOwnership",

  inviteLink: "inviteLink",
  exportInviteLink: "inviteLink",
  "invite-link": "inviteLink",
};

/** The canonical action for a spelling; an unknown name stays itself. */
export function canonicalAction(action: string): string {
  return ACTION_ALIASES[ action ] ?? action;
}

/**
 * Core's own name for a clawgram action, and the only thing that makes the
 * action reachable from the agent's `message` tool.
 *
 * Core keys its target policy by `CHANNEL_MESSAGE_ACTION_NAMES`, and an action
 * outside that vocabulary is simultaneously "requires a target" and "does not
 * accept a target" — there is no call that satisfies both. Declaring `chatId`
 * through `messageActionTargetAliases` looks like the fix and is not: core
 * resolves the channel with `getBootstrapChannelPlugin`, which only knows
 * bundled channels, so a plugin channel's declaration is never read. Measured
 * on 2026-08-30 — `thread-list` reached `handleAction` and `topics` did not,
 * from the same caller, on the same chat.
 *
 * Every name on the right maps to core target mode `"none"` except
 * `channel-info`, which is `"channelId"`: the chat arrives in
 * `params.channelId`, a spelling no parser here read until 2.21.0 — so the
 * call fell through to the current chat and answered about the wrong one.
 * `readChatTargetParam` is the single list of accepted spellings now.
 *
 * These spellings are derived from `ACTION_ALIASES` rather than kept beside
 * it; that core actually knows each of them is asserted against the installed
 * core in `core-action-synonyms.test.ts`.
 */
const CORE_VOCABULARY_SPELLINGS = [
  "thread-list", "channel-list", "channel-info", "member-info", "download-file",
  "channel-create", "addParticipant", "kick", "role-add", "role-remove",
] as const;

export const CORE_ACTION_SYNONYMS: Record<string, string> = Object.fromEntries(
  CORE_VOCABULARY_SPELLINGS.map((name) => [ name, ACTION_ALIASES[ name ] ]),
);

/** Canonical actions that go through the chat-management gate. */
export const MANAGE_ACTIONS = new Set([
  "createGroup", "addMembers", "removeMember",
  "promoteAdmin", "demoteAdmin", "transferOwnership", "inviteLink",
]);
