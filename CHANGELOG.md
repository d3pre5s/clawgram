# Changelog

Notable changes to clawgram. Format loosely follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [semver](https://semver.org/).

Releases are cut by pushing a `v<version>` tag — see the Publishing section in `CLAUDE.md`.
Versions from `0.1.0` to `1.0.2` predate the fork becoming a standalone product and are
recorded in `git log` only.

## [Unreleased]

### Fixed

- **Inbound and outbound message bodies were written to the channel log.** The
  group mention gate logged the whole incoming message as a shorthand `text`
  property, the group deliver path logged `payloadText`, and the transcript
  fallback logged `fallbackText` — while `README.md` promised message bodies are
  not logged and a static test was supposed to enforce it. All three now record
  a length.

  The test missed them twice over. Its call-site pattern stopped at the second
  optional link, so `log?.info?.(` — the shape most of `channel.ts` uses — never
  matched: 42 of the file's 87 log calls were never examined. And it read only
  `key: value` pairs, so the shorthand `text,` was invisible even in the calls it
  did examine. It now matches both optional links, reads shorthand properties,
  and rejects any key ending in `text` unless it is a predicate (`hasText`), so
  a future rename cannot walk past it again.

## [2.20.1] — 2026-09-02

### Fixed

- **A plain reply reached the agent as a bare parent id.** Telegram does not
  put the parent's text into a reply; only a highlighted fragment
  (`quoteText`) travels with it, and most replies have none. The channel
  forwarded the highlight (2.4.0) and nothing else, while core renders
  `[Replying to: …]` from `ReplyToQuoteText` *or* `ReplyToBody` — so every
  reply without a highlight arrived as "reply to #1011" with nothing behind
  it. The case that exposed it (2026-09-02): the owner answered, in a DM, the
  agent's own notice about an unknown sender; the notice had been sent from
  another session and DMs are outside `readChats`, so the agent could not
  recover the text by any route and asked the owner what he meant.

  Both inbound sites now fetch the parent once (`getReplyMessage`, which the
  group path was already calling for the reply-to-self gate and discarding)
  and pass `ReplyToBody` and `ReplyToSender`. Core renders the body inline
  as `[Replying to: "…"]`; the sender label (the agent's own name for her
  own messages, otherwise display name, `@username`, then id) is passed for
  the consumers that read it, but the inline Telegram rendering in core
  2026.7.1 does not show it. A parent that cannot be fetched degrades to
  today's behaviour — no context — never to a dropped message. Highlights
  keep precedence in core, so quoted replies are unchanged.

## [2.20.0] — 2026-09-01

### Changed

- **Core's operational chatter no longer reaches group chats.** Three days in
  a row the owner's work group received the assistant's internal telemetry as
  ordinary messages: `⚠️ 🛠️ Bash failed: …` with a full shell command
  including secret-store paths (2026-08-30), a bare `⚠️ ✉️ Message failed`
  (08-31), `⚠️ 🛠️ Exec failed: …` appended after a perfectly good reply
  (08-31), plus `↪️ Model Fallback: …` notices during the auth outage. Each
  had a different root cause; the shared defect is that operator telemetry was
  delivered to an audience it was never for.

  `sendText` now classifies core's notices by their exact machine-built
  prefixes and drops them for group and channel targets, logging the class and
  length — never the text. DMs keep the telemetry: there the reader is the
  person running the agent. Detection is prefix-exact, so the assistant
  discussing a failure in its own words is untouched.

  Trade-off, stated plainly: a group turn that dies now dies silently for the
  room. The failure stays in the run diagnostics, the cron job's `lastError`
  and the gateway log — where the operator reads it — but the person who asked
  sees nothing rather than a broken-looking status line.

## [2.19.4] — 2026-08-31

### Fixed

- **The tool advertised actions the agent could not call, and one of them
  broke a live reply.** 2.19.3 gave `topics`, `dialogs`, `chatInfo` and
  `participants` names core knows, but kept offering the descriptive spellings
  beside them — and a hint even said clawgram "also answers to `chatInfo`".
  From the agent's `message` tool it does not: an action outside
  `CHANNEL_MESSAGE_ACTION_NAMES` is both "requires a target" and "does not
  accept a target", and no call satisfies both.

  On 2026-08-31 the `meeting-watch` job took the offer, called `chatInfo`, got
  both halves of the contradiction, and the turn ended as `✉️ Message failed`
  in the owner's chat.

  The tool now offers only names core can dispatch. The descriptive spellings
  still work in `handleAction`, so gateway RPC and existing skills are
  unaffected — RPC never consults the advertised list. Hints and capability
  lines name the callable spelling only.

### Added

- **Chat management is callable from the tool for the first time.**
  `createGroup`, `addMembers`, `promoteAdmin` and `demoteAdmin` had been
  advertised since 2.12.0 under names core does not know, so every attempt
  failed the same way; they now answer to `channel-create`, `addParticipant`,
  `role-add` and `role-remove`. `removeMember` already had `kick`.
  `transferOwnership`, `inviteLink` and `joins` have no counterpart in core's
  vocabulary and stay gateway-only rather than being offered as traps.

- A test that reads `CHANNEL_MESSAGE_ACTION_NAMES` out of the installed core
  and asserts every advertised action appears in it. The rule this repo kept
  relearning — advertised implies reachable — is now checked against core
  itself rather than a copy that can drift.

## [2.19.3] — 2026-08-30

### Fixed

- **`topics`, `dialogs`, `chatInfo` and `participants` were unreachable from the
  agent's `message` tool.** 2.19.2 tried to fix this by declaring `chatId`
  through `messageActionTargetAliases`, and that does nothing: core resolves a
  channel with `getBootstrapChannelPlugin`, which only ever returns a bundled
  channel, so a plugin channel's declaration is never read. What actually
  carried `fetch-media` through in 2.19.1 was its second name, `download-file`
  — a name core already has, mapped to target mode `"none"`.

  Each of the four now answers to a core name too: `thread-list` for `topics`,
  `channel-list` for `dialogs`, `channel-info` for `chatInfo`, `member-info` for
  `participants`. Measured on the live server on 2026-08-30 — `thread-list`
  reached `handleAction` from the same caller that `topics` could not.

  `joins` has no core equivalent and stays reachable only through the gateway
  RPC, which skips the target policy altogether. The native spellings keep
  working there too, so existing skills and cron prompts are unaffected.

## [2.19.2] — 2026-08-30

### Fixed

- **`topics` was unreachable from the agent tool, and so was every other
  chat-scoped action outside core's vocabulary.** 2.19.1 fixed this for
  `fetch-media` and stopped there. The same contradiction — "requires a target"
  without one, "does not accept a target" with one — still swallowed `topics`,
  `participants`, `chatInfo` and the chat-management actions, because core keys
  its target policy by `CHANNEL_MESSAGE_ACTION_NAMES` and none of those names
  are in it.

  Measured on the live server on 2026-08-30: the `bro-feedback-watch` cron job
  is built on `topics`, and the agent tried `target`, `chatId`, `groupId` and
  the `clawgram:`-prefixed form, got one half of the contradiction each time,
  and abandoned the run — every fifteen minutes.

  `messageActionTargetAliases` now declares `chatId` for every action whose
  handler already reads it, not just the two media ones, and a test asserts the
  list stays in step with the actions the tool advertises. `dialogs` and `joins`
  take no chat at all and remain unreachable: core gives a channel no way to
  declare an action targetless, so an unknown action always requires a target.

## [2.19.1] — 2026-08-24

### Fixed

- **`fetch-media` was unreachable from the agent tool.** 2.19.0 advertised the
  action and implemented it; core refused every call before it arrived. Core
  keys its target policy by its own action vocabulary, and an action outside
  that vocabulary is simultaneously "requires a target"
  (`MESSAGE_ACTION_TARGET_MODE[action] !== "none"` is true for `undefined`) and
  "does not accept a target" (the same lookup defaults to `"none"` when a
  target is passed). Measured on a live server on 2026-08-24: the agent tried
  `chatId`, `target`, `channelId` and every combination, and got `Action
  fetch-media requires a target.` without one and `Action fetch-media does not
  accept a target.` with one.

  Two changes, both needed. The action now also answers to `download-file` —
  core's own name for exactly this, mapped to target mode `"none"`, so the
  contradiction does not arise. And the channel declares `chatId` as the
  destination param for both names through `messageActionTargetAliases`, the
  hook core consults for actions it does not know, so a call that names the
  chat is no longer refused as targetless.

  The chat is named by `chatId`, never `target`: core throws on `target` for
  any action outside its vocabulary. The tool hint now says so.

## [2.19.0] — 2026-08-24

### Added

- **`fetch-media` — the attachment on a message, on demand.** Inbound
  attachments are read as they arrive and the bytes are then dropped; history
  reads report that a photo exists and fetch nothing. Two things fell between
  those: an image posted before the agent was addressed (in a chat it reads,
  by a policy that only wakes it on a mention, which is most work chats), and
  any reuse at all — the file the inbound path read is deleted the moment the
  reading ends, so an image could be described once and never forwarded,
  attached, or looked at again.

  The action takes a chat and a message id and returns what is attached:
  `mode: "read"` gives the reading and deletes the file (the inbound
  contract), `"file"` keeps the file and skips the model call, `"both"` — the
  default — returns the reading and the path from one download. Images are
  described and voice notes transcribed through the same
  `runtime.mediaUnderstanding` call the inbound path makes, now shared rather
  than duplicated, so an image read on arrival and the same image read on
  request cannot drift apart.

  Confined by `readChats`, like history and membership: a chat whose history
  the account may not read cannot become a source of bytes either. A fetch
  that yields nothing says which nothing it was — `message-not-found`,
  `no-media`, `unsupported-media`, `media-too-large` — because answering
  "could not fetch" to all four is how "she ignored the picture" starts. A
  reading that fails after a successful download still returns the path with
  `readError` beside it: the bytes are already here.

  Fetched files live in `clawgram-fetched/` under the system temp directory,
  named after the chat and message they came from, and are pruned after 24
  hours by the next fetch — nothing else would ever remove them. `read` mode
  downloads into a directory of its own instead: the shared name is keyed by
  chat and message, so deleting it would pull the file out from under an
  earlier `both` fetch that had already handed the path to the caller.

## [2.18.0] — 2026-08-17

### Added

- **`groupPolicy: "tag"`.** A third rung below `mention`: only an explicit
  `@username` or a reply wakes the agent, never the name it answers to. It
  exists for chats where the name is conversation rather than address —
  measured in the owner's 1041-person community chat over 15–17.08.2026,
  exactly one message tagged the account while the name itself turned up
  routinely. `mention` remains the default and anything unrecognised falls back
  to it: a typo must not silently change what a chat costs.

- **`accounts.<id>.reactionModel`.** The emoji pick on a silent mention is the
  only model call this channel makes on its own, and it ran on the agent's own
  head. It can now be pointed at a small model. Core refuses a plugin's model
  override unless `plugins.entries.clawgram.llm.allowModelOverride` is set, and
  the refusal is a throw this feature swallows — so a refused override retries
  on the default model and logs `modelFellBack`, rather than turning the
  reaction into silence nobody can explain.

### Fixed

- **The typing indicator no longer promises an answer that is not coming.**
  It is now shown only for messages that actually addressed the agent. Under
  `groupPolicy: "open"` every message starts a turn and most of them end in
  silence: on 2026-08-17 the owner's management chat watched «Тина печатает…»
  for 20–26 seconds on four consecutive messages that were never addressed to
  her, each followed by nothing. The read receipt is unchanged — reading is
  what she did, typing was a promise she did not owe. Chats on `mention` and
  `tag` are unaffected, since there a turn only starts when addressed.


## [2.17.1] — 2026-08-15

### Fixed

- **Every channel restart leaked a GramJS update loop.** `stop()` called
  `client.disconnect()`, which drops the connection but leaves the update loop
  running: GramJS spins it as `while (!client._destroyed)` and only `destroy()`
  sets that flag. Each leaked loop keeps retrying and printing `Error: TIMEOUT`
  for the lifetime of the process.

  The leak is older than this release, but it was nearly unreachable: a write
  under `channels.clawgram` used to restart the whole Gateway, which took the
  loops with it. 2.17.0 declared the prefix hot-reloadable, so a routine
  roster/allowlist write now restarts only the channel — and the leak became a
  per-write cost. Measured on a live server on 2026-08-15: zero timeouts on the
  two preceding days, ~3/min after two channel restarts, ~4.5/min after a third.
  `stop()` now calls `destroy()`; losing the event handlers it clears is
  correct, because the manager is discarded on stop.

## [2.17.0] — 2026-08-15

### Added

- **Per-group `tools`, `toolsBySender`, `skills` and `systemPrompt`.** A
  chat's scope could only be held by the agent's prompt: the config knew
  which groups the assistant answers in, not what it may do in each. The four
  keys are the bundled Telegram channel's group vocabulary and are opt-in — a
  group without them behaves exactly as before. `systemPrompt` reaches core as
  a trusted block, `skills` as the turn's skill allowlist (`[]` = no skills
  here), `tools`/`toolsBySender` are resolved by core through a new
  `groups.resolveToolPolicy` hook.

  The hook exists for one reason: core derives group ids from the session key
  and hands the channel the scoped peer id `<accountId>:<chatId>`, while
  `groups` is keyed by the bare chat id — without the translation the policy
  would look up `groups["default:-100…"]` and silently never apply. Under CLI
  backends the policy filters gateway tools (loopback MCP), not the backend's
  own exec/read/write; the README says so and shows the bindings recipe for a
  chat that must not have a shell.

