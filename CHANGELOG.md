# Changelog

All notable changes to rooster are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [SemVer](https://semver.org/). Container images are tagged `x.y.z`, `x.y` and `x`.

**Downgrades:** migrations are forward-only. To go back to an older version, restore the automatic pre-migration backup that the newer version wrote to `/data/backups/` before migrating (see [operations §7](docs/spec/08-operations.md#7-backups--restore)). Each release lists its migrations below.

## [Unreleased]

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

[Unreleased]: https://github.com/201works/rooster/compare/v1.0.0...HEAD
[1.0.0]: https://github.com/201works/rooster/releases/tag/v1.0.0
