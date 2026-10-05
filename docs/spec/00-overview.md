# Rooster: Overview & Decision Log

> **Rooster** is a self-hosted, keyboard-first personal task manager for a daily "My tasks" list. It supports separate organisations (for example private and business), light collaboration, an installable mobile PWA, a CLI with a TUI, and an MCP server.

Spec version: 1.0 (2026-10-04). Status: **approved for implementation**.

## Spec documents

| # | Document | Purpose |
|---|---|---|
| 00 | [Overview & decisions](00-overview.md) | Vision, scope, glossary and binding decisions (this file) |
| 01 | [Product requirements](01-product.md) | Functional requirements, numbered `FR-*` |
| 02 | [UX & interaction spec](02-ux-interaction.md) | Exact behaviour of list editing, keyboard, drag and drop, dates, detail pane and mobile |
| 03 | [Design system](03-design-system.md) | Tokens, typography, components and layouts. **Binding for all UI work** |
| 04 | [Architecture](04-architecture.md) | Stack, monorepo, runtime, auth, offline/sync, realtime and security |
| 05 | [Data model](05-data-model.md) | SQLite schema and invariants |
| 06 | [API](06-api.md) | REST API v1 contract |
| 07 | [CLI, TUI & MCP](07-cli.md) | Command-line client spec |
| 08 | [Operations](08-operations.md) | Docker, configuration, backups and upgrades |
| 09 | [Implementation phases](09-phases.md) | Phased plan with acceptance criteria |
| 10 | [Quality & testing](10-quality.md) | Test strategy, Definition of Done, a11y and performance budgets |

Precedence when documents disagree: **00 > 05 > 06 > 02 > 03 > others**. An implementation that finds a contradiction must flag it in the PR description and follow the higher-precedence document.

## Vision

A list that behaves like a text editor. You open rooster in the morning and see **Today** at the top. You type a task, press Enter, and type the next one. Typing `fri` sets the due date. You drag a task from *Prio* into *Today*. Everything happens inline with no modal dialogs. A side pane opens only when you want to write a description, add subtasks or comment.

## Goals

1. Be a complete tool for a daily "My tasks" list.
2. Use user-defined task groups with exact, user-controlled order, rearranged by drag and drop and by keyboard.
3. Create and edit everything inline. The only secondary surface is the side detail pane, which is a full-screen sheet on mobile.
4. Keep private and business tasks strictly separated in **organisations**. Each org is a section of the left sidebar on desktop, and is chosen with an org switcher on mobile.
5. Sign in with OIDC (Google plus any standards-compliant issuer).
6. Offer three first-class clients: the desktop web app, an installable mobile PWA with offline reads and queued writes, and a CLI with a TUI and an MCP server.
7. Run as one Docker container with one volume and minimal administration.

## Non-goals (explicitly out of scope)

- Kanban boards, timelines, Gantt charts, portfolios, goals and workload views.
- Projects as multi-homed task containers. Org-wide lists are limited to the "Everyone's tasks" overview.
- Custom fields, forms, automation rules engines, dependencies and time tracking.
- Native iOS or Android apps. The PWA is the mobile app.
- Horizontal scaling or multi-node deployment. A single node with SQLite is the explicit design point.
- Dark theme in v1. Tokens are structured so that a dark theme can be added later without touching components.

## Glossary

| Term | Meaning |
|---|---|
| **Instance** | One deployed rooster container with its `/data` volume. |
| **Instance admin** | A user whose email is listed in `ROOSTER_ADMIN_EMAILS`. Manages the allowlist, users and backups. |
| **Organisation (org)** | A container of tasks and members, shown as a section in the sidebar. Every task belongs to exactly one org. |
| **Personal org** | An org created automatically for every user. It always has exactly one member and cannot be shared. |
| **Member** | A user in an org, with the role `owner` or `member`. |
| **My tasks** | The per-user, per-org list of tasks assigned to that user, arranged in that user's groups. |
| **Group** | A user-defined named section in *My tasks*, such as "Today", "Prio" or "Upcoming". Groups are **personal**: each user has their own groups per org, with their own order. |
| **Inbox** | A special system group per user and org. It receives tasks that arrive without a chosen group, for example when assigned by someone else, or created via the CLI without `--group`. It is pinned at the top and hidden when empty. |
| **Placement** | The fact that a task appears in a given user's My tasks at a given group and position. |
| **Smart view** | A virtual, read-only filtered view, such as *Overdue*, *Today*, *Next 7 days* or *No date*. It does not change groups. |
| **Everyone's tasks** | An org-wide overview of all open tasks, grouped by assignee. |
| **Detail pane** | The right-hand side panel showing one task in full. On mobile it is a full-screen sheet. |
| **Outbox** | A client-side queue of mutations that have not yet been confirmed by the server. |

## Decision log (binding)

These decisions come from the product requirements and from technical research. Change one only by adding a new decision that supersedes it.

### Product

