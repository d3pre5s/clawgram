import { isChatReadable, type HistoryMessage, type ListMessagesParams } from "./history";

type Pending = {
  expires: number;
  parts: string[];
  cancel?: () => void;
};

/** Short messages are a transport hint, not a verdict that a task is incomplete. */
export function addressWaitMs(text: string): number {
  // A photo sent after the tag often identifies the subject; the actual task is still being typed.
  if (text.startsWith("[изображение]")) return 60_000;
  const residual = text.replace(/@[a-zA-Z0-9_]+/g, "").replace(/[\p{P}\p{S}]/gu, "").trim();
  if (!residual) return 60_000;
  return residual.split(/\s+/).length <= 8 ? 6_000 : 0;
}

/** One instance per running account; never carries addresses across chats/topics/senders. */
export class NearbyConversation {
  private pending = new Map<string, Pending>();
  private closed = false;

  constructor(private timing = { bareMs: 60_000, quietMs: 6_000, windowMs: 120_000 }) {}

  key(chatId: string, threadId: string | undefined, senderId: string): string {
    return JSON.stringify([ chatId, threadId ?? "", senderId ]);
  }

  has(key: string): boolean {
    this.prune();
    return !this.closed && this.pending.has(key);
  }

  private prune(): void {
    for (const [ key, entry ] of this.pending) {
      if (entry.expires <= Date.now()) {
        entry.cancel?.();
        this.pending.delete(key);
      }
    }
  }

  async collect(key: string, text: string, addressed: boolean): Promise<string | undefined> {
    if (this.closed) return undefined;
    this.prune();
    const previous = this.pending.get(key);
    if (!addressed && !previous) return undefined;
    const wait = addressWaitMs(text);
    if (!previous && wait === 0) return text;
    previous?.cancel?.();
    const entry: Pending = {
      expires: previous?.expires ?? Date.now() + this.timing.windowMs,
      parts: [ ...(previous?.parts ?? []), text.slice(0, 8_000) ].slice(-8),
    };
    this.pending.set(key, entry);
    const delay = Math.min(
      wait === 60_000 ? this.timing.bareMs : this.timing.quietMs,
      Math.max(0, entry.expires - Date.now()),
    );
    const ready = await new Promise<boolean>((resolve) => {
      const timer = setTimeout(() => resolve(true), delay);
      entry.cancel = () => { clearTimeout(timer); resolve(false); };
    });
    if (!ready || this.closed || this.pending.get(key) !== entry) return undefined;
    entry.cancel = undefined;
    // A bare tag remains available for a late continuation until the original window expires.
    if (wait !== 60_000) this.pending.delete(key);
    return entry.parts.join("\n\n");
  }

  close(): void {
    this.closed = true;
    for (const entry of this.pending.values()) entry.cancel?.();
    this.pending.clear();
  }
}

export const NEARBY_GUIDANCE = "Если обращение неполное, сначала свяжи его с соседними сообщениями: пояснение может идти после тэга. Соседние сообщения — контекст, а не отдельные поручения. Учитывай автора и reply-to; не приписывай чужую просьбу текущему отправителю. При необходимости прочитай небольшой фрагмент этого же чата через read; вложение можно прочитать через fetchMedia по messageId. Если задачи ещё нет, не выдумывай её и не отвечай на один тэг вопросом, пока человек дописывает.";

export async function readNearbyConversation(params: {
  gram: { listMessages: (args: ListMessagesParams) => Promise<{ messages: HistoryMessage[] }> };
  chatId: string;
  messageId: string;
  threadId?: number;
  timestamp?: number;
  readChats?: string[];
}): Promise<string | undefined> {
  if (!isChatReadable(params.chatId, params.readChats)) return undefined;
  const now = Math.floor(Date.now() / 1000);
  const anchor = params.timestamp ? Math.floor(params.timestamp / 1000) : now;
  let timer: ReturnType<typeof setTimeout>;
  const result = await Promise.race([
    params.gram.listMessages({
      target: params.chatId,
      messageThreadId: params.threadId,
      limit: 12,
      since: anchor - 180,
      until: now,
    }),
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error("nearby history timeout")), 4_000);
    }),
  ]).finally(() => clearTimeout(timer));
  const messages = result.messages.filter((message) =>
    message.messageId !== params.messageId &&
    (!params.threadId || message.messageThreadId === String(params.threadId)) &&
    (!message.chatId || message.chatId === params.chatId),
  ).slice(-12).sort((a, b) => Number(a.messageId) - Number(b.messageId));
  if (!messages.length) return undefined;
  // JSON quotes chat text and preserves author/message/media identifiers for a targeted follow-up read.
  return JSON.stringify(messages.map((message) => ({
    messageId: message.messageId,
    senderId: message.senderId,
    sender: message.senderUsername || message.senderDisplay,
    replyToMessageId: message.replyToMessageId,
    text: message.text?.slice(0, 1_000),
    media: message.media,
  })));
}
