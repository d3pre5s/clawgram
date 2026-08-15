import type { ChannelGroupContext } from "openclaw/plugin-sdk/core";
import { resolveChannelGroupToolsPolicy } from "openclaw/plugin-sdk/channel-policy";
import type { GroupToolPolicyConfig } from "openclaw/plugin-sdk/channel-policy";
import { CHANNEL_ID } from "./constants";
import { stripAccountScopedGroupId } from "./helpers";

/**
 * `groups.resolveToolPolicy` — core calls this before its own lookup when a
 * message from a group session runs. The only thing this channel adds is the
 * id translation: core passes the scoped peer id (`<accountId>:<chatId>`),
 * the config is keyed by the bare chat id. Everything else — per-account vs
 * top-level `groups`, the `*` default, `toolsBySender` by id/username/name —
 * is the SDK's `resolveChannelGroupToolsPolicy`, the same function the
 * bundled Telegram channel delegates to.
 *
 * What the returned policy governs: gateway tools (message, sessions_*,
 * cron, memory_*, …) — under CLI backends via the loopback MCP tool list.
 * Not the CLI backend's own exec/read/write; those are per agent, not per
 * group, and only a separate agent bound to the chat restricts them.
 */
function resolveClawgramGroupToolPolicy(ctx: ChannelGroupContext): GroupToolPolicyConfig | undefined {
  const groupId = stripAccountScopedGroupId(ctx.groupId, ctx.accountId);
  if (!groupId) {
    return undefined;
  }

  return resolveChannelGroupToolsPolicy({
    cfg: ctx.cfg,
    channel: CHANNEL_ID,
    groupId,
    accountId: ctx.accountId ?? "default",
    senderId: ctx.senderId,
    senderName: ctx.senderName,
    senderUsername: ctx.senderUsername,
    senderE164: ctx.senderE164,
  });
}

export { resolveClawgramGroupToolPolicy };