### Changed

- **Config edits under `channels.clawgram` no longer restart the whole
  Gateway.** Core plans hot reloads from `plugin.reload.configPrefixes`; a
  changed path that matches no rule restarts the Gateway (SIGUSR1, all runs
  aborted). Measured on 2026-08-13 21:50:52 UTC: one write to
  `channels.clawgram.accounts.default.groups` did exactly that. The plugin
  now declares the prefix, so the same edit restarts only this channel.

## [2.16.1] — 2026-08-14

### Fixed

- **A person with more than one Telegram handle came back without any.**
  Telegram moved handles into a `usernames[]` array once an account could hold
  several — multiple handles, or a collectible one — and for such an account
  the legacy `username` field arrives EMPTY. Three places read that raw field:
  the participant list, `chatInfo`, and the inbound sender.

  The visible damage was in generated tables: the owner of one deployment
  appeared as "(без тэга)" beside a bare numeric id, in every chat, while
  everyone else carried a handle — 1 of 23, 1 of 9, 1 of 7, 1 of 3. The quiet
  damage is worse: an `allowFrom` entry written as `@handle` never matches such
  a person, and no error says so.

  All three now go through `resolveActiveUsername`, which prefers the plain
  field and otherwise takes the active entry out of `usernames[]`. The helper
  already existed and was used for exactly one thing — the account's own handle,
  so that mention detection would work.

