// Offline check that the proxy reaches TelegramClient correctly and that GramJS does NOT
// select the MTProxy transport. Constructor-only — opens no sockets.
//
//   npm run build && node .claude/verify/gramjs-wiring.cjs
//
// Why this matters: GramJS branches on `"MTProxy" in proxy`, so a SOCKS proxy object must
// never carry an `MTProxy` key (not even `false`) or a `secret`.
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const { GramJsClientManager } = require(path.join(ROOT, "dist", "gramjs-client.js"));
const { ConnectionTCPMTProxyAbridged } = require(
  path.join(ROOT, "node_modules", "telegram", "network", "connection", "TCPMTProxy"),
);

const BASE = {
  apiId: 12345678,
  apiHash: "placeholder",
  sessionString: "",
  allowFrom: [ "*" ],
  groups: {},
};

const build = (proxy) => new GramJsClientManager({ ...BASE, ...(proxy ? { proxy } : {}) });

const direct = build(undefined);
const socks5 = build({ ip: "proxy.example.com", port: 1080, socksType: 5, username: "u", password: "p", timeout: 10 });
const socks4 = build({ ip: "203.0.113.10", port: 1081, socksType: 4 });
const p5 = socks5.getClient()._proxy;

let invalidThrew = false;
let invalidLeaked = true;
try {
  build({ ip: "proxy.example.com", port: 0, socksType: 5, password: "leaky-pass" });
} catch (error) {
  invalidThrew = true;
  invalidLeaked = String(error.message).includes("leaky-pass");
}

const checks = [
  [ "no proxy leaves the client unproxied", direct.getClient()._proxy === undefined ],
  [ "no proxy reports no summary", direct.getProxySummary() === undefined ],
  [ "socks5 proxy reaches the client", p5?.socksType === 5 && p5?.ip === "proxy.example.com" ],
  [ "socks5 keeps credentials and timeout", p5?.username === "u" && p5?.password === "p" && p5?.timeout === 10 ],
  [ "proxy object has no MTProxy key", !("MTProxy" in p5) ],
  [ "proxy object has no secret key", !("secret" in p5) ],
  [ "MTProxy transport NOT selected", socks5.getClient()._connection !== ConnectionTCPMTProxyAbridged ],
  [ "InitConnection.proxy stays unset", socks5.getClient()._initRequest.proxy === undefined ],
  [ "socks4 reaches the client", socks4.getClient()._proxy?.socksType === 4 ],
  [ "summaries are credential-free", direct.getProxySummary() === undefined && socks5.getProxySummary() === "socks5" && socks4.getProxySummary() === "socks4" ],
  [ "invalid proxy throws instead of connecting directly", invalidThrew ],
  [ "validation error does not leak the password", !invalidLeaked ],
];

let failed = 0;
for (const [ name, ok ] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
  if (!ok) failed += 1;
}
console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
process.exit(failed === 0 ? 0 : 1);
