import { createSubsystemLogger, jsonResult } from "openclaw/plugin-sdk/core";
import os from "node:os";
import path from "node:path";

import type { ActionContext } from "./action-context";
import { resolveAccountDiscoverChats, resolveAccountReadChats } from "./account-scopes";
import { INBOUND_MEDIA_MAX_BYTES, understandAttachmentFile } from "./attachments";
import { describeChat, parseChatInfoParams } from "./chat-info";
import { isChatDiscoveryEnabled, parseDialogsParams } from "./dialogs";
import { fetchedMediaFileName, parseFetchMediaParams } from "./fetch-media";
import { isChatReadable, parseListMessagesParams, parseListParticipantsParams } from "./history";
import {
  parseJoinsParams,
  readJoinRecords,
  resolveJoinsJournalPath,
  selectJoinRecords,
} from "./joins";
import { describeMedia, downloadMessageMediaToFile, ensurePrivateDir, pruneFetchedMedia } from "./media";
import { resolveStateDir } from "./state-dir";
import { parseTopicsParams } from "./topics";

/**
 * The read-shaped actions: `read`, `fetch-media`, `participants`, `topics`,
 * `dialogs`, `joins`, `chatInfo`.
 *
 * Cut out of `handleAction` in `channel.ts` unchanged — same gates, same log
 * lines, same answers; the probe in `scripts/verify/action-probe.cjs` is the
 * proof (audit B5-13, part 3). Answers `undefined` for any other action.
 */

const actionLog = createSubsystemLogger("channels/clawgram");

// Час, а не сутки: `fetch-media` существует ради «прочитать и переслать», и
// файл нужен ровно на время хода. Сутки означали сутки чужой личной переписки
// на диске (A5-13).
const FETCHED_MEDIA_TTL_MS = 60 * 60 * 1000;