## [2.16.0] — 2026-08-14

### Added

- **`dialogs` — which chats this account is actually in.** On 2026-08-13 the
  owner added the account to two chats a minute apart. The 7-person basic group
  was picked up; the 1039-member forum supergroup was not, and nothing anywhere
  recorded that the account had joined it. Every message from it was dropped as
  `skipping group not present in groups config` while the onboarding pipeline —
  join service message → journal → roster → allowlists — waited for a service
  message Telegram never sent, because large supergroups do not emit one.

  Membership is now answerable directly instead of being inferred from an event
  that may not arrive. The action reports id, title, type and `isForum` for
  group chats only: direct conversations are dropped before the caller sees the
  list, and no message content is read. It is the one read that deliberately
  reaches past `readChats` — its job is to find chats that are not in it yet —
  so it has its own switch, `discoverChats`, and stays off until an account
  sets it.

- **`topics` — a forum's topics by name.** `chatInfo` could say a chat *was* a
  forum and stop there. A topic id could only be lifted off an inbound message,
  so a topic nobody had posted in yet was unreachable, and one named in words
  ("the Визитка topic") could not be turned into an id at all. The action lists
  id, title, last message and the closed/hidden/pinned flags, with an optional
  `query` narrowing by title. Gated by `readChats`: a topic list describes what
  a chat is working on.

- **`participants` takes `filter: "admins"`** (also `admins: true`), asking
  Telegram with `ChannelParticipantsAdmins`. "Answer only the admins of this
  chat" is a standing rule, and a rule needs a list that can be re-read rather
  than one copied out by hand once.

### Fixed

- **`read` ignored the forum topic it was given.** `chatId:topic:N` was parsed
  off the target and a `threadId` parameter was accepted, then both were
  dropped before the query was built: every read of a forum returned the whole
  chat with all topics interleaved, which looks like a correct answer to the
  wrong question. The topic now reaches Telegram as `replyTo`, and `read`
  accepts it as `threadId` / `topicId` / `messageThreadId` beside the target.

## [2.15.0] — 2026-08-12

### Fixed

- **Markdown arrived as literal asterisks on html-mode accounts.** 2026-08-12
  00:13 UTC a 2167-character monthly report reached a work chat as
  `**Разбор работы…**`, markers showing on every line. The agent writes what
  language models write — markdown, or markdown mixed with the HTML links it
  is told to use — while GramJS's HTML parser converts tags only and ships
  the markdown through untouched. Its markdown mode is no way out: five
  delimiters, no links, so the HTML half would break instead.

  `parseMode: "html"` now renders the text before sending. Markdown becomes
  Telegram entities (`**b**`, `*i*`, `_i_`, `~~s~~`, `||spoiler||`, `` `code` ``,
  fenced blocks with language, `[text](url)`, `# headings` as bold lines,
  `> quotes` as blockquotes), hand-authored Telegram HTML passes through with
  its attributes intact — `<a href>` links keep working — structural HTML
  (`<ul>`, `<p>`, …) is dropped exactly as the parser already dropped it, and
  stray `<`, `>`, `&` are escaped so they reach the reader as text: a
  `<placeholder>` the old path swallowed whole now survives. Markdown inside
  code spans, fences and `<code>`/`<pre>` bodies is never converted.
  Conversion runs at the transport, so replies, core-delivered text, `send`
  actions and captions all render the same way.

- **"Plain text" was never plain.** An absent parse mode does not disable
  parsing in GramJS — it falls back to GramJS's *default markdown parser*,
  which has quietly eaten `**` and backticks out of "raw" sends since the
  fork began. The documented escape hatch (`parseMode: ""`) now resolves to
  the new explicit mode `"none"`, which really does deliver the text exactly
  as typed (`parseMode: false` at the GramJS boundary). An *unset* account
  mode keeps the historical GramJS default unchanged.

### Added

- **Captions render like messages.** `sendMedia` accepts `parseMode`; the
  outbound media path and the `upload-file` action resolve it exactly like
  text sends (per-call wins, account `replyParseMode` otherwise). Captions
  are the same agent prose — before this they always took GramJS's default
  markdown pass, a third rendering behavior nobody configured.

