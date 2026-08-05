# Changelog

Notable changes to clawgram. Format loosely follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [semver](https://semver.org/).

Releases are cut by pushing a `v<version>` tag — see the Publishing section in `CLAUDE.md`.
Versions from `0.1.0` to `1.0.2` predate the fork becoming a standalone product and are
recorded in `git log` only.

## [Unreleased]

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

[Unreleased]: https://github.com/d3pre5s/clawgram/compare/v2.3.2...HEAD
[2.3.2]: https://github.com/d3pre5s/clawgram/compare/v2.3.1...v2.3.2
[2.3.1]: https://github.com/d3pre5s/clawgram/compare/v2.3.0...v2.3.1
[2.3.0]: https://github.com/d3pre5s/clawgram/compare/v2.2.2...v2.3.0
[2.2.2]: https://github.com/d3pre5s/clawgram/compare/v2.2.1...v2.2.2
[2.2.1]: https://github.com/d3pre5s/clawgram/compare/v2.2.0...v2.2.1
[2.2.0]: https://github.com/d3pre5s/clawgram/compare/v2.1.0...v2.2.0
[2.1.1]: https://github.com/d3pre5s/clawgram/commit/c954256
[2.1.0]: https://github.com/d3pre5s/clawgram/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/d3pre5s/clawgram/releases/tag/v2.0.0
