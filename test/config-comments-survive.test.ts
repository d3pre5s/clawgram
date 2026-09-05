import assert from "node:assert/strict";
import test, { describe } from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { updateConfigFileDirectly } from "../src/update-config";

const AUTH = { apiId: 2, apiHash: "new", sessionString: "newsess", selfId: "42" };

describe("--auth keeps everything it is not editing", () => {
  // The updater located `channels` surgically and then replaced its whole value
  // with JSON.stringify, so every JSON5 comment, trailing comma and hand
  // formatting inside it went away — including other channels' blocks, which
  // have nothing to do with authorising this one. The file is JSON5 precisely
  // so it can carry those notes (A6-06).
  async function withConfig(body: string) {
    const dir = await mkdtemp(path.join(tmpdir(), "clawgram-comments-"));
    const configPath = path.join(dir, "openclaw.json");
    await writeFile(configPath, body, "utf8");
    return configPath;
  }

  test("comments outside the edited account survive", async () => {
    const configPath = await withConfig([
      "{",
      "  // как ходит почта",
      '  "channels": {',
      "    // другой канал — трогать нельзя",
      '    "slack": { "token": "keep-me" },',
      '    "clawgram": {',
      '      "accounts": {',
      '        "default": { "apiId": 1, "apiHash": "old", "sessionString": "old" }',
      "      }",
      "    }",
      "  },",
      "  // хвост файла",
      '  "gateway": { "port": 18789 }',
      "}",
      "",
    ].join("\n"));

    await updateConfigFileDirectly(configPath, "default", AUTH);
    const after = await readFile(configPath, "utf8");

    assert.match(after, /\/\/ как ходит почта/);
    assert.match(after, /\/\/ другой канал — трогать нельзя/);
    assert.match(after, /\/\/ хвост файла/);
    assert.match(after, /"slack": \{ "token": "keep-me" \}/, "чужой канал переформатирован");
    assert.match(after, /"apiHash": "new"/);
    assert.match(after, /"sessionString": "newsess"/);
  });

  test("a second account is left alone", async () => {
    const configPath = await withConfig([
      "{",
      '  "channels": { "clawgram": { "accounts": {',
      '    "personal": { "apiId": 9, "apiHash": "keep", "sessionString": "keep" },',
      '    "default": { "apiId": 1, "apiHash": "old", "sessionString": "old" }',
      "  } } }",
      "}",
      "",
    ].join("\n"));

    await updateConfigFileDirectly(configPath, "default", AUTH);
    const after = await readFile(configPath, "utf8");

    assert.match(after, /"personal": \{ "apiId": 9, "apiHash": "keep", "sessionString": "keep" \}/);
    assert.match(after, /"apiHash": "new"/);
  });

  test("a config without the section gets it created", async () => {
    const configPath = await withConfig('{\n  "gateway": { "port": 1 }\n}\n');
    await updateConfigFileDirectly(configPath, "default", AUTH);
    const after = await readFile(configPath, "utf8");

    assert.match(after, /"gateway": \{ "port": 1 \}/, "существующее не тронуто");
    assert.match(after, /"sessionString": "newsess"/);
  });
});
