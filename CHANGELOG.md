# Changelog

Notable changes to clawgram. Format loosely follows [Keep a Changelog](https://keepachangelog.com/);
versions follow [semver](https://semver.org/).

Releases are cut by pushing a `v<version>` tag — see the Publishing section in `CLAUDE.md`.
Versions from `0.1.0` to `1.0.2` predate the fork becoming a standalone product and are
recorded in `git log` only.

## [Unreleased]

### Added

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

- `capabilities.reactions` was `true` while nothing implemented reactions — the channel promised
  the Gateway a capability that failed when the agent used it. The flag and the action are now
  tied together by a test in both directions.

## [2.1.1] — 2026-08-03

No runtime changes — the plugin code is identical to 2.1.0. This release exists to exercise
the new automated release path end to end.

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

[Unreleased]: https://github.com/d3pre5s/clawgram/compare/v2.1.1...HEAD
[2.1.1]: https://github.com/d3pre5s/clawgram/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/d3pre5s/clawgram/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/d3pre5s/clawgram/releases/tag/v2.0.0