## [2.14.0] — 2026-08-10

### Fixed

- **A reply could greet whoever spoke last instead of whoever asked.** Live in
  a work chat: the owner asked at 15:33, a colleague asked something else at
  15:35, and the answer to the owner went out as `@colleague, готово` — the
  colleague read a result they had not asked for, while the owner's request
  looked ignored.

  The channel remembers a reply address per incoming message, but also kept a
  `__latest__` entry so that a send carrying no `replyToId` still greeted
  somebody. In an interleaved chat that "somebody" is the most recent sender.
  Recency is not an answer to "who am I replying to": the fallback is gone, and
  `message.action send` now resolves the address from `toolContext
  .currentMessageId` — the message the turn is actually answering. No message
  to answer, no greeting.

- **Every request was answered twice.** The agent replies by calling `send`,
  then returns text as well, and core delivers that text as a second message:
  `handleAction send` at 12:39:02, `outbound sendText` at 12:39:09 — the same
  answer in different words, twice in a row, for two different requests.

  Core's convention is that an agent which already sent a message answers
  `NO_REPLY`; this catches the turns that forget. A send into the chat the turn
  came from is now recorded, and core's delivery of that turn's final text is
  dropped as an echo. The window is 20 seconds — measured against the live
  7-second gap — so a result the assistant genuinely comes back with later is
  still delivered. The echo record is kept apart from the existing
  ten-minute duplicate guard: feeding one from the other would have quietly
  made that rule stricter.

## [2.13.1] — 2026-08-10

### Fixed

- **`dryRun` inside `params` was silently ignored, and the message went out
  for real.** Core passes the flag as a sibling of `params`; callers write it
  inside `params`, next to `to` and `text`, because that is where every other
  parameter lives. There it was read by nobody.

  This is the worst possible failure for a safety flag, and it has now put two
  irreversible messages into a work chat. 2026-08-08 (note 0066), and again
  2026-08-10 at 02:49 UTC, when a rehearsal posted a bare `ping` (id 2360).
  The agent immediately tried `message.action delete` — this channel has no
  delete action — and ended up apologising for it in its own report.

  Either position now counts, and a disagreement between them resolves toward
  **not** sending: a caller who wrote "dry run" anywhere meant it somewhere.
  The string `"true"` is accepted alongside the boolean, as elsewhere in the
  action parameters.

## [2.13.0] — 2026-08-10

### Changed

- **`send` now inherits the account's parse mode instead of defaulting to
  plain text.** The two send paths disagreed: replies used
  `accounts.*.replyParseMode`, while the `send` action took `parseMode` per
  call and fell back to plain when it was omitted. An account configured for
  `html` therefore rendered replies as HTML and tool-driven sends as raw
  markup.

  On 2026-08-09 at 22:30 UTC a long answer arrived in a work chat with
  `**Вне каталога — Telegram**` visible. Two sends half an hour earlier had
  passed `parseMode` by hand and looked right — which is the tell rather than
  the reassurance: correctness that depends on remembering a parameter on
  every call is correctness that will lapse.

  The per-call parameter still wins, and `parseMode: ""` still means "send it
  exactly as typed" — the escape hatch for text holding characters HTML would
  choke on. Only the default changed.

  A configured account is a **behaviour change for existing sends**: text that
  previously went out raw is now parsed. Set `parseMode: ""` on any call that
  must stay literal.

## [2.12.1] — 2026-08-09

### Fixed

- **The do-not-judge-people rule was swallowing the praise rule.** Live:
  "ладно, молодец тина" produced `chose: "none"`, and "самой умной в этой
  ситуации оказалась тина" produced 😁 rather than the `❤` 2.11.0 fixed for
  praise. Neither was a delivery failure — the mention was seen, the turn was
  silent, the reaction step ran, and the model declined on purpose.

  It was following the prompt exactly. The restraint clause read "answer NONE
  when the message … discusses a person's performance", and "молодец тина" is
  literally that. The carve-out the assistant has in its own rules — the ban on
  judging people protects *others*, not itself — was never repeated here.

  The clause is now scoped to someone *else's* work or behaviour, with the
  exemption spelled out, plus an explicit precedence line: when a fixed answer
  applies, it beats the mood rule.

## [2.12.0] — 2026-08-09

### Added

- **Chat management: the assistant can now assemble a team chat, not only
  speak in it.** Seven new message actions — `createGroup`, `addMembers`,
  `removeMember`, `promoteAdmin`, `demoteAdmin`, `transferOwnership`,
  `inviteLink` — all driven by the same personal MTProto account; Telegram's
  Bot API forbids most of this to bots, which is why the capability lives
  here. The trigger was live: asked to remove two people from a group, the
  assistant had to answer that reading, reacting and sending was all it could
  do there.

  Everything is opt-in behind the new `accounts.*.manageChats` scope, whose
  default is the exact opposite of `readChats`: absent or empty means manage
  *nothing*, `["*"]` means every chat. A non-empty list also unlocks
  `createGroup` — the chat being created is not in any list yet. `dryRun` is
  honoured everywhere, after the gate, so a dry run exercises the same
  refusals a real call would hit. People's ids stay out of the channel log;
  results carry them to the caller, the journal does not.

  The shape of each action follows what Telegram actually permits:

  - `createGroup` creates a supergroup (megagroup), because granular admin
    rights, bans and ownership transfer only exist there;
  - people whose privacy settings refuse a direct add come back in `missing`
    rather than failing the batch — `inviteLink` is the path for them;
  - `removeMember` kicks softly by default (ban, then lift, so the person can
    be re-invited); `ban: true` keeps the ban;
  - `promoteAdmin` grants a run-the-room default set; `addAdmins` and
    `anonymous` are escalation and impersonation, so each stays off unless
    set explicitly in `rights`;
  - `transferOwnership` exchanges the account's 2FA password for an SRP proof
    in-process — the password comes from the new `accounts.*.twoFaPassword`
    (literal or SecretRef, `sensitive` in uiHints, on the forbidden-log-keys
    list), never from action parameters. Telegram's own restrictions surface
    as errors: supergroups only, 2FA older than 7 days
    (`PASSWORD_TOO_FRESH_*`), session older than 24 h (`SESSION_TOO_FRESH_*`),
    new owner already an admin.

## [2.11.0] — 2026-08-09

### Changed

