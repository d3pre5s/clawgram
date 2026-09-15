/**
 * Editing a message already sent — the `edit` action of OpenClaw's message
 * tool.
 *
 * Telegram lets an account rewrite its own message in place, and until 2.29.0
 * this channel had no way to ask for it: a wrong answer could only be followed
 * by a second message correcting the first, which leaves both standing in the
 * chat. `edit` is in core's `CHANNEL_MESSAGE_ACTION_NAMES`, so the name was
 * reachable from the tool the whole time and simply arrived at a channel that
 * refused it.
 *
 * Parsing lives here, apart from the network, so the argument handling can be
 * tested without a Telegram connection — the same split as `reactions.ts`.
 */

import { readChatTargetParam, readMessageText } from "./helpers";
import { parseMessageId } from "./history";

export type EditParams = {
  target: string;
  messageId: number;
  /** The replacement text. Never empty: see `parseEditParams`. */
  text: string;
};

export type EditToolContext = {
  currentChannelId?: string;
  currentMessageId?: string | number;
} | undefined;

export function parseEditParams(
  params: Record<string, unknown>,
  toolContext: EditToolContext,
): EditParams {
  const rawTarget = readChatTargetParam(params, toolContext);
  const target = typeof rawTarget === "string" ? rawTarget.trim() : "";
  if (!target) {
    throw new Error("clawgram: edit requires a chatId");
  }

  // No fall-back to `currentMessageId`, and that is the difference from
  // `react`. The current message is the one being answered — someone else's.
  // Reacting to it is the normal case; editing it is never a thing this
  // account may do, so a missing id is a caller mistake and not an invitation
  // to guess. Telegram would refuse it, but the refusal would arrive as
  // MESSAGE_AUTHOR_REQUIRED on a call nobody meant to make.
  const messageId = parseMessageId(
    params.messageId ?? params.msgId ?? params.message_id,
    "edit messageId",
  );
  if (messageId === undefined) {
    throw new Error("clawgram: edit requires a messageId — the id of the message to rewrite");
  }

  // `readMessageText` reads `message` then `text`, exactly as `send` does, so
  // the same call shape works for both actions.
  const text = readMessageText(params).replaceAll("\\n", "\n");
  if (!text.trim()) {
    // Telegram has no "edit to nothing": an empty edit is refused server-side,
    // and a caller who meant to remove the message asked for the wrong action.
    // Saying so here beats an MTProto error about message content.
    throw new Error("clawgram: edit requires the new text — an empty edit is not a deletion");
  }

  return { target, messageId, text };
}
