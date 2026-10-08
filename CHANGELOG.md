# Changelog

All notable changes to rooster are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [SemVer](https://semver.org/). Container images are tagged `x.y.z`, `x.y` and `x`.

**Downgrades:** migrations are forward-only. To go back to an older version, restore the automatic pre-migration backup that the newer version wrote to `/data/backups/` before migrating (see [operations §7](docs/spec/08-operations.md#7-backups--restore)). Each release lists its migrations below.

## [Unreleased]

## [1.0.2] - 2026-10-09

### Fixed
- **"Syncing…" never cleared on phones** when the installed app and a Chrome tab were open at the same time: Android froze the background tab while it held the outbox, so edits in the app were never sent. A visible app now takes over sending after about 4 s; requests that get no answer time out after 20 s and are retried safely (ADR 0019).
- **Drag and drop:** the dragged row now stays exactly under the pointer or finger (it was drawn up to several hundred pixels too high, more when scrolled), the drop line follows auto-scroll, and dropping an item right before or after itself is no longer offered (ADR 0018).
- **Phone layout:** the bottom navigation and header stay put; the page itself can no longer scroll or bounce, including after pull-to-refresh (ADR 0020). The add button (FAB) no longer overlaps the bottom navigation and sits above toasts.

### Added
- **Update prompt:** besides the "New version available · Reload" toast, every header shows an "Update" chip until you reload; the app also checks for a new version when it comes back to the foreground, works without a service worker, and never reloads another tab while you're typing (ADR 0021).

### Migrations
- None.

## [1.0.1] - 2026-10-08

A security-hardening release after an audit of 1.0.0. No cross-org or cross-user data path was found; the changes below close weaker spots (ADR 0017).

### Upgrade notes
- **Everyone signs in once more** on https: the session cookie is now `__Host-rooster.session`.
- **Generic OIDC providers no longer link to existing accounts by email** unless they have `"trustEmail": true` in `ROOSTER_OIDC_PROVIDERS` (Google is always trusted). Only set it for providers where users cannot change their own email. See `docs/oidc-setup.md`.
- **New:** `ROOSTER_TRUSTED_PROXY_HOPS` (default 1). Your reverse proxy must not pass a client-supplied `X-Forwarded-For` on: Apache `RequestHeader unset X-Forwarded-For early`, nginx `$remote_addr` (08 §5, `docker/proxy/apache.conf`).
- The server refuses weak `ROOSTER_AUTH_SECRET` values (containing `change-me`, or fewer than 10 distinct characters) with exit code 78.
- Existing data files keep their permissions: run `chmod 700 data data/backups` and `chmod 600 data/*.db*` once on the host.

### Security
- Sign-in: account linking only from email-authority providers; single-use invites accepted atomically; `__Host-` cookies; weak secrets rejected.
- Requests: client IP from the right-most trusted proxy hop (the sign-in rate limit can no longer be dodged); body limits of 64 KB on `/api/auth` and 1 MB on `/api/v1`; the CSRF check is skipped only for token-authenticated clients.
- Realtime: at most 4 live-sync streams per session and 12 per user; a member's client id is no longer sent to other members.
- Data: stored request replays are forgotten when someone loses access to an org; filtered search is capped; expired sign-in state is purged; data files are created private (umask 0077).
- Logs: no invite tokens, search text or SQL parameter values.
- Web: sign-out also clears per-user local storage (palette recents); orgs you were removed from disappear from the cache, offline search and the outbox; queued edits are bound to their user; caches unconfirmed for 30 days are not restored; description links allow only http, https, mailto and relative URLs; source maps and the build manifest are no longer served.
- Supply chain: CI actions pinned to commit SHAs, base images pinned by digest, Dependabot for both.

### Migrations
- None.

## [1.0.0] - 2026-10-06

The first switch-over release: rooster is ready for daily use (D-18).

### Added
- **Sign-in and organisations** (Phase 1): Google and generic OIDC sign-in with an email allowlist, personal and shared orgs with members and invites, profile and behaviour settings, active sessions, and an admin area (users, allowlist, backups).
- **The list** (Phase 2): personal groups with an Inbox, inline task creation and editing that behaves like a text editor, natural-language due dates in English and Swedish, drag and drop (with keyboard alternatives), multi-select and bulk actions, undo and redo, completion with a hide delay, and nightly backups.
- **Detail pane** (Phase 3): Markdown descriptions, start dates, subtasks up to five levels deep, tags with colours and a tag filter, and duplicate.
- **PWA, offline and realtime** (Phase 4): an installable app that reads offline and queues edits in an outbox, live updates across tabs and devices over SSE, and phone and tablet layouts with swipe actions, a FAB and a bottom navigation.
- **Smart views** (Phase 5): Today, Next 7 days, Overdue and No date per org, with sidebar counts, a group chip on each row, and inline add that inherits the view's date (`>Group` picks the group).
- **Search and command palette** (Phase 5): Ctrl/Cmd+K (or `/`) searches titles and descriptions with prefix matching and `#tag`, `@person`, `due:` and `is:` filters, lists recent tasks, and runs any action, including "Make subtask of…". It works offline over cached tasks.
- **Data** (Phase 5): Settings → Data exports an org as JSON or Markdown, and lists the org's Trash with restore and permanent delete.
- `POST /api/v1/admin/search/reindex` rebuilds the search index. The server also rebuilds it at boot when it is out of step.
- A leaner first load: the editor, popovers, palette and sign-in client load on demand, and only the active language is downloaded (about 370 KB gzip of JavaScript for My tasks, checked in CI).
- The REST API v1 with OpenAPI docs at `/api/docs`.

### Migrations
- `0000_init` to `0003_subtasks_tags`: the initial schema (Phases 0–3).
- `0004_task_fts`: the full-text search table `task_fts` (FTS5), filled from existing tasks.

### Not included
- Move tasks over from another tool by pasting a multi-line list into a group.

[Unreleased]: https://github.com/201works/rooster/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/201works/rooster/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/201works/rooster/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/201works/rooster/releases/tag/v1.0.0
