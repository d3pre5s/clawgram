import assert from "node:assert/strict";
import test, { describe } from "node:test";

import { createChannelPlugin } from "../src/channel";
import type { RuntimeMap } from "../src/types";

/**
 * Core plans a config hot reload from `plugin.reload.configPrefixes`. A
 * changed path that matches no rule restarts the whole Gateway — measured on
 * 2026-08-13: editing `channels.clawgram.accounts.default.groups` produced
 * `config change requires gateway restart` and a SIGUSR1. Declaring the
 * prefix turns that into a restart of this channel only.
 */
describe("plugin reload declaration", () => {
  test("declares channels.clawgram as a hot-reloadable prefix", () => {
    const channel = createChannelPlugin(new Map() as RuntimeMap) as any;

    assert.deepEqual(channel.reload, { configPrefixes: [ "channels.clawgram" ] });
  });
});
