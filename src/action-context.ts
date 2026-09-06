import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { GramJsClientManager } from "./gramjs-client";

/**
 * What one `handleAction` call knows, handed to the three action modules.
 *
 * `handleAction` was a 980-line closure with every branch inline: read,
 * fetch, management, react, upload and send in one function, sharing the
 * variables of its enclosing scope. The branches now live in
 * `actions-read.ts`, `actions-manage.ts` and `actions-send.ts`, and this is
 * the scope they share — resolved once in `channel.ts`, read everywhere
 * (audit B5-13, part 3). Each module answers `undefined` for an action that
 * is not its own; the last one throws for a name nobody claims.
 */
export type ActionContext = {
  /** The spelling the caller used; `canonical` is what it resolves to. */
  action: string;
  canonical: string;
  params: Record<string, unknown>;
  cfg: any;
  accountId?: string | null;
  /** Already resolved from both positions the flag can arrive in. */
  dryRun: boolean;
  toolContext?: {
    currentChannelId?: string;
    currentMessageId?: string | number;
  };
  /** Core's media scope: the roots it declared and the reader it handed over. */
  allowedMediaRoots?: readonly string[];
  readMedia?: (filePath: string) => Promise<Buffer>;
  pluginRuntime?: PluginRuntime;
  resolveRuntimeAccountId: (cfg: any, preferred?: string | null) => string | undefined;
  requireRuntimeFor: (id: string) => GramJsClientManager;
};
