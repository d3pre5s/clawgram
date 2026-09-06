import { createSubsystemLogger, jsonResult } from "openclaw/plugin-sdk/core";
import { readStringOrNumberParam, readStringParam } from "openclaw/plugin-sdk/param-readers";

import type { ActionContext } from "./action-context";
import { refuseOutboundOutsideScope, resolveAccountSendChats } from "./account-scopes";
import { consumeGroupReplyAddress, peekGroupReplyAddress } from "./group-reply-address";
import { hasRecentVisibleGroupReply, rememberTurnSend, rememberVisibleGroupReply } from "./group-visible-reply-guard";
import {
  inferOutboundTargetKind,
  isSilentReplyText,
  normalizeOutboundTarget,
  parseOptionalThreadId,
  prefixReplyTextToAddress,
  readMessageText,
  readVoiceNoteFlag,
  resolveActionTarget,
  resolveConfiguredAccountId,
  resolveOutboundParseMode,
  resolveReplyToMessageIdForTarget,
} from "./helpers";
import { assertLocalMediaWithinRoots, loadOutboundMedia } from "./media";
import { parseReactionParams } from "./reactions";
import { isChatSendable } from "./send-scope";

/**
 * The outbound actions: `react`, `upload-file` (and a `send` carrying a
 * file), and `send` itself — the last branch, which also refuses a name
 * nobody claimed.
 *
 * Cut out of `handleAction` in `channel.ts` unchanged (audit B5-13, part 3);
 * the probe is the proof.
 */

const actionLog = createSubsystemLogger("channels/clawgram");