| ID | Decision |
|---|---|
| D-01 | **Users:** multi-user instance with shared orgs. Not designed as open SaaS: access is controlled by an allowlist plus invites. |
| D-02 | **Groups are personal**, per user per org. Two members of an org each have their own groups and order. A task appears in **its assignee's** My tasks. |
| D-03 | **Visibility:** every member of an org can see all tasks in that org. The personal org is visible only to its owner. There are no per-task privacy flags in v1. |
| D-04 | **Collaboration:** single assignee, comments with @mentions, followers, an in-app notification inbox and an "Everyone's tasks" org overview. |
| D-05 | **Subtasks** are full tasks with their own assignee, dates, description, comments and subtasks. In the list they can be **expanded inline under the parent**. A subtask assigned to me whose parent is *not* assigned to me also appears as its own row with a parent breadcrumb. |
| D-06 | **Task fields:** title, description (Markdown), due date, optional due time, optional start date, recurrence, tags, attachments, assignee, subtasks, comments and followers. |
| D-07 | **Incoming tasks** land in the **Inbox** group, which is pinned at the top and hidden when empty. |
| D-08 | **No automation rules.** Groups are purely manual. Date-based **smart views** cover date triage. |
| D-09 | **Completion:** the task is checked, stays visible for about 1.5 s, then fades out. An undo toast is shown and Ctrl/Cmd+Z also undoes. A "Show completed" toggle reveals completed tasks in place. |
| D-10 | **Notification channels:** in-app inbox, Web Push (VAPID) and email (SMTP, optional, with a daily digest). |
| D-11 | **Access:** allowlist of emails and domains plus invites. Any allowed user can create orgs. Instance admins are configured by env var. |
| D-12 | **Roles:** `owner` and `member` only. |
| D-13 | **Personal org** is created automatically on first login. It cannot be shared, renamed to look shared, or deleted. |
| D-14 | **Recurring tasks:** when completed, the next instance is created **in the same group, directly after the completed instance**. |
| D-15 | **Natural-language dates** are parsed in the title and in the date picker, in English and Swedish. Recognised phrases are highlighted; clicking one reverts it to literal text. |
| D-16 | **Keyboard:** Common task-manager shortcuts (Enter, Shift+Enter, Ctrl/Cmd+Enter, Ctrl/Cmd+↑↓, Tab+letter) **plus** single-key shortcuts when no text field is focused, and a Ctrl/Cmd+K command palette. |
| D-17 | **Extras in scope:** full-text search with a command palette, a private iCal feed, and a public REST API with OpenAPI docs. An import from other task managers is on the backlog (09 §Backlog). |
| D-18 | **First switch-over release (v1.0)** contains: login, personal and business orgs in the sidebar, groups, inline tasks, drag and drop, due dates, the detail pane with description, subtasks and tags, the offline-capable PWA, smart views, search with the command palette, export and Trash. Collaboration, notifications, CLI, recurrence, attachments and iCal follow in later phases. |

### Design

| ID | Decision |
|---|---|
| D-20 | **Visual direction:** calm and airy. Generous 40 px rows, cool neutral greys and a single accent colour. |
| D-21 | **Accent:** rooster coral-red. Because the accent is red, **overdue** dates use a distinct danger crimson **plus** a non-colour cue (see 03-design-system §Due-date semantics). |
| D-22 | **Light theme only** in v1. All colours are tokens, so dark can be added later. |
| D-23 | **Languages:** English and Swedish from day one. No hard-coded UI strings. |
| D-24 | **Dates:** per-user week start, date format, time format and timezone, with defaults taken from the browser locale. |
| D-25 | **Tags** are shown as small coloured chips after the title in the row, and are truncated on mobile. |
| D-26 | **Mobile:** swipe actions, a bottom navigation bar with a floating add button, long-press drag, and the detail pane as a full-screen sheet. |
| D-27 | **Desktop layout:** a collapsible **left sidebar** (248 px, collapsing to a 56 px icon rail) lists each org as a section with its views (My tasks, smart views, Everyone's tasks). This supersedes the "orgs as tabs" idea from the initial brief. On mobile, orgs are switched with an org switcher in the header. |
| D-28 | **Typeface:** **Geist Sans** for UI and **Geist Mono** for IDs, code and shortcut hints, self-hosted as variable fonts (SIL OFL). Dates and counts use tabular numerals. |
| D-29 | **Detail pane on desktop pushes the layout into a split:** the list narrows and the pane sits beside it (520 px by default, resizable from 400 to 720 px). ↑/↓ in the list keeps working, and the pane follows the selection. |
| D-29a | **List width:** list content is fluid with a **maximum width of 1040 px**, centred in the main area when the pane is closed. With the pane open, the list fills the remaining space (minimum 480 px; below that, the pane overlays the list instead). |

### Technical

| ID | Decision |
|---|---|
| D-30 | **TypeScript end-to-end** in a pnpm monorepo: server, web, CLI and shared packages. |
| D-31 | **SQLite** in a Docker volume (WAL mode), through Drizzle ORM and better-sqlite3. No Postgres support. |
| D-32 | **Offline:** offline reads plus queued writes (outbox). Conflicts are resolved by per-field last-write-wins using client edit timestamps. No CRDT and no full local-first replica. |
| D-33 | **Auth:** better-auth with Google, generic OIDC, the device authorization grant (CLI), bearer and API keys (PATs). Organisations are rooster-owned tables, not the better-auth organization plugin (ADR 0002). |
| D-34 | **Realtime:** Server-Sent Events that carry *invalidation* messages. Clients refetch. |
| D-35 | **Ordering:** fractional-index string keys. The **server is authoritative** and computes keys from `before`/`after` neighbour intents. |
| D-36 | **IDs:** UUIDv7 strings, generated client-side for creates so that offline creation works. |
| D-37 | **Attachments:** local volume by default, with an optional S3-compatible backend set by env. The default limit is 25 MB per file and is configurable. |
| D-38 | **Hosting:** a single container exposes HTTP on port 3000. TLS and the domain are handled by the operator's existing reverse proxy. An example `compose.yaml` and example proxy snippets are shipped. |
| D-39 | **Spec delivery:** Markdown in `docs/spec/`, with `AGENTS.md` at the repo root. |

## Open questions (non-blocking; defaults apply)

| ID | Question | Default until decided |
|---|---|---|
| Q-01 | A cross-org "All" tab, for a Today view across private and business tasks? | Not built. Revisit after v1.0. |
| Q-02 | Per-task private flag inside business orgs? | Not built (D-03). |
| Q-03 | Dark theme? | Not built (D-22). Tokens are ready. |
