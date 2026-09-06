// Входящее вложение: скачать, понять, отдать текстом.
//
// Вынесено из channel.ts — файла на 3145 строк при следующем по величине
// 1165 (находка A6-11). Ни диспетчера, ни конфигурации канала здесь нет:
// только путь «файл → текст», общий у входящего контура и у `fetch-media`.

import os from "node:os";
import path from "node:path";
import { existsSync } from "node:fs";

import { downloadInboundMediaToTempFile } from "./media";
import { resolveStateDir } from "./state-dir";
import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";

/** Attachments above this are left unread: a long recording or a huge image is
 *  a different conversation from a spoken line or a screenshot, and the
 *  transfer is not free. */
export const INBOUND_MEDIA_MAX_BYTES = 25 * 1024 * 1024;

/**
 * Locates the agent directory that image understanding needs.
 *
 * Image models are called with the agent's own credentials, so the pipeline
 * refuses to run without this path — audio does not need it, which is why
 * voice notes worked before images did. The platform exposes no resolver to
 * plugins, so the documented layout is reconstructed here and checked before
 * use: a wrong guess would fail the read anyway, and returning undefined lets
 * the caller degrade instead of throwing.
 */
function resolveAgentDirForMedia(cfg: any): string | undefined {
  const stateDir = resolveStateDir();
  const configuredId = cfg?.agents?.defaults?.id;
  const agentId = typeof configuredId === "string" && configuredId.trim() ? configuredId.trim() : "main";
  const dir = path.join(stateDir, "agents", agentId, "agent");
  return existsSync(dir) ? dir : undefined;
}

/**
 * Turns a downloaded attachment into text.
 *
 * Shared by the inbound path and by `fetch-media`: the backend choice lives in
 * `runtime.mediaUnderstanding`, and both callers have to make exactly the same
 * call — an image read on arrival and the same image read on request must not
 * become two different readings because two call sites drifted.
 */
export async function understandAttachmentFile(params: {
  runtime?: PluginRuntime;
  cfg: any;
  filePath: string;
  mimeType?: string;
  understanding: "transcript" | "description";
}): Promise<string | undefined> {
  const media = params.runtime?.mediaUnderstanding;
  if (!media) return undefined;

  const result = params.understanding === "transcript"
    ? await media.transcribeAudioFile({
      filePath: params.filePath,
      cfg: params.cfg,
      mime: params.mimeType,
    })
    : await media.describeImageFile({
      filePath: params.filePath,
      cfg: params.cfg,
      mime: params.mimeType,
      agentDir: resolveAgentDirForMedia(params.cfg),
    });

  const text = typeof result?.text === "string" ? result.text.trim() : "";
  return text || undefined;
}

export async function readInboundAttachment(params: {
  gram: any;
  event: any;
  cfg: any;
  runtime?: PluginRuntime;
  log?: any;
  accountId: string;
  chatId: string;
  messageId: string;
}): Promise<{ text: string; understanding: "transcript" | "description" } | undefined> {
  const media = params.runtime?.mediaUnderstanding;
  const message = params.event?.message;
  if (!media || !message) {
    return undefined;
  }

  let downloaded: Awaited<ReturnType<typeof downloadInboundMediaToTempFile>>;
  try {
    downloaded = await downloadInboundMediaToTempFile({
      client: params.gram.getClient() as any,
      message,
      maxBytes: INBOUND_MEDIA_MAX_BYTES,
      tmpDir: os.tmpdir(),
    });
  } catch (err) {
    params.log?.info?.("clawgram attachment download failed", {
      accountId: params.accountId,
      chatId: params.chatId,
      messageId: params.messageId,
      error: String(err),
    });
    return undefined;
  }

  if (!downloaded) {
    return undefined;
  }

  try {
    const read = await understandAttachmentFile({
      runtime: params.runtime,
      cfg: params.cfg,
      filePath: downloaded.path,
      mimeType: downloaded.mimeType,
      understanding: downloaded.understanding,
    });
    if (!read) {
      params.log?.info?.("clawgram attachment read empty", {
        accountId: params.accountId,
        chatId: params.chatId,
        messageId: params.messageId,
        understanding: downloaded.understanding,
      });
      return undefined;
    }
    params.log?.info?.("clawgram attachment read", {
      accountId: params.accountId,
      chatId: params.chatId,
      messageId: params.messageId,
      understanding: downloaded.understanding,
      characters: read.length,
    });
    return { text: read, understanding: downloaded.understanding };
  } catch (err) {
    params.log?.info?.("clawgram attachment read failed", {
      accountId: params.accountId,
      chatId: params.chatId,
      messageId: params.messageId,
      understanding: downloaded.understanding,
      error: String(err),
    });
    return undefined;
  } finally {
    void (async () => {
      try {
        const { rm } = await import("node:fs/promises");
        const { dirname } = await import("node:path");
        await rm(dirname(downloaded!.path), { recursive: true, force: true });
      } catch {
        // Leaving a temp file behind is not worth failing a delivered message.
      }
    })();
  }
}