export async function handleReadAction(ctx: ActionContext): Promise<unknown> {
  const { canonical, params, cfg, accountId, toolContext, pluginRuntime, resolveRuntimeAccountId, requireRuntimeFor } = ctx;

  // `read` is what OpenClaw core dispatches (`openclaw message read`,
  // MCP `messages_read`); `list` resolves to it too.
  if (canonical === "read") {
    const listParams = parseListMessagesParams(params);
    const listAccountId = resolveRuntimeAccountId(cfg, accountId);
    if (!listAccountId) {
      throw new Error("clawgram: no configured account found");
    }

    // Reading is not a side effect, so a dry run still answers — reporting
    // an empty window would look like a quiet chat rather than a no-op.
    if (!isChatReadable(listParams.target, resolveAccountReadChats(cfg, listAccountId))) {
      actionLog.warn("clawgram list refused: chat outside read scope", {
        accountId: listAccountId,
        target: listParams.target,
      });
      throw new Error(`clawgram: not-allowed-chat ${listParams.target}`);
    }

    const listGram = requireRuntimeFor(listAccountId);

    const history = await listGram.listMessages(listParams);

    // Metadata only. Message text is the user's correspondence and has no
    // business in a log that is read while debugging something else.
    actionLog.info("clawgram handleAction list completed", {
      accountId: listAccountId,
      target: listParams.target,
      limit: listParams.limit,
      since: listParams.since ?? null,
      until: listParams.until ?? null,
      returned: history.messages.length,
      truncated: history.truncated,
    });

    return jsonResult({
      ok: true,
      accountId: listAccountId,
      chatId: history.chatId ?? listParams.target,
      count: history.messages.length,
      truncated: history.truncated,
      messages: history.messages,
    });
  }

  // The attachment on a message that is already in a chat.
  //
  // `read` says a photo exists; it does not fetch it, and the inbound
  // path only ever reads what arrives while the agent is being addressed.
  // Everything else — a screenshot posted an hour ago, a diagram in a
  // chat the agent reads but was not tagged in — was visible to the
  // channel and unreachable to the agent. Same `readChats` scope as
  // history: this must not become a way to pull bytes out of a chat the
  // account was never allowed to read.
  if (canonical === "fetch-media") {
    const fetchParams = parseFetchMediaParams(params);
    const fetchAccountId = resolveRuntimeAccountId(cfg, accountId);
    if (!fetchAccountId) {
      throw new Error("clawgram: no configured account found");
    }

    if (!isChatReadable(fetchParams.target, resolveAccountReadChats(cfg, fetchAccountId))) {
      actionLog.warn("clawgram fetch-media refused: chat outside read scope", {
        accountId: fetchAccountId,
        target: fetchParams.target,
      });
      throw new Error(`clawgram: not-allowed-chat ${fetchParams.target}`);
    }

    const fetchGram = requireRuntimeFor(fetchAccountId);

    // Fetching is a read: a dry run answers for real, the same way `read`
    // does. Nothing leaves the machine — the file lands in a temp
    // directory this channel prunes — so a rehearsal that reported
    // "would fetch" would only teach the agent to ask twice.
    const found = await fetchGram.getMessageById(fetchParams.target, fetchParams.messageId);
    const fetchChatId = found.chatId ?? fetchParams.target;
    if (!found.message) {
      actionLog.info("clawgram fetch-media found no message", {
        accountId: fetchAccountId,
        chatId: fetchChatId,
        messageId: fetchParams.messageId,
      });
      return jsonResult({
        ok: false,
        accountId: fetchAccountId,
        chatId: fetchChatId,
        messageId: String(fetchParams.messageId),
        error: "message-not-found",
      });
    }

    // `read` throws the file away, so it gets a directory of its own —
    // the shared directory is keyed by chat and message, and deleting
    // that path would pull the file out from under an earlier `both`
    // fetch of the same message that handed the caller a path.
    // Не общий /tmp: там файлы видит каждый локальный пользователь, а на
    // этом хосте живёт ещё и раннер деплоя (A5-13). При заданном
    // OPENCLAW_STATE_DIR вложения не покидают каталог состояния; иначе
    // корень лежит в /tmp и несёт uid процесса в имени.
    //
    // Прежде это был `/tmp/clawgram-fetched` — постоянное имя в каталоге,
    // который делят все пользователи хоста. Когда агент переехал на свою
    // учётку, имя осталось занято каталогом прежней, и каждая картинка с
    // 05.09 по 07.09.2026 падала с `EACCES`. Имя с uid разводит учётки, а
    // `ensurePrivateDir` проверяет, что каталог действительно наш и закрыт.
    const mediaRoot = process.env.OPENCLAW_STATE_DIR?.trim()
      ? path.join(resolveStateDir(), "tmp")
      : path.join(os.tmpdir(), `clawgram-${typeof process.getuid === "function" ? process.getuid() : "user"}`);
    await ensurePrivateDir(mediaRoot);
    const sharedFetchDir = path.join(mediaRoot, "clawgram-fetched");
    let fetchDir = sharedFetchDir;
    if (fetchParams.mode === "read") {
      const { mkdtemp } = await import("node:fs/promises");
      fetchDir = await mkdtemp(path.join(mediaRoot, "clawgram-media-"));
    } else {
      await pruneFetchedMedia(sharedFetchDir, FETCHED_MEDIA_TTL_MS, Date.now());
    }

    const downloaded = await downloadMessageMediaToFile({
      client: fetchGram.getClient() as any,
      message: found.message,
      maxBytes: INBOUND_MEDIA_MAX_BYTES,
      dir: fetchDir,
      fileNameFor: ({ media, extension }) => fetchedMediaFileName({
        chatId: fetchChatId,
        messageId: fetchParams.messageId,
        extension,
        fileName: media.fileName,
      }),
    });

    if (!downloaded) {
      // Three different nothings, and the agent has to be able to tell
      // them apart: a message with no attachment, an attachment this
      // channel does not read (a video, a spreadsheet), and one too
      // large to be worth the transfer. Saying "could not fetch" to all
      // three is how "she ignored the picture" starts.
      const described = describeMedia((found.message as any)?.media);
      const tooLarge = typeof described?.size === "number" && described.size > INBOUND_MEDIA_MAX_BYTES;
      const error = !described
        ? "no-media"
        : tooLarge
          ? "media-too-large"
          : "unsupported-media";

      actionLog.info("clawgram fetch-media returned nothing", {
        accountId: fetchAccountId,
        chatId: fetchChatId,
        messageId: fetchParams.messageId,
        kind: described?.kind ?? null,
        error,
      });

      return jsonResult({
        ok: false,
        accountId: fetchAccountId,
        chatId: fetchChatId,
        messageId: String(fetchParams.messageId),
        media: described ?? null,
        error,
      });
    }

    let read: string | undefined;
    let readError: string | undefined;
    if (fetchParams.mode !== "file") {
      try {
        read = await understandAttachmentFile({
          runtime: pluginRuntime,
          cfg,
          filePath: downloaded.path,
          mimeType: downloaded.mimeType,
          understanding: downloaded.understanding,
        });
        if (!read) {
          readError = "read-empty";
        }
      } catch (err) {
        // The bytes are already here. A failed reading is worth
        // reporting, but it does not undo a successful fetch: the file
        // still exists and can still be forwarded.
        readError = String(err);
      }
    }

    // `read` mode is the inbound contract — the words, not the file — so
    // the bytes go away with the answer. Any other mode keeps them:
    // that is the whole point of asking for a path.
    if (fetchParams.mode === "read") {
      try {
        const { rm } = await import("node:fs/promises");
        await rm(fetchDir, { recursive: true, force: true });
      } catch {
        // A file left behind is pruned within a day; failing the call
        // over it would throw away a reading that already succeeded.
      }
    }

    actionLog.info("clawgram fetch-media completed", {
      accountId: fetchAccountId,
      chatId: fetchChatId,
      messageId: fetchParams.messageId,
      mode: fetchParams.mode,
      kind: downloaded.media.kind,
      understanding: downloaded.understanding,
      characters: read?.length ?? 0,
      readError: readError ?? null,
    });

    return jsonResult({
      ok: true,
      accountId: fetchAccountId,
      chatId: fetchChatId,
      messageId: String(fetchParams.messageId),
      mode: fetchParams.mode,
      media: downloaded.media,
      understanding: downloaded.understanding,
      filePath: fetchParams.mode === "read" ? undefined : downloaded.path,
      text: read,
      readError,
    });
  }

  /**
   * The scaffold every chat-shaped read shares.
   *
   * `participants`, `topics`, `dialogs`, `joins` and `chatInfo` each
   * spelled out the same sequence: parse, resolve the account, check a
   * scope, fetch the runtime, call it, log counts, answer. Roughly
   * forty lines apiece, differing in four places — which is how a new
   * action came to cost sixty lines of scaffold and how the two gates
   * drifted apart (finding A6-11).
   *
   * The gate follows from the shape rather than being restated: an
   * action that names a chat is gated by `readChats`, `dialogs` has its
   * own discovery gate precisely because its point is to find chats
   * that are not in scope yet, and `joins` has none — the journal only
   * ever holds chats this account was put into.
   *
   * The runtime is a getter, not a value: `joins` reads a file and must
   * not fail merely because no runtime is connected.
   */
  const runRead = async <P, R>(spec: {
    name: string;
    parse: () => P;
    /** The chat being read; absent means the action is not chat-scoped. */
    target?: (parsed: P) => string;
    /** Only `dialogs`: gated by discovery instead of by read scope. */
    discovery?: boolean;
    run: (ctx: {
      parsed: P;
      accountId: string;
      gram: () => ReturnType<typeof requireRuntimeFor>;
    }) => Promise<R>;
    after: (parsed: P, result: R) => Record<string, unknown>;
    result: (parsed: P, result: R) => Record<string, unknown>;
  }) => {
    const parsed = spec.parse();
    const readAccountId = resolveRuntimeAccountId(cfg, accountId);
    if (!readAccountId) {
      throw new Error("clawgram: no configured account found");
    }

    const target = spec.target?.(parsed);
    if (target !== undefined) {
      if (!isChatReadable(target, resolveAccountReadChats(cfg, readAccountId))) {
        actionLog.warn(`clawgram ${spec.name} refused: chat outside read scope`, {
          accountId: readAccountId,
          target,
        });
        throw new Error(`clawgram: not-allowed-chat ${target}`);
      }
    } else if (spec.discovery) {
      if (!isChatDiscoveryEnabled(resolveAccountDiscoverChats(cfg, readAccountId))) {
        actionLog.warn(`clawgram ${spec.name} refused: chat-discovery is not enabled`, {
          accountId: readAccountId,
        });
        throw new Error("clawgram: chat-discovery is not enabled");
      }
    }

    const gram = () => requireRuntimeFor(readAccountId);
    const result = await spec.run({ parsed, accountId: readAccountId, gram });

    actionLog.info(`clawgram handleAction ${spec.name} completed`, {
      accountId: readAccountId,
      ...spec.after(parsed, result),
    });

    return jsonResult({ ok: true, accountId: readAccountId, ...spec.result(parsed, result) });
  };

  // Membership is a read, so the same `readChats` scope that gates history
  // gates it too: this cannot become a way to enumerate chats the account
  // was never allowed to read.
  if (canonical === "participants") {
    return await runRead({
      name: "participants",
      parse: () => parseListParticipantsParams(params),
      target: (p) => p.target,
      run: ({ parsed, gram }) => gram().listParticipants(parsed),
      // Counts only. Member ids are personal data and have no business in
      // a log that is read while debugging something else.
      after: (p, m) => ({
        target: p.target,
        limit: p.limit,
        returned: m.participants.length,
        truncated: m.truncated,
      }),
      result: (p, m) => ({
        chatId: m.chatId ?? p.target,
        count: m.participants.length,
        truncated: m.truncated,
        participants: m.participants,
      }),
    });
  }

  // Topic names. A forum chat is addressed by topic id, and until now an
  // id could only be lifted off an inbound message — so a topic nobody had
  // written in yet was unreachable, and one named in words was unfindable.
  // Titles say what a chat is working on, so the read scope gates them.
  if (canonical === "topics") {
    return await runRead({
      name: "topics",
      parse: () => parseTopicsParams(params),
      target: (p) => p.target,
      run: ({ parsed, gram }) => gram().listTopics(parsed),
      after: (p, f) => ({
        target: p.target,
        limit: p.limit,
        returned: f.topics.length,
        truncated: f.truncated,
      }),
      result: (p, f) => ({
        chatId: f.chatId ?? p.target,
        count: f.topics.length,
        truncated: f.truncated,
        topics: f.topics,
      }),
    });
  }

  // Which chats this account is in. Not gated by `readChats` — the whole
  // point is to find chats that are not in it yet — so it has a gate of
  // its own, is metadata only, and never reports direct chats.
  if (canonical === "dialogs") {
    return await runRead({
      name: "dialogs",
      parse: () => parseDialogsParams(params),
      discovery: true,
      run: ({ parsed, gram }) => gram().listDialogs(parsed),
      // Counts only: which chats a person's account sits in is exactly
      // the kind of thing that should not be sitting in a log.
      after: (p, f) => ({ limit: p.limit, returned: f.dialogs.length, truncated: f.truncated }),
      result: (_p, f) => ({ count: f.dialogs.length, truncated: f.truncated, dialogs: f.dialogs }),
    });
  }

  // Where this account was recently added, and by whom. Reading the journal
  // has no scope check of its own: it only ever contains chats this account
  // was put into, which is exactly what the caller is allowed to learn.
  if (canonical === "joins") {
    return await runRead({
      name: "joins",
      parse: () => parseJoinsParams(params),
      // No runtime: this reads a file, and must answer with none connected.
      run: async ({ parsed, accountId: joinsAccountId }) => selectJoinRecords(
        readJoinRecords(resolveJoinsJournalPath(
          cfg?.channels?.[ "clawgram" ]?.accounts?.[ joinsAccountId ],
          joinsAccountId,
        )),
        parsed,
      ),
      after: (p, selected) => ({
        since: p.since ?? null,
        limit: p.limit,
        returned: selected.length,
      }),
      result: (_p, selected) => ({ count: selected.length, joins: selected }),
    });
  }

  // Describing a chat is a read, so the same `readChats` scope that gates
  // history gates it too — this must not become a way to learn the title
  // and size of a chat the account was never allowed to read.
  if (canonical === "chatInfo") {
    return await runRead({
      name: "chatInfo",
      parse: () => parseChatInfoParams(params, toolContext),
      target: (p) => p.target,
      run: async ({ parsed, gram }) => {
        const { entity, full } = await gram().getChatInfo(parsed.target);
        return describeChat(entity, full);
      },
      // Type and size only. The title of a private chat is as personal as
      // its contents and has no business in a debugging log.
      after: (_p, info) => ({
        type: info.type,
        memberCount: info.memberCount ?? null,
        isForum: info.isForum ?? null,
      }),
      result: (p, info) => ({ chat: { ...info, chatId: info.chatId ?? p.target } }),
    });
  }

  return undefined;
}
