# Verification scripts

Reproducible checks for the SOCKS proxy feature. Tracked since 2.25.0 (audit B5-06); they are not part of
the shipped package and not part of `npm test`.

Every script prints `PASS`/`FAIL` per assertion and exits non-zero on failure. All read from `dist/`,
so **build first**:

```bash
npm run build
```

| Script | Proves | Needs network |
|---|---|---|
| `gramjs-wiring.cjs` | proxy reaches `TelegramClient`; no `MTProxy`/`secret` key; MTProxy transport not selected; invalid proxy throws without leaking the password | no |
| `auth-preserves-proxy.cjs` | `--auth` updates credentials without erasing an existing `proxy` block, JSON5 comments intact | no |
| `socks-proxy-sim.cjs` | GramJS really dials Telegram through a live local SOCKS4/SOCKS5 server; credentials go over RFC 1929; control case sends nothing | loopback only |

```bash
node scripts/verify/gramjs-wiring.cjs
node scripts/verify/auth-preserves-proxy.cjs
node scripts/verify/socks-proxy-sim.cjs
```

Notes:

- `socks-proxy-sim.cjs` resolves a real Telegram DC address and attempts a connection that cannot
  complete against the stub server, so GramJS logs retries and `WebSocket connection failed` — that
  noise is expected. Only the `PASS`/`FAIL` block at the end matters. Silence the rest with `2>/dev/null`.
- Runtime is a few seconds; the simulation takes ~15 s because each scenario waits out a connect
  attempt.
- No credentials, no real proxy and no Telegram account are required or accepted. Never add real ones.

## Validating the manifest against the real OpenClaw CLI

Not scripted, because it mutates an OpenClaw state directory. Always isolate it — never touch
`~/.openclaw`:

```bash
export OPENCLAW_STATE_DIR=/tmp/oc-state OPENCLAW_CONFIG_PATH=/tmp/oc-state/openclaw.json
mkdir -p /tmp/oc-state && echo '{}' > "$OPENCLAW_CONFIG_PATH"
npx openclaw plugins install "$(git rev-parse --show-toplevel)" --force
npx openclaw config validate
```

Start from `{}` — install refuses when the config already references the not-yet-installed channel.
Re-installing a changed manifest requires `--force`.