- **Three reactions are now fixed rather than left to the model's taste.**
  First working run reacted 👍 to "самая умная в этой ситуации оказалась
  тина" — defensible, and wrong: 👍 approves of the praise instead of being
  touched by it. The owner named the mapping:

  - praised, thanked, or spoken well of → `❤` (explicitly never 👍)
  - asked or told to do something → `🫡`, or `👌` for a small routine request
  - anything about producing something written → `✍`

  Everything else still follows the mood rule, and the NONE rule for
  conflictual or evaluative messages is unchanged and still wins.

  `❤` and `✍` are written as bare U+2764 and U+270D in the prompt, with a test
  asserting no U+FE0F crept in: the prompt is a second way to reintroduce the
  2.10.1 bug, since the model copies back what it is shown.

## [2.10.1] — 2026-08-09

### Fixed

- **The silent-mention reaction reached Telegram and was refused.** First live
  run, message 2228:

  ```
  clawgram silent-mention reaction         { messageId: 2228, appetite: 'extensive', chose: 'emoji' }
  clawgram silent-mention reaction failed  { error: 'RPCError: 400: REACTION_INVALID (caused by messages.SendReaction)' }
  ```

  Every step worked — mention seen, turn silent, emoji chosen — and the send
  failed. Reactions are not "any emoji": Telegram keeps a fixed set, and five
  of its members carry **no** variation selector (`❤` is U+2764 alone, likewise
  `⚡`, `✍`, `🕊`, `☃`). The parser preserved the U+FE0F models emit by habit,
  and a test even asserted it did — the wrong contract, verified.

  Now the answer is canonicalized (U+FE0F and skin-tone modifiers stripped) and
  matched against the reaction set; the set is also handed to the model up
  front, so it picks from what Telegram will take instead of being corrected
  afterwards.

- **Chats that restrict reactions are honoured.** `availableReactions` is read
  off the full chat: `ChatReactionsSome` narrows both the prompt and the
  validation, and `ChatReactionsNone` skips the step entirely without spending
  a model call. A failed lookup falls back to the full set — not knowing is not
  the same as being forbidden.

### Changed

- **The decision log carries the emoji and the size of the allowed set.** The
  body stays out, as always, but the reaction is our own act, and the first
  live failure could not be diagnosed from `chose: "emoji"` alone.

## [2.10.0] — 2026-08-09

### Added

- **The channel now reacts when the agent is addressed and says nothing.**
  Named in a group, nothing worth replying — an emoji goes on the message
  instead of silence. The emoji is picked per message by a small model call
  (`maxTokens: 8`), so it answers the mood rather than stamping a fixed ack.

  This is the fourth attempt at the feature and the first that does not go
  through the prompt. 2.8.0 added `reactionGuidance`, 2.9.0 moved the same text
  onto `messageToolHints`; instrumentation on both showed **zero invocations**
  across live turns while the assembled prompt stayed byte-identical at 44 266
  chars. Core resolves the channel for prompt assembly from
  `params.messageChannel ?? params.messageProvider`, which is empty on this
  path — so nothing this channel contributes to the prompt has ever reached the
  agent. Three rewrites of the workspace rule were arguing with a delivery
  failure.

  The decision now sits in code, at the one unambiguous moment: the turn was
  addressed to her and delivered nothing. Guardrails:

  - only when she was addressed — an `@`-mention or a reply to her own message,
    the same sense of "addressed" the turn itself was given;
  - `reactionLevel` still governs: `off`/`ack` react never, `minimal` is told to
    be sparing, `extensive` to be generous;
  - the model is told to answer `NONE` on conflictual or evaluative messages —
    an emoji on "Петя опять сорвал сроки" is a public verdict on a colleague;
  - anything that is not a bare emoji is discarded rather than sent hopefully;
  - every failure degrades to no reaction. The reply is already settled when
    this runs, so nothing here can break a turn.

  Groups only. A silent DM is a different problem and gets no reaction.

### Changed

- **The silent-reply branch now keys on her silence, not on the transcript.**
  It previously required a transcript entry that stripped to empty; a turn that
  wrote no entry at all fell through to a bare warning. Both are equally silent
  and are now handled together.

### Removed

- **`reactionGuidance`, and the reaction text on `messageToolHints`.** Both are
  dead weight: neither hook is called for this channel, proven by logging
  rather than inferred. `reactionLevel` keeps its meaning and now steers the
  code path above. A comment in `channel.ts` records why prompt text must not
  be re-added there.

## [2.9.0] — 2026-08-09

### Changed

- **Reaction guidance moved into `messageToolHints`, because core never asks
  for it.** 2.8.1 added a log line to the `reactionGuidance` hook. Across live
  turns it printed **nothing**, while the assembled prompt stayed byte-identical
  — so core was not calling the hook at all, and the earlier reasoning that the
  model simply declined to react had been resting on a hook that never ran.

  Both resolvers sit in the same core function, two lines apart:

  ```
  messageToolHints = runtimeChannel ? resolve(...) : undefined
  reactionGuidance = runtimeChannel && params.config ? resolve(...) : undefined
  ```

  The extra `params.config` is the only structural difference, and it lives in
  the minified `openclaw` dependency — not ours to change, and patching
  `node_modules` would vanish on the next update.

  So the guidance now rides the hints, which are guarded only by the channel
  resolving. The workaround does not depend on that diagnosis being right: if
  the hints reach the prompt, so does the text. Wording follows core's own, so
  nothing changes should core ever start calling the hook.

  `reactionGuidance` is kept as-is for that day. Both paths log, so "did our
  text reach the prompt" stays answerable from the log instead of by inference
  — which is what cost three rewrites of the workspace rule.

## [2.8.1] — 2026-08-09

### Changed

- **`reactionGuidance` logs when core calls it.** 2.8.0 shipped the hook, the
  server proved it returns `{level:"extensive"}` when invoked by hand, and the
  config validated — yet the assembled system prompt stayed byte-identical,
  with no `## Reactions` section. "The hook answers correctly" and "core asked
  it" are different questions, and nothing in the logs could tell them apart.

  One info line per invocation carrying the resolved account, the requested
  account and the configured level. Silence in the log now means core never
  called the hook, which is a different defect from the hook declining.

## [2.8.0] — 2026-08-09

### Added