export async function handleSendAction(ctx: ActionContext): Promise<unknown> {
  const {
    action, canonical, params, cfg, accountId, dryRun, toolContext,
    allowedMediaRoots, readMedia, resolveRuntimeAccountId, requireRuntimeFor,
  } = ctx;

  // A reaction is an outbound act on someone else's message, so it is
  // gated like sending rather than like reading — and it respects
  // `dryRun`, which reading does not need to.
  if (canonical === "react") {
    const reactionParams = parseReactionParams(params, toolContext);
    const reactionAccountId = resolveRuntimeAccountId(cfg, accountId);
    if (!reactionAccountId) {
      throw new Error("clawgram: no configured account found");
    }

    // Реакция — видимое действие от имени владельца в чужом чате, и
    // адресуется она так же, как сообщение: та же область (A5-12).
    if (!isChatSendable(reactionParams.target, resolveAccountSendChats(cfg, reactionAccountId))) {
      refuseOutboundOutsideScope("react", reactionAccountId, String(reactionParams.target));
    }

    actionLog.info("clawgram handleAction react", {
      accountId: reactionAccountId,
      dryRun: dryRun === true,
      target: reactionParams.target,
      messageId: reactionParams.messageId,
      remove: reactionParams.remove,
    });

    if (dryRun === true) {
      return jsonResult({
        ok: true,
        dryRun: true,
        accountId: reactionAccountId,
        chatId: reactionParams.target,
        messageId: reactionParams.messageId,
        removed: reactionParams.remove,
      });
    }

    const reactionGram = requireRuntimeFor(reactionAccountId);

    await reactionGram.sendReaction(reactionParams);

    return jsonResult({
      ok: true,
      accountId: reactionAccountId,
      chatId: reactionParams.target,
      messageId: reactionParams.messageId,
      removed: reactionParams.remove,
    });
  }

  // Core normalizes whichever of these it filled in to a local path (see
  // `mediaSourceParams` above); `mediaUrl` stays a URL, which GramJS
  // accepts as well.
  const attachedFile =
    readStringParam(params, "filePath")
    ?? readStringParam(params, "path")
    ?? readStringParam(params, "media")
    ?? readStringParam(params, "mediaUrl");

  // Core dispatches `upload-file`; `sendAttachment` is its legacy alias
  // and arrives from older callers. A plain `send` carrying a file lands
  // here too — `openclaw message send --media` does exactly that, and
  // routing it to the text path dropped the file without a word.
  if (canonical === "upload-file" || (canonical === "send" && attachedFile)) {
    const rawUploadTo = resolveActionTarget(params, toolContext);
    const uploadTo = normalizeOutboundTarget(rawUploadTo);
    const uploadAccountId = resolveRuntimeAccountId(cfg, accountId);
    if (!uploadAccountId) {
      throw new Error("clawgram: no configured account found");
    }

    // Та же граница, что у `send`: файл наружу — такое же исходящее.
    if (!isChatSendable(uploadTo, resolveAccountSendChats(cfg, uploadAccountId))) {
      refuseOutboundOutsideScope("upload-file", uploadAccountId, uploadTo);
    }

    if (!attachedFile) {
      throw new Error("clawgram: upload-file requires filePath, path, media, or mediaUrl");
    }

    // Before anything else about the message is considered: an
    // out-of-scope path is refused, not sent and then regretted.
    assertLocalMediaWithinRoots(attachedFile, allowedMediaRoots);

    const captionText = readMessageText(params) || (readStringParam(params, "caption") ?? "");
    // A caption is optional, but the silent-reply sentinel must never
    // reach Telegram as one — same reasoning as the `send` path below.
    const caption = captionText.trim() && isSilentReplyText(captionText)
      ? ""
      : captionText.replaceAll("\\n", "\n");
    const uploadReplyToId = readStringOrNumberParam(params, "replyToId") ?? readStringOrNumberParam(params, "replyTo");
    const uploadThreadId = readStringOrNumberParam(params, "threadId");
    const asVoice = readVoiceNoteFlag(params);

    actionLog.info("clawgram handleAction upload-file", {
      accountId: uploadAccountId,
      dryRun: dryRun === true,
      to: uploadTo,
      hasCaption: Boolean(caption),
      replyToId: uploadReplyToId ?? null,
      threadId: uploadThreadId ?? null,
      asVoice,
    });

    if (dryRun === true) {
      return jsonResult({
        ok: true,
        dryRun: true,
        to: uploadTo,
        accountId: uploadAccountId,
      });
    }

    const uploadGram = requireRuntimeFor(uploadAccountId);
    // Read last, through core's scoped reader when it gave one: a dry
    // run or a refusal above must not open the file.
    const file = await loadOutboundMedia(attachedFile, allowedMediaRoots, readMedia);

    const uploaded = await uploadGram.sendMedia({
      target: uploadTo,
      file,
      caption: caption || undefined,
      // Same resolution as the text `send`: per-call value wins, an
      // omitted one inherits the account format (2.15.0). A caption is
      // the same prose as a message and renders identically.
      parseMode: resolveOutboundParseMode(params, cfg, uploadAccountId),
      replyToMessageId: resolveReplyToMessageIdForTarget(rawUploadTo, uploadReplyToId),
      messageThreadId: parseOptionalThreadId(uploadThreadId),
      asVoice,
    });

    actionLog.info("clawgram handleAction upload-file completed", {
      accountId: uploadAccountId,
      to: uploadTo,
      sentMessageId: String((uploaded as any)?.id ?? ""),
    });

    return jsonResult({
      ok: true,
      to: uploadTo,
      accountId: uploadAccountId,
      messageId: String((uploaded as any)?.id ?? ""),
    });
  }

  if (action !== "send") {
    throw new Error(`clawgram: unsupported message action ${action}`);
  }

  const rawTo = resolveActionTarget(params, toolContext);
  const targetKind = inferOutboundTargetKind(rawTo);
  const to = normalizeOutboundTarget(rawTo);
  const replyToId = readStringOrNumberParam(params, "replyToId") ?? readStringOrNumberParam(params, "replyTo");
  const threadId = readStringOrNumberParam(params, "threadId");
  const messageThreadId = parseOptionalThreadId(threadId);
  // Omitting parseMode inherits the account's configured mode rather
  // than falling back to plain text (2.13.0): an account set to `html`
  // used to render replies as HTML and these sends as raw markup.
  const parseMode = resolveOutboundParseMode(
    params as Record<string, unknown> | undefined,
    cfg,
    resolveConfiguredAccountId(cfg, accountId) ?? accountId ?? "default",
  );

  actionLog.info("clawgram handleAction send", {
    requestedAccountId: accountId,
    dryRun: dryRun === true,
    rawTo,
    to,
    targetKind,
    replyToId: replyToId ?? null,
    threadId: threadId ?? null,
    parseMode: parseMode ?? null,
    toolContextCurrentChannelId: toolContext?.currentChannelId ?? null,
  });

  const resolvedAccountId = resolveRuntimeAccountId(cfg, accountId);
  if (!resolvedAccountId) {
    throw new Error("clawgram: no configured account found");
  }

  // Проверка ПОСЛЕ резолва аккаунта и ДО любой доставки: область задаётся
  // на аккаунт, а отказ должен случиться раньше, чем цель разрешена в
  // Telegram-сущность — resolve сам по себе виден собеседнику (A5-12).
  if (!isChatSendable(to, resolveAccountSendChats(cfg, resolvedAccountId))) {
    refuseOutboundOutsideScope("send", resolvedAccountId, to);
  }
  const currentChannelId = toolContext?.currentChannelId?.trim() ?? "";
  const currentMessageId = toolContext?.currentMessageId;
  const currentChannelTarget = currentChannelId ? normalizeOutboundTarget(currentChannelId) : "";
  const sendingToCurrentGroup = Boolean(
    currentChannelTarget &&
    currentChannelTarget === to &&
    targetKind === "group",
  );

  if (
    sendingToCurrentGroup &&
    !replyToId &&
    currentMessageId !== null &&
    currentMessageId !== undefined &&
    hasRecentVisibleGroupReply({
      accountId: resolvedAccountId,
      chatId: to,
      currentMessageId,
    })
  ) {
    actionLog.warn("clawgram suppressing duplicate visible group reply", {
      accountId: resolvedAccountId,
      to,
      currentMessageId: String(currentMessageId),
      toolContextCurrentChannelId: currentChannelId || null,
    });

    // A dry run reports the suppression instead of impersonating it: the
    // caller asked what would happen, and what would happen is nothing.
    return jsonResult({
      ok: true,
      ...(dryRun ? { dryRun: true } : {}),
      suppressedDuplicate: true,
      to,
      accountId: resolvedAccountId,
    });
  }

  // Whom to greet is decided by the message this turn is answering, not
  // by whoever spoke last. An agent replying to a request rarely passes
  // `replyToId`, and until 2026-08-10 that fell through to the most
  // recent sender: in an interleaved chat the owner's report went out
  // addressed to a colleague who had asked something else entirely.
  // A dry run peeks: consuming the address here left the real send with
  // no greeting, so a rehearsal silently changed the message that went
  // out afterwards.
  const groupReplyAddress = (dryRun ? peekGroupReplyAddress : consumeGroupReplyAddress)({
    accountId: resolvedAccountId,
    chatId: to,
    replyToId: replyToId ?? currentMessageId,
  });
  const requestedText = readMessageText(params).replaceAll("\\n", "\n");

  // `NO_REPLY` is OpenClaw's "say nothing" sentinel. The inbound pipeline
  // and core both strip it, but an explicit `message.action` call is
  // neither path — and the SDK itself prompts agents to send a message
  // and *then* answer NO_REPLY, so the two are one slip apart. Posting
  // the token into a work chat looks like the assistant malfunctioning.
  //
  // Checked before the reply-address prefix on purpose: prefixing first
  // leaves "Name: " behind, which is not empty, and the token goes out.
  // That is precisely how it once reached the inbound path.
  if (requestedText.trim() && isSilentReplyText(requestedText)) {
    actionLog.info("clawgram suppressing silent send", {
      accountId: resolvedAccountId,
      to,
    });

    return jsonResult({
      ok: true,
      skipped: "silent",
      sent: false,
      to,
      accountId: resolvedAccountId,
    });
  }

  const text = prefixReplyTextToAddress(requestedText, groupReplyAddress);
  if (!text) {
    throw new Error("clawgram: message text is required");
  }

  if (dryRun) {
    return jsonResult({
      ok: true,
      dryRun: true,
      to,
      accountId: resolvedAccountId,
    });
  }

  const gram = requireRuntimeFor(resolvedAccountId);

  const sent = await gram.sendText({
    target: to,
    text,
    targetKind,
    replyToMessageId: resolveReplyToMessageIdForTarget(rawTo, replyToId),
    messageThreadId,
    parseMode,
  });

  if (
    sendingToCurrentGroup &&
    !replyToId &&
    currentMessageId !== null &&
    currentMessageId !== undefined
  ) {
    rememberVisibleGroupReply({
      accountId: resolvedAccountId,
      chatId: to,
      currentMessageId,
    });
  }

  // The turn has now spoken for itself. Recorded for every send into the
  // chat this turn came from — with or without an explicit replyToId —
  // so that core delivering the turn's final text a few seconds later
  // can be recognised as an echo of this same answer.
  if (currentMessageId !== null && currentMessageId !== undefined) {
    rememberTurnSend({
      accountId: resolvedAccountId,
      chatId: to,
      currentMessageId,
    });
  }

  actionLog.info("clawgram handleAction send completed", {
    accountId: resolvedAccountId,
    to,
    replyToId: replyToId ?? null,
    sentMessageId: String((sent as any)?.id ?? ""),
  });

  return jsonResult({
    ok: true,
    to,
    accountId: resolvedAccountId,
    messageId: String((sent as any)?.id ?? ""),
  });
}
