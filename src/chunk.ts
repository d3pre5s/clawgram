/**
 * Telegram limits: 4096 characters per message, 1024 per media caption.
 *
 * Core chunks only the replies it dispatches itself; a `send` issued through
 * the message tool — the way the guard scripts deliver reports — reaches
 * GramJS whole, and GramJS does not split either, so a long report failed
 * with MESSAGE_TOO_LONG and the agent saw "✉️ Message failed" while the
 * human saw nothing (audit B5-03).
 *
 * Splitting prefers paragraph breaks, then line breaks, then a hard cut at
 * the limit. It runs on the text as the agent wrote it — before HTML
 * rendering — so a chunk boundary can only fall between the agent's own
 * lines, never inside an entity GramJS produced.
 */
export const TELEGRAM_TEXT_LIMIT = 4096;
export const TELEGRAM_CAPTION_LIMIT = 1024;

export function chunkTelegramText(text: string, limit = TELEGRAM_TEXT_LIMIT): string[] {
  const chars = Array.from(text);
  if (chars.length <= limit) return [ text ];
  const chunks: string[] = [];
  let rest = text;
  while (Array.from(rest).length > limit) {
    const window = Array.from(rest).slice(0, limit).join("");
    let cut = window.lastIndexOf("\n\n");
    if (cut < limit / 2) cut = window.lastIndexOf("\n");
    if (cut < limit / 2) cut = window.lastIndexOf(" ");
    if (cut < limit / 2) cut = window.length;
    const piece = rest.slice(0, cut).replace(/\s+$/u, "");
    chunks.push(piece);
    rest = rest.slice(cut).replace(/^\s+/u, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}