- **The prompt now tells the agent that reacting exists.** Core has a whole
  reactions subsystem a channel opts into: it calls
  `agentPrompt.reactionGuidance`, and when a channel returns a level it injects
  a `## Reactions` section into the system prompt — "React ONLY when truly
  relevant" for `minimal`, "react whenever it feels natural" for `extensive`.

  clawgram never implemented the hook, so that section was absent entirely.
  The `react` action was advertised and available, and the agent used it the
  moment she was asked point blank in a DM — but never once on her own in a
  group, across every turn in the logs. Three rewrites of the owner's
  workspace rule failed against a prompt that otherwise never mentioned
  reactions at all.

  New account setting `reactionLevel`: `off` / `ack` / `minimal` /
  `extensive`, absent means `minimal`, an invalid value disables agent
  reactions rather than guessing. Levels and fallbacks mirror the bundled
  Telegram channel so the same config behaves the same way in both.

## [2.7.1] — 2026-08-08

### Fixed

- **A synthesized voice reply could never leave a group.** `outbound.sendMedia`
  is the path core uses to deliver TTS audio, and it passed the target to peer
  resolution with the `clawgram:` prefix still attached — `sendText`, two
  functions above, has always called `normalizeOutboundTarget`. The send threw,
  no `sendMedia completed` line ever followed, the dispatch counters stayed at
  zero, and the transcript fallback posted the reply as raw text instead.

  The same function also dropped `audioAsVoice`, core's own signal that the
  file is a voice note, so even a successful send would have produced a grey
  audio document.

  Direct messages never hit either defect: that path goes through the
  `upload-file` action, which normalizes the target and reads the flag. The
  bug needed a group — and a voice reply — to become visible.

- **TTS markup no longer reaches a human.** The transcript fallback rescues a
  reply that would otherwise vanish, and it does that by reading the
  assistant's raw text out of the session file. Core strips `[[tts:…]]` markup
  before a channel sees it, but only on the normal reply path — so the
  fallback shipped it verbatim, and a group chat received
  `@top1ceo, [[tts:text]]Привет, Вася! …[[/tts:text]]`.

  The fallback now strips directives the same way it already stripped the
  silent-reply token. `[[tts:text]]…[[/tts:text]]` is **unwrapped** rather than
  dropped: those are the words the agent meant to say, so a synthesis that did
  not happen degrades to readable text instead of to markup — or to nothing,
  which is what happened the first time this path misfired.

## [2.7.0] — 2026-08-08

### Added

- **Synthesized speech arrives as a voice message, not a file card.** The
  channel now advertises `capabilities.tts.voice.synthesisTarget: "voice-note"`.
  Core resolves that key through `resolveChannelTtsVoiceDelivery` and falls
  back to `"audio-file"` when it is absent — which is why TTS audio used to
  land as a grey document you had to download before you knew what it was.
  With the capability advertised, core marks such sends with `asVoice` (older
  callers send `audioAsVoice`); both are read, and the upload path passes
  `voiceNote` to GramJS, which builds `DocumentAttributeAudio(voice: true)`
  itself.

  `transcodesAudio` is deliberately **not** advertised: the plugin ships no
  ffmpeg and adds no dependencies, so core keeps producing Ogg/Opus — the only
  container Telegram renders as a voice bubble.

  `capabilities` is now annotated with core's own `ChannelCapabilities` type.
  The block is read by reaching into it by path, so a typo would not fail —
  it would silently resolve to a default. With the annotation it is a build
  error instead (verified: a bad `synthesisTarget` gives `TS2820`).

## [2.6.1] — 2026-08-07

### Fixed

- **A `send` carrying a file no longer drops it.** `openclaw message send
  --media photo.jpg` is a documented invocation and arrives as action `send`
  with the file among the params; the text path ignored those params, so the
  caption went out and the picture did not. Found immediately after 2.6.0 while
  verifying the new action live. A `send` with a file now takes the same route
  as `upload-file`; a `send` without one is untouched.

## [2.6.0] — 2026-08-07

### Added

- **Files can be sent, not just described.** `sendMedia` was implemented from
  the start, but the channel never advertised it: `describeMessageTool` listed
  every action except `upload-file`, so core had no way to hand the agent a
  file and the agent had no way to ask. It failed as a shrug rather than an
  error — asked to draw a cat, the agent generated the image, watched core
  resize it, and then answered "Вот кот 🐱" in plain text while the PNG sat on
  disk. `upload-file` is now advertised (with `sendAttachment` accepted as the
  legacy alias) and routed to `sendMedia`, and `mediaSourceParams` tells core
  which params carry the file so sandboxed paths are normalized. Caption
  handling matches `send`, including refusing to post the `NO_REPLY` sentinel —
  a sentinel caption drops the caption, never the file.

## [2.5.1] — 2026-08-07

### Fixed

- **Images are actually read now.** 2.5.0 fetched them and then failed with
  `Image understanding requires agentDir`: image models are called with the
  agent's own credentials, so the pipeline refuses to run without that path.
  Audio never needed it, which is why voice notes worked while pictures did
  not. The plugin now resolves the documented agent directory and checks it
  exists before use — a missing directory degrades to "attachment not read"
  instead of throwing.

## [2.5.0] — 2026-08-07

### Added

- **Voice notes and images arrive as readable messages.** A message whose whole
  content was an attachment used to be dropped as `skipping empty inbound
  text`: with no text there was nothing to hand the agent, so being sent a
  voice note looked exactly like the assistant being offline. Inbound voice,
  audio and images are now fetched and read through
  `runtime.mediaUnderstanding` — speech becomes a transcript, a picture becomes
  a description — and the result lands in the message body prefixed with
  `[голосовое]` or `[изображение]`, so the agent knows it is reading a
  machine's reading and not typed words.

  A caption is kept and the reading appended after it: "look at this" plus the
  picture is one thought, not two.

  Which backend does the reading stays out of this plugin — that is the
  installation's `tools.media.*` choice, local model or hosted, and it can
  change without touching the channel.

### Notes

- Attachments this channel does not read (documents, video, stickers) keep the
  old treatment: metadata only. "spec.pdf, 240 KB" already tells a reader what
  happened, and fetching every attachment would be a different feature with
  different costs. An image sent *as a file* is read anyway — only the
  envelope differs, the pixels are the message.
- Reads are capped at 25 MB and the cap is checked against the size Telegram
  reports, before any transfer.
- A failed read never drops the message. The turn proceeds without the
  attachment text, because saying "you sent something I could not read" beats
  silence, which is indistinguishable from being offline.

## [2.4.3] — 2026-08-06

