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
- **Attachments on demand** — fetch the photo or voice note on any message in read scope, as a reading, a file, or both (`fetch-media` action)
- **Chat management** — create supergroups, add/remove members, promote/demote admins, transfer ownership, export invite links (`createGroup`, `addMembers`, `removeMember`, `promoteAdmin`, `demoteAdmin`, `transferOwnership`, `inviteLink`) — off until `manageChats` allows it
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
Please enter your apiHash: EXAMPLE0123456789abcdef01234567
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

One restart after installation is enough. From 2.17.0 the plugin declares
`channels.clawgram` as a hot-reloadable prefix, so later edits under it —
`allowFrom`, `groups`, `readChats`, proxy — are picked up by the Gateway's
config watcher and restart only this channel (a few seconds of MTProto
reconnect), not the whole Gateway.


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
| `allowFrom` | string[] | `["*"]` | Allowed sender IDs/usernames for direct messages only. Three states: absent means everyone, `[]` denies everyone (a warning is logged at account start), a list allows those senders |
| `groups` | object | `{}` | Allowed groups map keyed by explicit group id or `*` |
| `proxy` | object | unset | Optional SOCKS4/SOCKS5 proxy for this account — see [Proxy (SOCKS4/SOCKS5)](#proxy-socks4socks5) |
| `manageChats` | string[] | unset | Chats the assistant may **manage** — see [Chat management](#chat-management). Absent or empty = management off; `["*"]` = every chat |
| `replyParseMode` | `"html"` \| `"markdown"` \| `"none"` | unset | Outbound format for replies, core-delivered text, captions and `send` calls that omit `parseMode` — see [Message formatting](#message-formatting) |
| `twoFaPassword` | string \| SecretRef | unset | The account's Telegram 2FA password; read only by `transferOwnership` |
| `reactionModel` | string | unset | Model ref or alias for the emoji pick on a silent mention. Unset = the agent's own model. Needs `plugins.entries.clawgram.llm.allowModelOverride: true` in the gateway config; without it the override is refused and the pick quietly falls back to the default model |

Group config fields:

| Field | Type | Default | Description |
|---|---|---|---|
| `enabled` | boolean | `true` | Enables or disables replies in the group |
| `groupPolicy` | `"open"` \| `"mention"` \| `"tag"` | `"mention"` | What wakes the agent here — see [What wakes the agent in a group](#what-wakes-the-agent-in-a-group) |
| `allowFrom` | string[] | `["*"]` | Allowed sender IDs/usernames inside that group. `[]` denies everyone, same as the account-level key |
| `tools` | object | unset | `{ allow?, alsoAllow?, deny? }` — tool policy for this group; see [Per-group tools, skills and system prompt](#per-group-tools-skills-and-system-prompt) |
| `toolsBySender` | object | unset | Per-sender tool policy inside this group, keys `id:<id>`, `username:<handle>`, `name:<display>` or `*` |
| `skills` | string[] | unset | Skill allowlist for this group; `[]` = no skills here, unset = the agent's skills |
| `systemPrompt` | string | unset | Trusted prompt block appended for messages from this group |

### What wakes the agent in a group

`groupPolicy` decides which messages start a turn at all. It is a ladder, widest
first, and the rung is chosen per group:

| Rung | Wakes on | Use it when |
|---|---|---|
| `open` | every message in the chat | the agent works as a member of the team and an address may carry no name at all |
| `mention` | the name it answers to, an `@username`, or a reply to it | the default: the agent is a participant, not a fixture |
| `tag` | an `@username` or a reply to it — **never the name** | the name occurs in conversation constantly, as it does in a large community |

Two things are worth knowing before reaching for `open`:

- it spends a **full turn on every message**, chatter included. Whether words
  are owed is then the agent's decision, and most of the time the answer is no;
- the typing indicator is shown only for messages that actually addressed the
  agent. Under `open` the room would otherwise watch it "type" through
  conversations it is merely reading, with nothing following.

Emoji reactions are unaffected by the rung: the channel leaves one only where
the agent was genuinely addressed, so background reading stays unmarked.

### Per-group tools, skills and system prompt

Since 2.17.0 a group entry can narrow what the assistant does *in that chat*
without touching the agent as a whole. The keys mirror the bundled Telegram
channel's group config, and `*` works as the default group for them too.

```json
"groups": {
  "-1001234567890": {
    "groupPolicy": "mention",
    "systemPrompt": "This chat is project BRO. Other projects are out of scope here.",
    "skills": ["pm-standup", "pm-jira"],
    "tools": { "deny": ["browser", "cron"] },
    "toolsBySender": { "id:123456789": { "alsoAllow": ["cron"] } }
  }
}
```

| Key | Effect |
|---|---|
| `systemPrompt` | Appended to the system prompt as a trusted block for turns from this group — the place to say what the chat is about and what stays out of it. |
| `skills` | Skill allowlist for turns from this group. Omit to inherit the agent's skills; `[]` means no skills in this chat. |
| `tools` / `toolsBySender` | Tool policy resolved by OpenClaw core for this group (`toolsBySender` wins for a matching sender). Keys use core's typed grammar: `id:`, `username:`, `name:`, `channel:clawgram:<id>` or `*`. |

**Limits — read before relying on `tools`.** The policy governs OpenClaw's
gateway tools (`message`, `sessions_*`, `cron`, `memory_*`, …). Under CLI
backends such as `claude-cli` those reach the model through the loopback MCP
tool list and are filtered per group; the backend's own native tools —
`exec`, `read`, `write`, `edit`, `apply_patch`, `process` — are governed by
the agent's exec policy, not by the group. If a chat must not have a shell at
all, bind it to a separate agent without one; the routing is core's, and the
peer id carries the account prefix this channel uses:

```json
"agents": {
  "list": [
    { "id": "main", "default": true, "workspace": "~/.openclaw/workspace" },
    {
      "id": "without-hands",
      "workspace": "~/.openclaw/workspace-without-hands",
      "model": "anthropic/claude-sonnet-5",
      "tools": {
        "deny": ["exec", "read", "write", "edit", "apply_patch", "process", "browser", "cron"],
        "message": { "actions": { "allow": ["send"] }, "crossContext": { "allowWithinProvider": false } }
      }
    }
  ]
},
"bindings": [
  { "agentId": "without-hands", "match": { "channel": "clawgram", "peer": { "kind": "group", "id": "default:-1001234567890" } } }
]
```

Nothing above changes for a group that does not set these keys.

### Message formatting

`replyParseMode` sets the outbound format for every path that does not name
one explicitly: replies, core-delivered text, media captions, and `send`
actions without a `parseMode` parameter. A per-call `parseMode` still wins.

| Mode | Behavior |
|---|---|
| `"html"` | **Recommended for agents.** The text is rendered before sending (2.15.0): markdown (`**bold**`, `*italic*`, `` `code` ``, ``` fences, `[text](url)`, `# headings`, `> quotes`, `~~strike~~`, `\|\|spoiler\|\|`) becomes Telegram entities, hand-written Telegram HTML (`<b>`, `<a href>`, `<code>`, …) passes through, structural HTML (`<ul>`, `<p>`, …) is dropped, and stray `<`, `>`, `&` arrive as literal text instead of vanishing into a failed tag. Markdown inside code is never converted. |
| `"markdown"` | GramJS's own markdown parser: `**`, `__`, `~~`, `` ` ``, ``` ``` ``` only — no links, no single-asterisk emphasis. |
| `"none"` | No parsing at all: the text is delivered exactly as typed. |
| unset | GramJS's historical default, which is its markdown parser — **not** plain text. Set `"none"` if you want plain. |

Agent-authored messages mix markdown and HTML freely, so `"html"` is the mode
that renders both. There is no reliable way to prompt a model out of writing
markdown; rendering it is the deterministic fix.

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


## Chat management

Since 2.12.0 the assistant can assemble a chat, not only speak in it: create a supergroup, add and
remove members, promote and demote admins, hand the chat to a new owner, and issue invite links.
This exists because the plugin drives a personal MTProto account — Telegram's Bot API forbids most
of these to bots (a bot cannot create a group, cannot add an unwilling member, and cannot transfer
ownership at all).

**Off by default.** Every action below is gated by `accounts.*.manageChats`, and the default is the
exact opposite of `readChats`: absent or empty means *manage nothing*, a list of chat ids confines
management to those chats, `["*"]` allows every chat. A non-empty list also unlocks `createGroup`
(the chat being created is not in any list yet). All actions honour `dryRun`, and the gate is
checked before the dry-run answer, so a dry run exercises the same refusals a real call would hit.

| Action | Parameters | Notes |
|---|---|---|
| `createGroup` | `title`, `about?`, `users?` | Creates a **supergroup** (megagroup) — granular admin rights, bans and ownership transfer only exist there. Initial members are invited right after creation; who could not be added is returned in `missing` |
| `addMembers` | `chatId`, `users` | Adds to supergroups in one call, to basic groups one by one. Ids Telegram refused (privacy settings) come back in `missing` instead of failing the call |
| `removeMember` | `chatId`, `user`, `ban?` | Soft kick by default — the person may be re-invited later. `ban: true` keeps them out until unbanned |
| `promoteAdmin` | `chatId`, `user`, `rank?`, `rights?` | Grants a deliberate default set (change info, delete messages, ban, invite, pin, calls, topics). `addAdmins` and `anonymous` stay **off** unless explicitly set in `rights` |
| `demoteAdmin` | `chatId`, `user` | Strips every admin right |
| `transferOwnership` | `chatId`, `user` | Supergroups only. Requires `twoFaPassword` (below); Telegram's own rules surface as errors — see the fine print |
| `inviteLink` | `chatId`, `expireDate?`, `usageLimit?`, `title?`, `requestNeeded?` | The path for people whose privacy settings refuse a direct add. `expireDate` takes unix seconds or an ISO date |

User references in `users`/`user` are `@username` or a numeric Telegram id. A `@username` always
resolves; a bare numeric id only when the account has already seen the user (shared chat, dialog,
recent contact) — Telegram refuses to look up strangers by id.

**Ownership transfer fine print.** Telegram guards `transferOwnership` with an SRP proof of the
account's two-step-verification password, so the password has to be available to the runtime:
`accounts.*.twoFaPassword`, either a literal or a [SecretRef](#keeping-credentials-out-of-the-config-file).
It is read only by this action, exchanged for the SRP proof in-process, and never travels through
action parameters or logs. Telegram additionally refuses the transfer when 2FA was enabled less
than 7 days ago (`PASSWORD_TOO_FRESH_*`), when the session is younger than 24 hours
(`SESSION_TOO_FRESH_*`), or when the new owner is not yet an admin of the chat — promote them
first. These errors are surfaced as-is rather than retried.

```json
{
  "channels": {
    "clawgram": {
      "accounts": {
        "default": {
          "manageChats": [ "-1001234567890" ],
          "twoFaPassword": { "source": "file", "provider": "corp", "id": "/telegram/2fa-password" }
        }
      }
    }
  }
}
```

## Fetching attachments

Inbound attachments are read as they arrive: a photo or a voice note sent while the agent is being
addressed becomes text in the message body, and the bytes are dropped. History reads (`read`) carry
attachment *metadata* — kind, file name, size, duration — and fetch nothing. That leaves two things
out: an image posted in a chat before the agent was addressed, and any reuse of an image at all,
because the file the inbound path read is deleted the moment the reading ends.

`fetch-media` covers both. It takes one message and returns what is attached to it. The action
also answers to **`download-file`**, core's own name for it — see the note on naming below.

| Parameter | Aliases | Notes |
|---|---|---|
| `chatId` | `chat` | The chat: `@username`, numeric id, `me`. **Not `target`** — core reserves that for actions in its own vocabulary and refuses it here |
| `messageId` | `id`, `message`, `msgId` | The id `read` reported for the message |
| `mode` | — | `both` (default), `read`, `file` |

Modes differ in what happens to the bytes:

- **`read`** — the attachment is turned into text (an image described, a voice note transcribed) and
  the file is deleted, exactly the inbound contract. No path is returned.
- **`file`** — the file is kept and its path returned, and no understanding model is called. This is
  what forwarding through `upload-file` or attaching to a ticket needs.
- **`both`** — the default: the reading *and* the path, from a single download.

The action is confined by `readChats`, the same scope that gates history and membership: a chat the
account may not read history from cannot be a source of bytes either. The action name also answers
to `fetchMedia`, `download-media`, `downloadMedia` and `getMedia`.

**On the two names.** Core keys its target policy by its own action vocabulary
(`CHANNEL_MESSAGE_ACTION_NAMES`), and an action outside it is treated as both *requiring* a target
and *not accepting* one — the same lookup returns `undefined` for the first check and defaults to
`"none"` for the second. A caller then gets `Action fetch-media requires a target.` without a
target and `Action fetch-media does not accept a target.` with one, whatever it tries.
`download-file` is in that vocabulary and maps to `"none"`, so the contradiction does not arise;
`fetch-media` is made usable by declaring `chatId` as its destination param
(`messageActionTargetAliases`). Both names run the same code.

What comes back is `ok: true` with `media` (the same metadata `read` reports), `understanding`
(`description` or `transcript`), and `text` and/or `filePath` per the mode. A fetch that yields
nothing is not an error — it says which nothing it was:

| `error` | Meaning |
|---|---|
| `message-not-found` | No such message, or it was deleted |
| `no-media` | The message is text only |
| `unsupported-media` | An attachment this channel does not read — video, a spreadsheet, a sticker |
| `media-too-large` | Over the 25 MB inbound cap. Telegram reports no size for a compressed photo, so this is a document limit in practice |

A reading that fails while the download succeeded still returns `ok: true`, with `readError` beside
the path: the bytes are already there and can still be forwarded.

**Fetched files live in the system temp directory** (`clawgram-fetched/`), named after the chat and
message they came from, and are pruned after 24 hours by the next fetch. Nothing else removes them,
and nothing sends them anywhere — putting a fetched file in a chat is an ordinary `upload-file`,
with whatever confirmation the deployment requires for that.

## Security and privacy

This plugin holds credentials for a real Telegram account and handles private correspondence. What
that means in practice, and what the code does about it:

| Concern | Where it lives | What the plugin does |
| --- | --- | --- |
| `apiHash`, `sessionString` | `openclaw.json`, or a secret store | Written there by `--auth`. Never logged. Since 2.1.0 the session string is not printed after login either — only shown, behind an explicit warning, if you decline the automatic config write. Since 2.2.0 both accept a **SecretRef** instead of a literal, so the credential need not sit in the config file at all |
| Proxy password | `accounts.*.proxy.password`, or a secret store | Also accepts a SecretRef since 2.2.0. Marked `sensitive` in `uiHints`; diagnostics say `socks4`/`socks5` and nothing more. An invalid proxy fails the account rather than falling back to a direct connection, which would leak the host IP to Telegram |
| Message bodies | channel logs | **Not logged.** Outbound sends record recipient, ids and `textLength`. Until 2.1.0 the full outbound text was written to the channel log — if you ran 2.0.x, treat those journal entries as containing private correspondence |
| Read scope | `accounts.*.readChats` | History, membership and attachment fetches are confined to the listed chats. Absent means no restriction; an empty array denies everything. Telegram's own service chat (`777000`, where login codes arrive) is refused unconditionally, including under a wildcard |
| Manage scope | `accounts.*.manageChats` | Creating groups, changing membership, admin rights, ownership and invite links are confined to the listed chats — and **off entirely** when the key is absent or empty (opposite default to `readChats`, because these actions change chats rather than read them) |
| 2FA password | `accounts.*.twoFaPassword`, or a secret store | Read only by `transferOwnership`, exchanged for an SRP proof in-process. Accepts a SecretRef since 2.12.0; `sensitive` in `uiHints`; on the forbidden-log-keys list the static tests enforce |
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
