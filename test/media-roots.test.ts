import assert from "node:assert/strict";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { createChannelPlugin } from "../src/channel";
import { forgetAccount, rememberAccount } from "../src/account-registry";
import { parseResult } from "./helpers";
import { assertLocalMediaWithinRoots, isLocalMediaPath } from "../src/media";
import type { RuntimeMap } from "../src/types";

/**
 * Core hands every action the media roots the agent is scoped to, and bundled
 * channels enforce them before reading a file. This channel passed `filePath`
 * straight to GramJS `sendFile`, so an agent talked into naming
 * `/opt/openclaw-secrets/secrets.json` — or the config holding
 * `sessionString` — had it uploaded to whatever peer it chose.
 */
describe("outbound local files stay inside the declared roots", () => {
  test("a URL is not a local path and is never root-checked", () => {
    assert.equal(isLocalMediaPath("https://example.com/a.png"), false);
    assert.equal(isLocalMediaPath("data:image/png;base64,AAA"), false);
    assert.equal(isLocalMediaPath("/tmp/a.png"), true);
    assert.equal(isLocalMediaPath("./a.png"), true);
    assert.equal(isLocalMediaPath(undefined), false);
  });

  test("a file inside a root passes and one outside it is refused", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clawgram-roots-"));
    const inside = path.join(root, "report.png");
    await writeFile(inside, "x");
    const outsideRoot = await mkdtemp(path.join(tmpdir(), "clawgram-secrets-"));
    const outside = path.join(outsideRoot, "secrets.json");
    await writeFile(outside, "{}");

    assert.doesNotThrow(() => assertLocalMediaWithinRoots(inside, [ root ]));
    assert.throws(
      () => assertLocalMediaWithinRoots(outside, [ root ]),
      /outside the media roots/,
    );
  });

  test("a symlink inside a root pointing out of it is refused", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "clawgram-roots-"));
    const secretDir = await mkdtemp(path.join(tmpdir(), "clawgram-secrets-"));
    const secret = path.join(secretDir, "secrets.json");
    await writeFile(secret, "{}");
    const link = path.join(root, "innocent.png");
    await symlink(secret, link);

    assert.throws(() => assertLocalMediaWithinRoots(link, [ root ]), /outside the media roots/);
  });

  test("a sibling directory sharing the root's prefix is not inside it", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "clawgram-roots-"));
    const root = path.join(base, "media");
    await mkdir(root);
    const sneaky = path.join(base, "media-secrets");
    await mkdir(sneaky);
    const file = path.join(sneaky, "x.png");
    await writeFile(file, "x");

    assert.throws(() => assertLocalMediaWithinRoots(file, [ root ]), /outside the media roots/);
  });

  test("no declared roots leaves the path alone, as before", () => {
    assert.doesNotThrow(() => assertLocalMediaWithinRoots("/etc/passwd", undefined));
    assert.doesNotThrow(() => assertLocalMediaWithinRoots("/etc/passwd", []));
  });

  test("upload-file refuses a path outside the roots core scoped it to", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const runtimes = new Map([ [ "default", {
      sendMedia: async (args: Record<string, unknown>) => {
        sends.push(args);
        return { id: 1 };
      },
    } ] ]) as unknown as RuntimeMap;
    const channel = createChannelPlugin(runtimes) as any;
    const cfg = { channels: { clawgram: { accounts: { default: {} } } } };
    const root = await mkdtemp(path.join(tmpdir(), "clawgram-roots-"));

    await assert.rejects(
      () => channel.actions.handleAction({
        action: "upload-file",
        params: { to: "-100123", filePath: "/opt/openclaw-secrets/secrets.json" },
        cfg,
        accountId: "default",
        mediaLocalRoots: [ root ],
      }),
      /outside the media roots/,
    );
    assert.deepEqual(sends, [], "nothing may be uploaded once the path is refused");
  });

  test("upload-file still sends a file the agent is allowed to read", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const runtimes = new Map([ [ "default", {
      sendMedia: async (args: Record<string, unknown>) => {
        sends.push(args);
        return { id: 1 };
      },
    } ] ]) as unknown as RuntimeMap;
    const channel = createChannelPlugin(runtimes) as any;
    const cfg = { channels: { clawgram: { accounts: { default: {} } } } };
    const root = await mkdtemp(path.join(tmpdir(), "clawgram-roots-"));
    const allowed = path.join(root, "chart.png");
    await writeFile(allowed, "x");

    await channel.actions.handleAction({
      action: "upload-file",
      params: { to: "-100123", filePath: allowed },
      cfg,
      accountId: "default",
      mediaLocalRoots: [ root ],
    });

    assert.equal(sends.length, 1);
    assert.equal(sends[ 0 ].file, allowed);
  });

  // Core's `mediaReadFile` is the reader that enforces the roots inside core;
  // bundled channels read through it, this one opened the path itself and the
  // reader was never called (finding B5-14).
  test("upload-file reads a local file through core's reader when core gives one", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const reads: string[] = [];
    const runtimes = new Map([ [ "default", {
      sendMedia: async (args: Record<string, unknown>) => {
        sends.push(args);
        return { id: 1 };
      },
    } ] ]) as unknown as RuntimeMap;
    const channel = createChannelPlugin(runtimes) as any;
    const cfg = { channels: { clawgram: { accounts: { default: {} } } } };
    const root = await mkdtemp(path.join(tmpdir(), "clawgram-roots-"));
    const allowed = path.join(root, "chart.png");
    await writeFile(allowed, "on-disk");

    await channel.actions.handleAction({
      action: "upload-file",
      params: { to: "-100123", filePath: allowed },
      cfg,
      accountId: "default",
      mediaAccess: {
        localRoots: [ root ],
        readFile: async (filePath: string) => {
          reads.push(filePath);
          return Buffer.from("via-core");
        },
      },
    });

    assert.deepEqual(reads, [ allowed ]);
    assert.equal(sends.length, 1);
    assert.deepEqual(sends[ 0 ].file, { buffer: Buffer.from("via-core"), fileName: "chart.png" });
  });

  test("a dry run and a refused target never open the file", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const runtimes = new Map([ [ "default", {
      sendMedia: async (args: Record<string, unknown>) => {
        sends.push(args);
        return { id: 1 };
      },
    } ] ]) as unknown as RuntimeMap;
    const channel = createChannelPlugin(runtimes) as any;
    const readFile = async () => { throw new Error("the reader must not run before the dry-run answer or a refusal"); };

    const rehearsal = await channel.actions.handleAction({
      action: "upload-file",
      params: { to: "-100123", filePath: "/nonexistent/chart.png" },
      cfg: { channels: { clawgram: { accounts: { default: {} } } } },
      accountId: "default",
      dryRun: true,
      mediaReadFile: readFile,
    });
    assert.equal(parseResult(rehearsal).dryRun, true);
    assert.equal(sends.length, 0);

    await assert.rejects(
      channel.actions.handleAction({
        action: "upload-file",
        params: { to: "-100999", filePath: "/nonexistent/chart.png" },
        cfg: { channels: { clawgram: { accounts: { default: { sendChats: [ "-100123" ] } } } } },
        accountId: "default",
        mediaReadFile: readFile,
      }),
      /not-allowed-chat/,
    );

    // The core delivery path keeps its scope in the account registry.
    rememberAccount("default", { sendChats: [ "-100123" ], operatorIds: [] });
    try {
      const refused = await channel.outbound.sendMedia({
        accountId: "default",
        to: "-100999",
        filePath: "/nonexistent/chart.png",
        mediaReadFile: readFile,
      });
      assert.equal((refused as any)?.skipped, "not-allowed");
    } finally {
      forgetAccount("default");
    }
    assert.equal(sends.length, 0);
  });

  test("a URL is never handed to core's file reader", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const runtimes = new Map([ [ "default", {
      sendMedia: async (args: Record<string, unknown>) => {
        sends.push(args);
        return { id: 1 };
      },
    } ] ]) as unknown as RuntimeMap;
    const channel = createChannelPlugin(runtimes) as any;
    await channel.actions.handleAction({
      action: "upload-file",
      params: { to: "-100123", mediaUrl: "https://example.invalid/a.png" },
      cfg: { channels: { clawgram: { accounts: { default: {} } } } },
      accountId: "default",
      mediaReadFile: async () => { throw new Error("must not be called for a URL"); },
    });
    assert.equal(sends[ 0 ].file, "https://example.invalid/a.png");
  });

  test("outbound.sendMedia reads through core's reader as well", async () => {
    const sends: Array<Record<string, unknown>> = [];
    const runtimes = new Map([ [ "default", {
      sendMedia: async (args: Record<string, unknown>) => {
        sends.push(args);
        return { id: 1 };
      },
    } ] ]) as unknown as RuntimeMap;
    const channel = createChannelPlugin(runtimes) as any;
    const root = await mkdtemp(path.join(tmpdir(), "clawgram-roots-"));
    const allowed = path.join(root, "voice.ogg");
    await writeFile(allowed, "on-disk");

    await channel.outbound.sendMedia({
      accountId: "default",
      to: "-100123",
      filePath: allowed,
      mediaLocalRoots: [ root ],
      mediaReadFile: async () => Buffer.from("via-core"),
    });

    assert.deepEqual(sends[ 0 ].file, { buffer: Buffer.from("via-core"), fileName: "voice.ogg" });
  });
});