### Fixed

- **Subagent announces and `--deliver` reach the chat.** Core's
  `resolveAgentDeliveryPlanWithSessionRoute` calls `outbound.resolveTarget`
  without await; an async hook hands it a Promise, `.ok` reads undefined and
  the error branch crashes on `error.message` — which is why every subagent
  completion announce into a group session gave up at the retry limit. The
  hook is now synchronous (peer resolution already happens in `sendText`)
  and a not-ok result carries an Error-like `error`, since core reads
  `error.message`. Await-based call sites are unaffected: awaiting a plain
  value is a no-op.

## [2.4.2] — 2026-08-06

### Fixed

- **`outbound.resolveTarget` can no longer take down the gateway.** Core's
  agent-delivery path (`--deliver`, subagent completion announces) calls it
  with `to: undefined` when a delivery has no explicit target and the
  session route yields none — and does not catch a rejection from the hook.
  The old code called `.trim()` through the target-kind helper and threw,
  which surfaced as an unhandled rejection and killed the whole gateway
  process (systemd restart, live case 2026-08-06 18:27 UTC: a research
  subagent died with it). The hook now never rejects: missing target,
  missing runtime and resolver failures all answer `{ ok: false, error }`,
  which is the contract core's own fallback path implements.

## [2.4.1] — 2026-08-06

### Fixed

- **The transcript fallback no longer echoes old replies.** It exists to
  salvage a reply that reached the transcript but not stdout; on a turn
  that aborted with zero output it instead salvaged the newest entry —
  by definition from an earlier turn — and re-sent an old answer to a new
  question. Live case: a turn tripped over a dead background workflow,
  aborted in 664ms, and the previous reply went out twice to two different
  questions. The fallback now takes the dispatch start time and refuses
  anything stamped earlier (or not stamped at all); a static test pins the
  call site to keep passing it.

## [2.4.0] — 2026-08-06

### Added

- **Highlighted replies reach the agent.** Telegram lets a reply point at a
  fragment of the message it answers; the fragment travels on
  `MessageReplyHeader.quoteText`, not in the reply text. clawgram never read
  it, so the gesture was invisible: the agent saw the reply and the parent
  id, and nothing about which line was being pointed at. Lifted into
  `NormalizedInbound.replyQuoteText` / `.replyIsQuote` and passed as
  `ReplyToQuoteText` / `ReplyToIsQuote` at both inbound sites; core already
  renders those as `[Replying to: "…"]` when the provider is telegram, so no
  format is invented here. History (`read`) carries `replyQuoteText` too —
  reconstructing a conversation from a window is exactly where a reply
  stripped of its highlight reads as an answer to the whole parent message.

  The flag is not trusted on its own: the text is the evidence, and blank
  text counts as no highlight. A static guard asserts that every site
  passing `ReplyToId` also passes the quote — the two sites (group and DM)
  are linked by nothing in the type system, and wiring one while forgetting
  the other would work in groups and silently do nothing in DMs.

## [2.3.3] — 2026-08-06

### Fixed

- **`replyParseMode` actually reaches the client.** 2.3.1 added the setting
  and 2.3.2 taught the schema to accept it, but `resolveAccount` builds the
  plugin config field by field and never copied it — so the setting
  validated, deployed, restarted and did nothing, twice. Now carried
  through, with a regression test on `resolveAccount` itself. **Rule for
  every future account setting: `src/` + manifest schema + `resolveAccount`
  + tests, in one commit.**

## [2.3.2] — 2026-08-06

### Fixed

- **`replyParseMode` is accepted by the manifest schema.** 2.3.1 taught the
  code to read the key, but the account schema kept
  `additionalProperties: false` without declaring it, so writing the
  documented setting made `openclaw config validate` fail on production and
  the change had to be rolled back. Same shape as the `readChats` gap before
  1.3.1 — now covered by tests that validate every value the code accepts.

## [2.3.1] — 2026-08-06

### Added

- **`replyParseMode` on the account** (`markdown` / `md` / `html`) — the
  format for replies. 2.3.0 added `parseMode` to the `send` action, but a
  reply to a mention goes through the reply pipeline, which has no
  per-call slot: markup in a reply reached the recipient as raw brackets.
  The value is validated when read, so a typo fails at start-up rather
  than shipping `<a href=…>` to a live human. Absent means plain text,
  exactly as before 2.3.1.

## [2.3.0] — 2026-08-06

### Added

- **`parseMode` on the `send` action** (`"markdown"` / `"md"` / `"html"`).
  The value is validated at the action boundary — an unknown mode fails
  loudly instead of delivering markup as literal text to a live human —
  and reaches GramJS as its `md`/`html` parse mode. Absent means plain
  text: every pre-2.3.0 caller behaves exactly as before. Requested by
  the owner so assistant digests can carry real links (`[title](url)`)
  instead of bare URLs.
- **ClawHub publishing runs in the release pipeline**, in the step after npm. It was manual, and
  ClawHub fell two versions behind because of it. The step skips itself when `CLAWHUB_TOKEN` is
  unset — npm still publishes — and skips again when ClawHub already carries the version, so
  re-running a release is harmless.
- **`npm run release:clawhub`** publishes to ClawHub from a local machine, for when the token is
  deliberately kept out of GitHub. Same guards as the CI step: refuses without a login or a tag,
  points at the commit npm was built from, no-ops when the version is already there.

## [2.2.2] — 2026-08-03

### Fixed

- **The plugin declared two different versions.** `openclaw.plugin.json` still said `2.1.0` while
  `package.json` said `2.2.1`; both 2.2.0 and 2.2.1 shipped that way. npm reads `package.json`, so
  the published package and the Gateway reported the right version and nothing looked wrong — only
  ClawHub's inspector flagged the drift, on publish. A test now ties the two declarations together,
  verified red-green.

## [2.2.1] — 2026-08-03

### Fixed

- **SecretRefs were rejected by the plugin's own config schema.** 2.2.0 shipped the resolver, the
  runtime guards and the documentation, but left `apiHash` and `sessionString` declared as
  `{"type": "string"}` in `openclaw.plugin.json` — so `openclaw config validate` refused a config
  that used a reference, and the feature could not be switched on at all. Found while applying it
  to a live Gateway, which is the wrong place to find it. All four credential fields
  (`apiHash`, `sessionString`, `proxy.username`, `proxy.password`) now accept a literal string or a
  `{ source, provider, id }` reference, matching how core models `SecretInput`. An incomplete
  reference, an unknown source and a non-string are still rejected — a typo must not be mistaken
  for a reference and silently blank a credential.

