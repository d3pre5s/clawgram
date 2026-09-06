// Proves `--auth` re-authorization does NOT erase an existing per-account proxy block.
// Drives the real config-writing path against a throwaway JSON5 config (comments included).
//
//   npm run build && node .claude/verify/auth-preserves-proxy.cjs
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const { updateConfigFileDirectly } = require(path.join(ROOT, "dist", "update-config.js"));
const JSON5 = require(path.join(ROOT, "node_modules", "json5"));

const EXPECTED_PROXY = {
  ip: "proxy.example.com",
  port: 1080,
  socksType: 5,
  username: "proxy-user",
  password: "proxy-pass",
  timeout: 10,
};

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "tg-auth-"));
const configPath = path.join(dir, "openclaw.json");

fs.writeFileSync(configPath, `{
  // hand-written config with comments — the writer must preserve JSON5 shape
  "channels": {
    "clawgram": {
      "accounts": {
        "default": {
          "enabled": true,
          "apiId": 1111,
          "apiHash": "old-hash",
          "sessionString": "old-session",
          "proxy": {
            "ip": "proxy.example.com",
            "port": 1080,
            "socksType": 5,
            "username": "proxy-user",
            "password": "proxy-pass",
            "timeout": 10
          },
          "allowFrom": [ "@someone" ],
          "groups": { "*": { "enabled": true, "groupPolicy": "mention", "allowFrom": [ "*" ] } }
        }
      }
    }
  }
}
`, "utf8");

(async () => {
  await updateConfigFileDirectly(configPath, "default", {
    apiId: 2222,
    apiHash: "new-hash",
    sessionString: "new-session",
  });

  const account = JSON5.parse(fs.readFileSync(configPath, "utf8"))
    .channels[ "clawgram" ].accounts.default;

  const checks = [
    [ "apiId updated", account.apiId === 2222 ],
    [ "apiHash updated", account.apiHash === "new-hash" ],
    [ "sessionString updated", account.sessionString === "new-session" ],
    [ "proxy preserved intact", JSON.stringify(account.proxy) === JSON.stringify(EXPECTED_PROXY) ],
    [ "allowFrom preserved", JSON.stringify(account.allowFrom) === JSON.stringify([ "@someone" ]) ],
  ];

  let failed = 0;
  for (const [ name, ok ] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) failed += 1;
  }

  fs.rmSync(dir, { recursive: true, force: true });
  console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
