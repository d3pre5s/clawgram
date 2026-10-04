import { strict as assert } from "node:assert";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";

/**
 * The SDK surface this plugin may lean on, checked against the source.
 *
 * The suite runs against the core in `devDependencies`, which still has what
 * OpenClaw 2026.8 removed — so a build and a green suite here say nothing
 * about a gateway on 2026.8 or 2026.9. There, `channel-runtime` and
 * `direct-dm` no longer resolve and the plugin does not load; the root
 * `openclaw/plugin-sdk` barrel is gone (a type-only import, but it breaks a
 * build against a newer core); and `buildInboundReplyDispatchBase` is still
 * declared but no longer exported, so it arrives as `undefined` and fails
 * only when a group turn runs.
 *
 * Their replacements exist from 2026.5.27, the declared floor; this keeps
 * the old spellings from coming back with a copied snippet.
 */
const SRC = path.resolve(__dirname, "..", "..", "src");

const REMOVED_SUBPATHS = [
  "openclaw/plugin-sdk",
  "openclaw/plugin-sdk/channel-runtime",
  "openclaw/plugin-sdk/direct-dm",
];

const REMOVED_NAMES = [
  "buildInboundReplyDispatchBase",
];

function sources(): Array<[ string, string ]> {
  return readdirSync(SRC)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => [ f, readFileSync(path.join(SRC, f), "utf8") ]);
}

describe("SDK subpaths OpenClaw 2026.8 removed", () => {
  it("no source file imports one", () => {
    const found: string[] = [];
    for (const [ file, text ] of sources()) {
      for (const m of text.matchAll(/from\s+"(openclaw\/plugin-sdk[^"]*)"/g)) {
        if (REMOVED_SUBPATHS.includes(m[ 1 ])) {
          found.push(`${file}: ${m[ 1 ]}`);
        }
      }
    }
    assert.deepEqual(found, []);
  });

  it("no source file imports a helper that core stopped exporting", () => {
    const found: string[] = [];
    for (const [ file, text ] of sources()) {
      for (const m of text.matchAll(/import\s+(?:type\s+)?\{([^}]*)\}\s*from\s*"openclaw\/plugin-sdk[^"]*"/g)) {
        for (const name of REMOVED_NAMES) {
          if (new RegExp(`\\b${name}\\b`).test(m[ 1 ])) {
            found.push(`${file}: ${name}`);
          }
        }
      }
    }
    assert.deepEqual(found, []);
  });

  it("the declared floor is the release that has every replacement", () => {
    const pkg = JSON.parse(readFileSync(path.resolve(__dirname, "..", "..", "package.json"), "utf8"));
    assert.equal(pkg.peerDependencies.openclaw, ">=2026.5.27");
    assert.equal(pkg.openclaw.compat.pluginApi, ">=2026.5.27");
    assert.equal(pkg.openclaw.compat.minGatewayVersion, "2026.5.27");
  });
});
