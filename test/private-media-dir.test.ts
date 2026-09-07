import assert from "node:assert/strict";
import { chmod, lstat, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { describe } from "node:test";

import { describePrivateDirProblem, ensurePrivateDir } from "../src/media";

/**
 * The directory attachments land in has to be *ours*, not merely present.
 *
 * `mkdir(..., { recursive: true })` says nothing about an existing directory
 * and `chmod` on somebody else's fails — silently, until this change. The
 * write then failed with a bare `EACCES`, which is what the agent forwarded
 * to its owner as "my disk access was not restored".
 *
 * It really happened: the fetch directory had a fixed name in world-writable
 * `/tmp`, the agent moved to its own account on 04.09.2026, the old account's
 * directory kept the name, and every picture failed from 05.09 to 07.09.
 */
describe("a directory that merely exists is not good enough", () => {
  const ok = { path: "/tmp/x", isDirectory: true, uid: 1003, mode: 0o40700, selfUid: 1003 };

  test("ours, a directory, 0700 — no complaint", () => {
    assert.equal(describePrivateDirProblem(ok), undefined);
  });

  test("owned by another account is named as such, with both uids", () => {
    const problem = describePrivateDirProblem({ ...ok, uid: 1001 });
    assert.match(String(problem), /belongs to uid 1001/);
    assert.match(String(problem), /runs as 1003/);
    // The message has to say what to do about it: an errno did not.
    assert.match(String(problem), /leftover from another account/);
  });

  test("group- or world-readable is refused: private correspondence lands here", () => {
    assert.match(String(describePrivateDirProblem({ ...ok, mode: 0o40750 })), /readable beyond this account \(mode 750\)/);
    assert.match(String(describePrivateDirProblem({ ...ok, mode: 0o40777 })), /mode 777/);
    assert.equal(describePrivateDirProblem({ ...ok, mode: 0o40700 }), undefined);
  });

  test("a symlink is refused before anything is written through it", () => {
    assert.match(
      String(describePrivateDirProblem({ ...ok, isSymbolicLink: true })),
      /symlink/,
    );
  });

  test("a file sitting on the path is refused", () => {
    assert.match(String(describePrivateDirProblem({ ...ok, isDirectory: false })), /not a directory/);
  });

  test("where the platform has no uid, ownership is not invented", () => {
    // Windows: `process.getuid` is absent, `stats.uid` is 0 for everything.
    assert.equal(describePrivateDirProblem({ ...ok, uid: 0, selfUid: undefined }), undefined);
  });
});

describe("ensurePrivateDir on a real filesystem", () => {
  test("creates it 0700 and accepts it on the second call", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "clawgram-privdir-"));
    try {
      const dir = path.join(base, "fetched");
      await ensurePrivateDir(dir);
      assert.equal((await lstat(dir)).mode & 0o777, 0o700);
      await ensurePrivateDir(dir);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("tightens a directory left open by an earlier umask", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "clawgram-privdir-"));
    try {
      const dir = path.join(base, "fetched");
      await mkdir(dir);
      await chmod(dir, 0o775);
      await ensurePrivateDir(dir);
      assert.equal((await lstat(dir)).mode & 0o777, 0o700, "0775 is what a plain shell mkdir leaves behind");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("refuses a symlink instead of following it", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "clawgram-privdir-"));
    try {
      const real = path.join(base, "real");
      const link = path.join(base, "link");
      await mkdir(real, { mode: 0o700 });
      await symlink(real, link);
      await assert.rejects(() => ensurePrivateDir(link), /symlink/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("refuses a file on the path, and says so rather than throwing EEXIST", async () => {
    const base = await mkdtemp(path.join(tmpdir(), "clawgram-privdir-"));
    try {
      const file = path.join(base, "fetched");
      await writeFile(file, "");
      await assert.rejects(() => ensurePrivateDir(file), /clawgram: .* exists and is not a directory/);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