## [2.2.0] — 2026-08-03

Four capabilities the channel was missing, and two defects where it promised more than it did.

### Added

- **SecretRefs for credentials.** `apiHash`, `sessionString`, `proxy.username` and `proxy.password`
  accept `{ source, provider, id }` in place of a literal, resolved once per account at start-up.
  Previously these could only be plaintext in `openclaw.json` — including `sessionString`, a bearer
  credential for the entire Telegram account. An unresolvable reference fails the account and names
  the field, never the value, and the client refuses construction while any reference remains, so an
  unresolved secret cannot reach Telegram as `"[object Object]"`.
- **Chat metadata.** The `chatInfo` action (also `getChatInfo`, `chatMetadata`, `getChatMetadata`)
  reports what a chat is: title, type (direct/group/supergroup/channel), member count, description,
  whether it is a forum, the pinned message id, and — for direct chats — whether the other side is
  a bot. Gated by `readChats`, the same scope that gates reading history. Previously the assistant
  could read a chat but not name it, so a chat's identity had to come from a hand-maintained
  allowlist that goes stale as soon as someone renames it.
- **Attachments are visible when reading history.** `read` now reports a `media` field with the
  attachment kind (photo, video, voice, audio, document, sticker, poll, geo, contact, webpage),
  plus filename, MIME type, size and duration where Telegram provides them. Previously a message
  whose whole content was a screenshot arrived as empty text, indistinguishable from a message
  that said nothing. Metadata only — nothing is downloaded.
- **Emoji reactions.** The `react` action of the message tool adds or clears this account's
  reaction on a message, following the tool contract: an empty `emoji` clears, and `remove: true`
  clears but still requires a non-empty `emoji`. The chat and message are taken from tool context
  when not passed explicitly, so reacting in place needs no arguments beyond the emoji.

### Fixed

- **`NO_REPLY` could be posted as a message.** `message.action` is neither the inbound pipeline
  (which strips the silent token) nor a core-normalized reply payload (which core strips), so an
  explicit send carried whatever text it was given straight to Telegram. The SDK itself prompts
  agents to send a message and *then* answer `NO_REPLY`, leaving the two one slip apart. Both
  `message.action` and `outbound.sendText` now suppress a payload that is only the token, and the
  check runs before the reply-address prefix is applied — prefixing first leaves `"Name: "` in
  front of the token, which is not empty, and that is precisely how the token reached the inbound
  path once before. A token in the middle of a sentence is still content and still delivered.
- `capabilities.reactions` was `true` while nothing implemented reactions — the channel promised
  the Gateway a capability that failed when the agent used it. The flag and the action are now
  tied together by a test in both directions.

## [2.1.1] — 2026-08-03

**Never published.** The version existed to rehearse the new release pipeline, which it did; 2.2.0
superseded it before a tag was cut, so npm goes straight from 2.1.0 to 2.2.0. The plugin code was
identical to 2.1.0.

### Added

- GitHub Actions: `ci.yml` builds and tests every push and pull request on Node 22 and 24;
  `release.yml` publishes to npm from a `v*` tag, with provenance and a tag/`package.json`
  version check. Releases no longer depend on one laptop, and `workflow_dispatch` runs the
  same job as a rehearsal that stops at `npm publish --dry-run`.
- `prepublishOnly` runs build and tests, so a hand-run `npm publish` cannot ship a stale `dist/`.
- `CHANGELOG.md` (this file) and a Releases section in the README.

## [2.1.0] — 2026-08-03

Published to npm and ClawHub; rolled out to the server the same day.

### Fixed

- The channel logged the **full text of outgoing messages**. Only `textLength` is logged now.
- `--auth` printed the `sessionString` — an account bearer credential — to stdout unconditionally.
  It is shown only when the config is not written automatically, and then behind an explicit warning.
- README carried a realistic-looking session string example; replaced with a non-secret placeholder.

### Changed

- `compat` / `peerDependencies` raised to OpenClaw `>=2026.5.26`. Earlier releases carry published
  high-severity advisories, including restoration of revoked node-token permissions.

Both leaks are now covered by static tests (`test/no-secret-logging.test.ts`), each verified red-green.

## [2.0.1] — 2026-08-03

Never published — superseded by 2.1.0 the same day.

### Changed

- Build and test against the OpenClaw SDK version the server actually runs.

## [2.0.0] — 2026-08-02

### Changed

- **Breaking:** plugin id and channel renamed to `clawgram`. Config moves from
  `channels.telegram-userbot` to `channels.clawgram`; `message.action` calls must pass
  `channel: clawgram`.

## [1.5.0] — 2026-08-02

### Changed

- Package rebranded to `clawgram`.

## [1.4.0] — 2026-08-02

### Added

- Opt-in display names in `participants`, for linking Telegram identities to people.

## [1.3.1] — 2026-08-02

### Added

- Read-only `participants` and `joins` actions; `readChats` is honoured.

## [1.1.2] — 2026-08-01

### Fixed

- History reads failed on ids that GramJS carries as big-integer objects.

## [1.1.1] — 2026-08-01

### Fixed

- Silent-token handling on the reply path.

## [1.1.0] — 2026-08-01

### Added

- `read` action — history reading through the Gateway RPC.

## [1.0.2] — 2026-07-31

### Fixed

- The test build could emit no test files and still report green; it now fails loudly.

[Unreleased]: https://github.com/d3pre5s/clawgram/compare/v2.3.3...HEAD
[2.3.3]: https://github.com/d3pre5s/clawgram/compare/v2.3.2...v2.3.3
[2.3.2]: https://github.com/d3pre5s/clawgram/compare/v2.3.1...v2.3.2
[2.3.1]: https://github.com/d3pre5s/clawgram/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/d3pre5s/clawgram/compare/v2.2.2...v2.3.0
[2.2.2]: https://github.com/d3pre5s/clawgram/compare/v2.2.1...v2.2.2
[2.2.1]: https://github.com/d3pre5s/clawgram/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/d3pre5s/clawgram/compare/v2.1.0...v2.2.0
[2.1.1]: https://github.com/d3pre5s/clawgram/commit/c954256
[2.1.0]: https://github.com/d3pre5s/clawgram/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/d3pre5s/clawgram/releases/tag/v2.0.0
