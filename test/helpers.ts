import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";

/**
 * Обвязка, которую девять наборов тестов собирали каждый у себя.
 *
 * Копии были не совсем одинаковыми, и это главное: `parse` в семи файлах,
 * `makeChannel` в двух, каждая со своими мелкими отличиями в том, как
 * достаётся текст результата. Правка формы ответа означала обход девяти
 * файлов, а забытый оставался зелёным, проверяя старую форму (находка
 * A12-07).
 */

/**
 * Результат действия канала — как объект.
 *
 * Ядро отдаёт либо строку, либо `{ content: [{ text }] }`, и тесты не должны
 * знать, какой из двух: это деталь транспорта, а не предмет проверки.
 */
export function parseResult(result: unknown): any {
  if (typeof result === "string") {
    return JSON.parse(result);
  }
  const text = (result as { content?: Array<{ text?: string }> })?.content?.[ 0 ]?.text;
  return JSON.parse(text ?? "{}");
}

/** Канал с одним аккаунтом и готовым `act(action, params, dryRun)`. */
export function makeChannel(gram: unknown, account: Record<string, unknown> = {}, accountId = "default") {
  const runtimes = new Map([ [ accountId, gram ] ]) as unknown as RuntimeMap;
  const channel = createChannelPlugin(runtimes) as any;
  const cfg = { channels: { clawgram: { accounts: { [ accountId ]: account } } } };

  const act = (action: string, params: Record<string, unknown>, dryRun?: boolean) =>
    channel.actions.handleAction({ action, params, cfg, accountId, dryRun });

  return { channel, cfg, act };
}
