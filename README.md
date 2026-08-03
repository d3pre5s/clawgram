# Clawgram

Clawgram is a personal-Telegram channel plugin for [OpenClaw](https://github.com/openclaw/openclaw) — it connects as a regular Telegram user account (not a bot) via MTProto using [GramJS](https://github.com/gram-js/gramjs). Your AI assistant reads and responds as you.

> Clawgram is the actively maintained continuation of
> [eldaruma/telegram-userbot](https://github.com/eldaruma/telegram-userbot) (MIT).
>
> **Breaking change in 2.0.0:** the plugin id and channel name changed from
> `telegram-userbot` to `clawgram`. When upgrading from 1.x (or from the
> original telegram-userbot), rename the `channels.telegram-userbot` section of
> `openclaw.json` to `channels.clawgram` (contents stay as-is), update any
> `plugins.allow` entry, and replace `telegram-userbot:<target>` address
> prefixes with `clawgram:<target>`. Then restart the Gateway.

> **WARNING**: Using a user account for automated messaging may violate Telegram's Terms of Service. Use a dedicated secondary account. Your account could be banned or restricted.

> **What this plugin can do with your account.** It logs in as a *full Telegram user*, not a bot:
> it can read private and group conversations within its configured scope and send messages that are
> indistinguishable from ones you typed yourself. Recipients cannot tell an assistant reply from a
> human one. Treat the account as compromised-if-leaked: `apiHash` and `sessionString` are bearer
> credentials for everything that account can reach. Scope reads with `readChats`, gate senders with
> `allowFrom`, and prefer a dedicated account over your primary one — see
> [Security and privacy](#security-and-privacy).


## Features

- **MTProto Client API** — operates as a user account, not a bot
- **DM & Group support** — private chats, groups, supergroups, forum topics
- **Forum topic routing** — correctly routes replies to the right forum topic thread
- **@Mention detection** — respond only when mentioned in groups (text, caption, and ID-based mentions)
- **Read receipts** — mark messages as read
- **Emoji reactions** — acknowledge a message with a reaction instead of a reply (`react` action)
- **Chat metadata** — title, type, member count, description, forum flag and pinned message (`chatInfo` action)
- **User allowlist** — control which user has access to send messages for direct
- **Chat allowlist** — control which chats the assistant can access
- **Multi-account** — run multiple Telegram accounts simultaneously
- **Per-group settings** — different behavior for different groups
- **SOCKS4/SOCKS5 proxy** — optional native MTProto proxy per account
- **Slash commands** — [slash commands](https://docs.openclaw.ai/tools/slash-commands) are available in DM to the connected account (`/status`, `/reset`, `/new`, etc.)


## Requirements

- OpenClaw >= 2026.5.26 — earlier releases carry published high-severity advisories
  (among them a pairing-scoped session that could restore revoked node-token authority, fixed in
  `2026.5.26`). Since this plugin reads messages and acts on an account, running it on a vulnerable
  Gateway widens the blast radius, so 2.1.0 refuses to install below that version. Built and tested
  against `2026.7.1-2`.
- Telegram API credentials from [my.telegram.org](https://my.telegram.org)
- Node.js >= 22

## Installation

```bash
# from npm (default resolution)
openclaw plugins install clawgram

# or explicitly from ClawHub
openclaw plugins install clawhub:clawgram
```

## Setup

### 1. Get Telegram API credentials

- Go to https://my.telegram.org
- Log in with your phone number
- Go to "API development tools"
- Create a new application
- Copy the `api_id` and `api_hash`


### 2. Log in to your telegram account

Log in to your telegram account via cli using API credentials and phone number

```bash
openclaw clawgram --auth
```

If the custom OpenClaw cli command hangs, run the standalone authorization script directly:

```bash
node ~/.openclaw/extensions/clawgram/dist/clawgram-cli.js --auth
```

> **NOTES**: Starting with OpenClaw `2026.5.12`, hangs have been observed in some environments when running custom plugin cli commands through `openclaw <plugin command> ...`. If that happens, use the standalone command above. It runs the same authorization flow, but bypasses the custom cli entrypoint inside OpenClaw.

Follow the steps in the console

```bash
Starting Clawgram authorization...
Please enter your apiId: 12345678
Please enter your apiHash: c4b9c0fde16342afe52907847df27596
[2026-05-10T16:01:24.570] [INFO] - [Running gramJS version 2.26.21]
[2026-05-10T16:01:24.578] [INFO] - [Connecting to x.x.x.x:80/TCPFull...]
[2026-05-10T16:01:25.804] [INFO] - [Connection to x.x.x.x:80/TCPFull complete!]
[2026-05-10T16:01:25.808] [INFO] - [Using LAYER 198 for initial connect]
Please enter your number: +1 XXX XXX XXXX
Please enter the code you received: 12345
[2026-05-10T16:01:56.384] [INFO] - [Signed in successfully as <USER>]
[2026-05-10T16:01:56.388] [WARN] - [Disconnecting...]
[2026-05-10T16:01:56.390] [INFO] - [Disconnecting from x.x.x.x:80/TCPFull...]
Telegram authorization completed successfully.

Session string received (352 chars) — kept out of this output.
```

> Since 2.1.0 the session string is **not** printed after a successful login: it is a bearer
> credential for the whole account, and stdout ends up in scrollback, CI logs and screen shares.
> It is written straight into `openclaw.json`, and only shown — behind an explicit warning — if you
> decline the automatic config update and have to paste it by hand.

Since the plugin supports connecting multiple accounts, at this step the cli will ask you for the account ID, if you do not enter anything, the [default] key will be applied. You can also enter your own value.

```bash
Enter account id for config [default]: [2026-05-10T16:01:56.402] [INFO] - [connection closed]
[2026-05-10T16:02:02.096] [WARN] - [Disconnecting...]
[2026-05-10T16:02:02.103] [INFO] - [Disconnecting from x.x.x.x:80/TCPFull...]
```

In the next step, you must confirm or reject the automatic update of the openclaw.json configuration file. If you reject it or receive an error updating the file, the cli will display an openclaw.json configuration fragment that you must add manually.

The automatic config update keeps the rest of `openclaw.json` intact and only updates the `channels.clawgram` section for the selected account. A timestamped backup of the config file is created before any write attempt.

Update **yes**
```bash
Update OpenClaw config automatically? [y/N]: y

Config overwrite: /root/.openclaw/openclaw.json (sha256 97c4b55e61901aa71ff40898b5ebfbadd0f8fb9cd0145f3a08a5e5163783258a -> 6447683c687ceeb0dba09b2ca5187967e979ad2663d901977c608b6a09c9c432, backup=/root/.openclaw/openclaw.json.bak)

OpenClaw config updated: /root/.openclaw/openclaw.json
Configured account id: default
Config backup created: /root/.openclaw/openclaw.json.bak-20260512-084914-clawgram-auth

After applying config changes, restart OpenClaw:

openclaw gateway restart
```

Update **no**
```bash
Update OpenClaw config automatically? [y/N]: n

JSON fragment for manual insertion:
{
  "channels": {
    "clawgram": {
      "accounts": {
        "default": {
          "enabled": true,
          "apiId": 12345678,
          "apiHash": "apiHash",
          "sessionString": "sessionString",
          "allowFrom": [
            "*"
          ],
          "groups": {
            "*": {
              "enabled": true,
              "groupPolicy": "mention",
              "allowFrom": [
                "*"
              ]
            }
          }
        }
      }
    }
  }
}

After applying config changes, restart OpenClaw:

openclaw gateway restart
```

### 3. Restart OpenClaw gateway

```bash
openclaw gateway restart
```


## Configuration Reference

### JSON Reference

```json
{
  "channels": {
    "clawgram": {
      "accounts": {
        "default": {
          "enabled": true,
          "apiId": 12345678,
          "apiHash": "apiHash",
          "sessionString": "sessionString",
          "allowFrom": [
            "*"
          ],
          "groups": {
            "*": {
              "enabled": true,
              "groupPolicy": "mention",
              "allowFrom": [
                "*"
              ]
            }
          }
        }
      }
    }
  }
}
```

### Mention fields 

| Field | Type | Default | Description |
|---|---|---|---|
| `apiId` | number | required | Telegram API ID |
| `apiHash` | string | required | Telegram API hash |
| `sessionString` | string | `""` | Authenticated StringSession |
| `allowFrom` | string[] | `["*"]` | Allowed sender IDs/usernames for direct messages only |
| `groups` | object | `{}` | Allowed groups map keyed by explicit group id or `*` |
| `proxy` | object | unset | Optional SOCKS4/SOCKS5 proxy for this account — see [Proxy (SOCKS4/SOCKS5)](#proxy-socks4socks5) |

Group config fields:

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enables or disables replies in the group |
| `groupPolicy` | `"open"` \| `"mention"` | `"mention"` | `open` replies to any group message, `mention` only on @mention or reply-to-self |
| `allowFrom` | string[] | `["*"]` | Allowed sender IDs/usernames inside that group |


### Configuration variant for example

```json
{
  "channels": {
    "clawgram": {
      "accounts": {
        "default": {
          "enabled": true,
          "apiId": 12345678,
          "apiHash": "apiHash",
          "sessionString": "sessionString",
          "allowFrom": [
            "@nickname1",
            "@nickname2"
          ],
          "groups": {
            "-1001234567899": {
              "enabled": true,
              "groupPolicy": "mention",
              "allowFrom": [
                "@nickname1"
              ]
            },
            "-1009876543219": {
              "enabled": true,
              "groupPolicy": "mention",
              "allowFrom": [
                "*"
              ]
            },
            "-1001234567891": {
              "enabled": true,
              "groupPolicy": "open",
              "allowFrom": [
                "*"
              ]
            }
          }
        }
      }
    }
  }
}
```


## Proxy (SOCKS4/SOCKS5)

### Why you may need it

GramJS speaks MTProto over **raw TCP sockets**. OpenClaw's managed proxy (`proxy.proxyUrl`) and the
standard `HTTP_PROXY` / `HTTPS_PROXY` environment variables only cover HTTP and WebSocket traffic, so
they do **not** route the userbot's Telegram connection. On hosts where Telegram is blocked or
filtered, authorization and runtime work when the whole Gateway is launched through something like
`proxychains`, but a normal systemd restart of the Gateway then fails to connect.

Configure `proxy` on the account to make GramJS dial Telegram through a SOCKS proxy natively, with no
external wrapper and no changes to how the Gateway is started.

> **This is a SOCKS proxy, not a Telegram MTProxy.** MTProxy (the `secret`-based Telegram proxy
> protocol) is a different transport and is intentionally out of scope here.

### SOCKS5 example

```json
{
  "channels": {
    "clawgram": {
      "accounts": {
        "default": {
          "enabled": true,
          "apiId": 12345678,
          "apiHash": "apiHash",
          "sessionString": "sessionString",
          "proxy": {
            "ip": "proxy.example.com",
            "port": 1080,
            "socksType": 5,
            "username": "proxy-user",
            "password": "proxy-password",
            "timeout": 10
          },
          "allowFrom": [
            "*"
          ],
          "groups": {
            "*": {
              "enabled": true,
              "groupPolicy": "mention",
              "allowFrom": [
                "*"
              ]
            }
          }
        }
      }
    }
  }
}
```

### SOCKS4 example

SOCKS4 uses the same block with `socksType: 4`. SOCKS4 has no password authentication, so pass at most
`username`:

```json
"proxy": {
  "ip": "203.0.113.10",
  "port": 1081,
  "socksType": 4
}
```

### Proxy fields

| Field | Type | Default | Description |
|---|---|---|---|
| `ip` | string | required | Proxy hostname or IP address |
| `port` | number | required | Proxy TCP port, `1`–`65535` |
| `socksType` | `4` \| `5` | required | `5` for SOCKS5, `4` for SOCKS4 |
| `username` | string | unset | Optional — only for proxies that require authentication |
| `password` | string | unset | Optional — only for proxies that require authentication |
| `timeout` | number | `5` | Optional connection timeout **in seconds** (GramJS default is `5`) |

Notes:

- `timeout` is expressed in **seconds**, not milliseconds — GramJS multiplies it by 1000 internally.
- `username` and `password` are optional. Omit both for an open proxy; blank strings are ignored.
- The proxy is configured **per account**, so one account can use SOCKS5, another SOCKS4, and another
  can connect directly:

```json
"accounts": {
  "default": {
    "apiId": 12345678,
    "apiHash": "apiHash",
    "sessionString": "sessionString",
    "proxy": { "ip": "proxy.example.com", "port": 1080, "socksType": 5 }
  },
  "second": {
    "apiId": 12345678,
    "apiHash": "apiHash",
    "sessionString": "sessionString",
    "proxy": { "ip": "203.0.113.10", "port": 1081, "socksType": 4 }
  },
  "third": {
    "apiId": 12345678,
    "apiHash": "apiHash",
    "sessionString": "sessionString"
  }
}
```

- Omitting `proxy` keeps the previous behavior exactly — a direct connection.
- If `proxy` is present but invalid (bad port, bad `socksType`, empty host), the account fails to start
  with an explicit error instead of silently falling back to a direct connection that would expose the
  host's real IP address to Telegram.
- On a successful connection the log line reports only `proxy: "socks5"` / `"socks4"` — never the host,
  port, or credentials.
- `openclaw clawgram --auth` only updates `apiId`, `apiHash` and `sessionString`, so an existing
  `proxy` block survives re-authorization. If you decline the automatic config update, the printed JSON
  fragment is a fresh-account template — merge it into your account instead of replacing the block, or
  you will drop the `proxy` section.

> **WARNING**: `password`, `apiHash` and `sessionString` are credentials. Never commit them to a
> repository, paste them into issues, or share config files containing them. Anyone with your
> `sessionString` has full access to your Telegram account.


## Slash commands

OpenClaw provides a robust set of native commands. Just like in a regular Telegram bot, slash commands are also available for a user Telegram account connected via the Telegram userbot plugin. Send the slash command in DM to the connected account.

Use commands like `/status`, `/reset`, `/new` and others.

You can read more about slash commands in the [OpenClaw official documentation](https://docs.openclaw.ai/tools/slash-commands).



## Multi-Account

The plugin also supports adding multiple accounts. You can run the cli command many times

```bash
openclaw clawgram --auth
```


If the custom cli command hangs on your OpenClaw version, use the standalone command instead:

```bash
node ~/.openclaw/extensions/clawgram/dist/clawgram-cli.js --auth
```

And in the account ID step, enter a value other than the first [default] or your previously entered one.
account ID must be unique

```bash
Enter account id for config [default]: [2026-05-10T16:01:56.402] [INFO] - [connection closed]
[2026-05-10T16:02:02.096] [WARN] - [Disconnecting...]
[2026-05-10T16:02:02.103] [INFO] - [Disconnecting from x.x.x.x:80/TCPFull...]

second
```

```json
{
  "channels": {
    "clawgram": {
      "accounts": {
        "default": {
          "enabled": true,
          "apiId": 12345678,
          "apiHash": "apiHash",
          "sessionString": "sessionString",
          "allowFrom": [
            "*"
          ],
          "groups": {
            "*": {
              "enabled": true,
              "groupPolicy": "mention",
              "allowFrom": [
                "*"
              ]
            }
          }
        },
        "second": {
          "enabled": true,
          "apiId": 12345678,
          "apiHash": "apiHash",
          "sessionString": "sessionString",
          "allowFrom": [
            "*"
          ],
          "groups": {
            "*": {
              "enabled": true,
              "groupPolicy": "mention",
              "allowFrom": [
                "*"
              ]
            }
          }
        }
      }
    }
  }
}
```


## Multi-agent routing

The Clawgram channel can also be used alongside the regular Telegram channel for configuring OpenClaw multi-agent routing. In that case, accounts connected via the Clawgram channel will have independent agents.

Here is an example of how to configure OpenClaw multi-agent routing using clawgram channel in parallel with main telegram channel.

You can read more about how to set up multi-agent routing in the official [OpenClaw documentation](https://docs.openclaw.ai/concepts/multi-agent)

List model
```json
 "list": [
      {
        "id": "main",
        "default": true,
        "workspace": "/root/.openclaw/workspace"
      },
      {
        "id": "second",
        "workspace": "/root/.openclaw/workspace-second",
      },
      {
        "id": "userbot-main",
        "workspace": "/root/.openclaw/workspace-userbot-main",
      },
      {
        "id": "userbot-second",
        "workspace": "/root/.openclaw/workspace-userbot-second",
      }
    ]
```

Bindings
```json
"bindings": [
    {
      "agentId": "main",
      "match": {
        "channel": "telegram",
        "accountId": "default"
      }
    },
    {
      "agentId": "second",
      "match": {
        "channel": "telegram",
        "accountId": "second"
      }
    },
    {
      "agentId": "userbot-main",
      "match": {
        "channel": "clawgram",
        "accountId": "default"
      }
    },
    {
      "agentId": "userbot-second",
      "match": {
        "channel": "clawgram",
        "accountId": "second"
      }
    }
  ]
```


> **NOTES**: Due to a known bug in the OpenClaw core, you may encounter an error in the logs: `EmbeddedAttemptSessionTakeoverError: session file changed while embedded prompt lock was released`. This error may primarily occur when communicating in group chats and not on all LLM models — only those that support tool calls. This error does not affect functionality, but it may cause a repeated request to the fallback model and excess token usage if you have one specified. To prevent this behavior, you can remove the fallback model in the openclaw.json configuration. To avoid affecting your main settings, override the model specifically for the clawgram channel in the agent list when configuring multi-agent routing — do not specify a fallback model for it.

```json
 "list": [
      {
        "id": "userbot-main",
        "workspace": "/root/.openclaw/workspace-userbot-main",
        "model": {
          "primary": "<some model>"
        }
      },
      {
        "id": "userbot-second",
        "workspace": "/root/.openclaw/workspace-userbot-second",
        "model": {
          "primary": "<some model>"
        }
      }
    ]
```


## Security and privacy

This plugin holds credentials for a real Telegram account and handles private correspondence. What
that means in practice, and what the code does about it:

| Concern | Where it lives | What the plugin does |
| --- | --- | --- |
| `apiHash`, `sessionString` | `openclaw.json`, or a secret store | Written there by `--auth`. Never logged. Since 2.1.0 the session string is not printed after login either — only shown, behind an explicit warning, if you decline the automatic config write. Since 2.2.0 both accept a **SecretRef** instead of a literal, so the credential need not sit in the config file at all |
| Proxy password | `accounts.*.proxy.password`, or a secret store | Also accepts a SecretRef since 2.2.0. Marked `sensitive` in `uiHints`; diagnostics say `socks4`/`socks5` and nothing more. An invalid proxy fails the account rather than falling back to a direct connection, which would leak the host IP to Telegram |
| Message bodies | channel logs | **Not logged.** Outbound sends record recipient, ids and `textLength`. Until 2.1.0 the full outbound text was written to the channel log — if you ran 2.0.x, treat those journal entries as containing private correspondence |
| Read scope | `accounts.*.readChats` | History and membership reads are confined to the listed chats. Absent means no restriction; an empty array denies everything |
| Who may talk to it | `allowFrom`, `groups.*.groupPolicy` | Direct-message senders and group behaviour are allowlisted; `mention` limits group replies to explicit mentions |

Two static tests (`test/no-secret-logging.test.ts`) fail the build if a message body or a credential
is ever added back to a log call, or if the auth flow prints the session string unprompted.

### Keeping credentials out of the config file

`apiHash`, `sessionString`, `proxy.username` and `proxy.password` accept a
[SecretRef](https://docs.openclaw.ai/gateway/secrets) in place of a literal value:

```json
{
  "channels": {
    "clawgram": {
      "accounts": {
        "default": {
          "apiId": 12345678,
          "apiHash": { "source": "file", "provider": "corp", "id": "/telegram/api-hash" },
          "sessionString": { "source": "file", "provider": "corp", "id": "/telegram/session" }
        }
      }
    }
  }
}
```

References are resolved once per account at start-up. If one cannot be resolved the account fails to
start, naming the field but never the value — and the client refuses to be constructed while any
reference remains, so an unresolved secret can never travel to Telegram as a credential.

Found a security issue? Open an issue at
[github.com/d3pre5s/clawgram/issues](https://github.com/d3pre5s/clawgram/issues) — or, if it is
sensitive, contact the maintainer directly instead of filing publicly.

## Development

```bash
npm install          # install dependencies
npm run build        # run build script
npm test             # run the node:test suite (no Telegram connection required)
```

For local authorization testing during development, you can also run the standalone cli directly:

```bash
npm run clawgram-cli -- --auth
```

or

```bash
npm run clawgram-cli:auth
```

## Releases

Every push and pull request is built and tested on Node 22 and 24. Releases are cut by pushing a
`v<version>` tag: CI then builds from a clean checkout and publishes to npm with
[provenance](https://docs.npmjs.com/generating-provenance-statements), so each published tarball is
verifiably tied to the commit it was built from. The tag and `package.json` must agree or the job
refuses to publish.

Changes per version: [CHANGELOG.md](CHANGELOG.md).

## License

MIT
