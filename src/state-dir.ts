/**
 * Где живёт состояние OpenClaw — одним ответом для всего плагина.
 *
 * `OPENCLAW_STATE_DIR` первичен, дом — запасной вариант. Правило не
 * косметическое: изолированный Gateway, который AGENTS.md предписывает для
 * любой локальной проверки («никогда не трогай `~/.openclaw` — всегда задавай
 * `OPENCLAW_STATE_DIR`»), иначе продолжает писать в боевое состояние.
 *
 * Помощник по медиа переменную уже уважал, журнал присоединений — нет, и
 * тестовый экземпляр дописывал записи в живой журнал, а на двух тысячах
 * записей переписывал его (находка A6-07). Резолвер один, чтобы такие
 * расхождения не заводились по одному на файл.
 */
import { homedir } from "node:os";
import { join } from "node:path";

export function resolveStateDir(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.OPENCLAW_STATE_DIR;
  if (typeof configured === "string" && configured.trim()) return configured.trim();
  return join(homedir(), ".openclaw");
}
