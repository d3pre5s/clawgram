// End-to-end proof that GramJS dials Telegram THROUGH the configured SOCKS proxy.
// Runs a real local SOCKS4/SOCKS5 server, points TelegramClient at it, records the wire.
// No Telegram credentials, no real proxy, no outbound traffic that completes.
//
//   npm run build && node .claude/verify/socks-proxy-sim.cjs
//
// Expected: control=0 connections; socks5 ver=5; socks5+auth carries credentials;
// socks4 ver=4; every proxied case CONNECTs to a Telegram DC.
const net = require("node:net");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..", "..");
const { GramJsClientManager } = require(path.join(ROOT, "dist", "gramjs-client.js"));

function startSocksServer() {
  const observed = { connections: 0, methods: null, auth: null, connectTo: null, version: null };

  const server = net.createServer((socket) => {
    observed.connections += 1;
    let stage = "greeting";

    socket.on("data", (buf) => {
      if (stage === "greeting" && buf[0] === 0x04) {
        // SOCKS4: VER CD DSTPORT(2) DSTIP(4) USERID\0
        observed.version = 4;
        const userId = buf.slice(8, buf.indexOf(0x00, 8)).toString("utf8");
        observed.connectTo = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}:${buf.readUInt16BE(2)}`;
        observed.auth = userId ? { userId } : null;
        stage = "done";
        socket.write(Buffer.from([ 0x00, 0x5a, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00 ]));
        return;
      }

      if (stage === "greeting") {
        // SOCKS5 greeting: VER NMETHODS METHODS...
        observed.version = 5;
        const methods = [ ...buf.slice(2, 2 + buf[1]) ];
        observed.methods = methods;
        const wantsAuth = methods.includes(0x02);
        socket.write(Buffer.from([ 0x05, wantsAuth ? 0x02 : 0x00 ]));
        stage = wantsAuth ? "auth" : "request";
        return;
      }

      if (stage === "auth") {
        // RFC 1929: VER ULEN UNAME PLEN PASSWD
        const ulen = buf[1];
        const plen = buf[2 + ulen];
        observed.auth = {
          user: buf.slice(2, 2 + ulen).toString("utf8"),
          pass: buf.slice(3 + ulen, 3 + ulen + plen).toString("utf8"),
        };
        socket.write(Buffer.from([ 0x01, 0x00 ]));
        stage = "request";
        return;
      }

      if (stage === "request") {
        // VER CMD RSV ATYP DST.ADDR DST.PORT
        const atyp = buf[3];
        let host, offset;
        if (atyp === 0x01) {
          host = `${buf[4]}.${buf[5]}.${buf[6]}.${buf[7]}`;
          offset = 8;
        } else if (atyp === 0x03) {
          const len = buf[4];
          host = buf.slice(5, 5 + len).toString("utf8");
          offset = 5 + len;
        } else {
          host = "ipv6";
          offset = 20;
        }
        observed.connectTo = `${host}:${buf.readUInt16BE(offset)}`;
        stage = "done";
        socket.write(Buffer.from([ 0x05, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0 ]));
        return;
      }
    });

    socket.on("error", () => {});
  });

  return { server, observed };
}

const listen = (server) =>
  new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server.address().port)));

const BASE = {
  apiId: 12345678,
  apiHash: "0123456789abcdef0123456789abcdef",
  sessionString: "",
  allowFrom: [ "*" ],
  groups: {},
};

async function scenario(label, makeProxy) {
  const { server, observed } = startSocksServer();
  const port = await listen(server);
  const proxy = makeProxy(port);
  const manager = new GramJsClientManager({ ...BASE, ...(proxy ? { proxy } : {}) });

  // connect() cannot complete MTProto against the stub; only the wire evidence matters.
  await Promise.race([
    manager.getClient().connect().catch(() => {}),
    new Promise((resolve) => setTimeout(resolve, 3500)),
  ]);
  await manager.getClient().destroy().catch(() => {});
  await new Promise((resolve) => server.close(resolve));

  const auth = observed.auth ? "yes" : "no";
  console.log(
    `${label.padEnd(22)} conn=${observed.connections} ver=${observed.version ?? "-"} ` +
    `dst=${observed.connectTo ?? "-"} auth=${auth} summary=${manager.getProxySummary() ?? "-"}`,
  );
  return observed;
}

(async () => {
  const control = await scenario("no-proxy (control)", () => undefined);
  const s5 = await scenario("socks5-noauth", (port) => ({ ip: "127.0.0.1", port, socksType: 5 }));
  const s5auth = await scenario("socks5-auth", (port) => ({
    ip: "127.0.0.1", port, socksType: 5, username: "sim-user", password: "sim-pass", timeout: 10,
  }));
  const s4 = await scenario("socks4", (port) => ({ ip: "127.0.0.1", port, socksType: 4 }));

  const checks = [
    [ "control sends nothing to the proxy", control.connections === 0 ],
    [ "socks5 handshake reached the proxy", s5.connections === 1 && s5.version === 5 ],
    [ "socks5 reaches a Telegram DC", Boolean(s5.connectTo) ],
    [ "socks5 offers user/pass only when configured", !s5.methods.includes(0x02) && s5auth.methods.includes(0x02) ],
    [ "credentials transmitted per RFC 1929", s5auth.auth?.user === "sim-user" && s5auth.auth?.pass === "sim-pass" ],
    [ "socks4 uses the SOCKS4 wire format", s4.version === 4 ],
  ];

  console.log("");
  let failed = 0;
  for (const [ name, ok ] of checks) {
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}`);
    if (!ok) failed += 1;
  }
  console.log(failed === 0 ? "\nALL CHECKS PASSED" : `\n${failed} CHECK(S) FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
