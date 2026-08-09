# Changelog

Notable changes to clawgram. Format loosely follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [semver](https://semver.org/).

Releases are cut by pushing a `v<version>` tag — see the Publishing section in `CLAUDE.md`.
Versions from `0.1.0` to `1.0.2` predate the fork becoming a standalone product and are
recorded in `git log` only.

## [Unreleased]

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
