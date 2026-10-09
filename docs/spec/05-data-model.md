# 05: Data Model (SQLite)

Conventions:
- **Rooster's own tables are `STRICT`**, with `foreign_keys=ON`.
  - drizzle-kit does not emit `STRICT`, so a small post-generate script (`pnpm db:generate` runs it) appends `STRICT` to `CREATE TABLE` statements for rooster tables. This counts as a generated migration.
  - The better-auth tables follow the adapter's generated types and timestamp conventions, and are not STRICT.
  - The FTS5 virtual table is created in a hand-written migration. Hand-written migrations are allowed for FTS, triggers and pragmas.
- IDs are `TEXT` UUIDv7 (D-36), validated with the regex `^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`.
- Timestamps are `INTEGER` ms since the epoch (UTC). Booleans are `INTEGER` 0/1.
- Calendar dates are `TEXT 'YYYY-MM-DD'` and times are `TEXT 'HH:MM'`.
- Drizzle schema files live in `apps/server/src/db/schema/*.ts`. Migrations are generated with `drizzle-kit generate`, committed under `apps/server/src/db/migrations/`, applied at boot, and **never edited after merge**.

The DDL below is normative for columns, constraints and indexes. Drizzle must produce equivalent SQL.

## 1. Pragmas (every connection, at open)

```sql
PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;
PRAGMA temp_store = MEMORY;
PRAGMA cache_size = -20000;
```

- Write transactions use `BEGIN IMMEDIATE`.
- There is a single connection for writes. Read concurrency is fine with WAL and the same connection, because better-sqlite3 is synchronous and Node is single-threaded.

## 2. better-auth tables (and rooster-owned org tables)

> Per ADR 0002, `organization`, `member` and `invitation` are **rooster-owned** tables managed only by `OrgService`. The better-auth organization plugin is not used. They are listed here because their shape follows the better-auth conventions.

The better-auth CLI generates these through the Drizzle adapter, and they are kept in `schema/auth.ts`. They are listed here with **rooster's additional fields**.

| Table | Purpose | Additional fields (better-auth `additionalFields`) |
|---|---|---|
| `user` | id, name, email, emailVerified, image, createdAt, updatedAt | `locale TEXT NOT NULL DEFAULT 'en'` (en/sv) · `timezone TEXT NOT NULL DEFAULT 'UTC'` · `week_start INTEGER NOT NULL DEFAULT 1` (0=Sun, 1=Mon) · `date_format TEXT NOT NULL DEFAULT 'MMM d'` (or `d MMM`) · `time_format TEXT NOT NULL DEFAULT '24h'` · `prefs TEXT NOT NULL DEFAULT '{}'` (JSON: parseTitleDates, completeHideMs, swipeLeft, swipeRight, reminderTime, digestTime) · `disabled_at INTEGER` |
| `session` | token, userId, expiresAt, ipAddress, userAgent, `activeOrganizationId` | — |
| `account` | provider links (providerId, accountId, tokens) | — |
| `verification` | — | — |
| `organization` | id, name, slug (unique), logo, metadata, createdAt | `is_personal INTEGER NOT NULL DEFAULT 0` · `avatar_emoji TEXT` · `color TEXT` (tag palette name) · `task_seq INTEGER NOT NULL DEFAULT 0` · `deleted_at INTEGER` |
| `member` | id, organizationId, userId, role (`owner`, `member`), createdAt | — |
| `invitation` | id, organizationId, email, role, status, expiresAt, inviterId (**email invites only**) | — |
| `apikey` | PATs (hashed key, prefix, name, expiresAt, metadata JSON `{scopes}`) | — |
| `deviceCode` | device authorisation grants | — |

Invariant: an org with `is_personal = 1` has exactly one `member` row (role `owner`). This is enforced in `OrgService` and checked by a test.

**Slugs:**
- `organization.slug` is unique instance-wide. Pattern: `^[a-z0-9][a-z0-9-]{1,38}$`.
- A personal org gets the slug `personal-<last 8 hex chars of userId>` (the first 8 encode the UUIDv7 timestamp; ADR 0003).
- The reserved alias **`personal`** is accepted everywhere a slug is accepted (web URLs `/o/personal/...`, the API `orgId`/slug lookups, CLI `--org personal`, refs like `personal#42`). It resolves to the **caller's** personal org. No org may be created with the slug `personal`.
- API paths take an org **ID or slug** in `:orgId`.

## 3. Rooster tables

```sql
-- Sidebar order and per-org UI prefs for a user
CREATE TABLE org_member_pref (
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  org_id       TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  position     TEXT NOT NULL,                 -- fractional key: sidebar order
  collapsed    INTEGER NOT NULL DEFAULT 0,    -- sidebar section collapsed
  PRIMARY KEY (user_id, org_id)
) STRICT;

-- Personal groups (sections) in My tasks
CREATE TABLE task_group (
  id           TEXT PRIMARY KEY,
  org_id       TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'normal' CHECK (kind IN ('inbox','normal')),
  name         TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 80),
  position     TEXT NOT NULL,                 -- ignored for inbox (always first)
  collapsed    INTEGER NOT NULL DEFAULT 0,
  field_clock  TEXT NOT NULL DEFAULT '{}',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  deleted_at   INTEGER
) STRICT;
CREATE INDEX task_group_owner ON task_group(user_id, org_id, position) WHERE deleted_at IS NULL;
CREATE UNIQUE INDEX task_group_one_inbox ON task_group(user_id, org_id) WHERE kind = 'inbox';

CREATE TABLE task (
  id               TEXT PRIMARY KEY,
  org_id           TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  seq              INTEGER,                   -- org-scoped human number (#42), assigned on server insert
  parent_id        TEXT REFERENCES task(id) ON DELETE CASCADE,
  subtask_position TEXT,                      -- fractional key among siblings (NULL for top-level)
  title            TEXT NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  description      TEXT NOT NULL DEFAULT '',  -- Markdown
  assignee_id      TEXT REFERENCES user(id) ON DELETE SET NULL,
  created_by       TEXT NOT NULL REFERENCES user(id),
  due_date         TEXT,                      -- 'YYYY-MM-DD'
  due_time         TEXT,                      -- 'HH:MM' (requires due_date)
  due_tz           TEXT,                      -- IANA, set when due_time is set
  start_date       TEXT,                      -- <= due_date
  recurrence       TEXT,                      -- RRULE subset (P10), requires due_date
  recurrence_basis TEXT CHECK (recurrence_basis IN ('due','completion')),
  series_id        TEXT,                      -- shared by all instances of a recurring series
  completed_at     INTEGER,
  completed_by     TEXT REFERENCES user(id),
  field_clock      TEXT NOT NULL DEFAULT '{}',
  created_at       INTEGER NOT NULL,
  updated_at       INTEGER NOT NULL,
  deleted_at       INTEGER,
  deleted_by       TEXT REFERENCES user(id),
  CHECK (due_time IS NULL OR due_date IS NOT NULL),
  CHECK (start_date IS NULL OR due_date IS NULL OR start_date <= due_date),
  CHECK ((parent_id IS NULL) = (subtask_position IS NULL))
) STRICT;
CREATE UNIQUE INDEX task_org_seq ON task(org_id, seq);
CREATE INDEX task_parent ON task(parent_id, subtask_position) WHERE deleted_at IS NULL;
CREATE INDEX task_assignee ON task(org_id, assignee_id, completed_at) WHERE deleted_at IS NULL;
CREATE INDEX task_due ON task(org_id, due_date) WHERE deleted_at IS NULL AND completed_at IS NULL;
CREATE INDEX task_trash ON task(org_id, deleted_at) WHERE deleted_at IS NOT NULL;

-- Where a task sits in its assignee's My tasks
CREATE TABLE placement (
  task_id      TEXT PRIMARY KEY REFERENCES task(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  org_id       TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  group_id     TEXT NOT NULL REFERENCES task_group(id),
  position     TEXT NOT NULL,
  updated_at   INTEGER NOT NULL
) STRICT;
CREATE INDEX placement_list ON placement(user_id, org_id, group_id, position);

-- Per-user expanded parents in the list
CREATE TABLE task_expansion (
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  PRIMARY KEY (user_id, task_id)
) STRICT;

CREATE TABLE tag (
  id         TEXT PRIMARY KEY,
  org_id     TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (length(name) BETWEEN 1 AND 40),
  color      TEXT NOT NULL,                    -- tag palette name (03 §2.4)
  created_at INTEGER NOT NULL
) STRICT;
CREATE UNIQUE INDEX tag_org_name ON tag(org_id, name COLLATE NOCASE);

CREATE TABLE task_tag (
  task_id  TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  tag_id   TEXT NOT NULL REFERENCES tag(id) ON DELETE CASCADE,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (task_id, tag_id)
) STRICT;
CREATE INDEX task_tag_tag ON task_tag(tag_id);

-- P6: collaboration
CREATE TABLE comment (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  author_id  TEXT NOT NULL REFERENCES user(id),
  body       TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 20000), -- Markdown-light, mentions as @[Name](user:<id>)
  created_at INTEGER NOT NULL,
  edited_at  INTEGER,
  deleted_at INTEGER
) STRICT;
CREATE INDEX comment_task ON comment(task_id, created_at);

CREATE TABLE activity (
  id         TEXT PRIMARY KEY,
  task_id    TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  org_id     TEXT NOT NULL,
  actor_id   TEXT REFERENCES user(id),
  type       TEXT NOT NULL,   -- created|renamed|due_changed|assigned|completed|reopened|description_edited|subtask_added|attachment_added|moved_parent|restored
  data       TEXT NOT NULL DEFAULT '{}',   -- type-specific payload; always includes "via" (web|pwa|cli|tui|mcp|import|system)
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX activity_task ON activity(task_id, created_at);

CREATE TABLE follower (
  task_id TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  muted   INTEGER NOT NULL DEFAULT 0,   -- explicit unfollow keeps a muted row so auto-follow doesn't re-add
  PRIMARY KEY (task_id, user_id)
) STRICT;

CREATE TABLE notification (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  org_id     TEXT NOT NULL,
  type       TEXT NOT NULL,   -- assigned|comment|mention|completed|due_changed|invite_accepted
  task_id    TEXT REFERENCES task(id) ON DELETE CASCADE,
  actor_id   TEXT REFERENCES user(id),
  data       TEXT NOT NULL DEFAULT '{}',
  read_at    INTEGER,
  emailed_at INTEGER,
  pushed_at  INTEGER,
  created_at INTEGER NOT NULL
) STRICT;
CREATE INDEX notification_inbox ON notification(user_id, read_at, created_at DESC);

-- P7
CREATE TABLE notification_pref (
  user_id  TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  type     TEXT NOT NULL,          -- notification type or 'digest' | 'due_reminder'
  channel  TEXT NOT NULL CHECK (channel IN ('inapp','push','email')),
  enabled  INTEGER NOT NULL,
  PRIMARY KEY (user_id, type, channel)
) STRICT;

CREATE TABLE push_subscription (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  endpoint   TEXT NOT NULL UNIQUE,
  p256dh     TEXT NOT NULL,
  auth       TEXT NOT NULL,
  user_agent TEXT,
  created_at INTEGER NOT NULL,
  last_ok_at INTEGER
) STRICT;

-- P10
CREATE TABLE attachment (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES task(id) ON DELETE CASCADE,
  org_id      TEXT NOT NULL,
  uploader_id TEXT NOT NULL REFERENCES user(id),
  filename    TEXT NOT NULL,
  mime        TEXT NOT NULL,
  size        INTEGER NOT NULL,
  storage     TEXT NOT NULL CHECK (storage IN ('local','s3')),
  key         TEXT NOT NULL,
  thumb_key   TEXT,
  width       INTEGER,
  height      INTEGER,
  created_at  INTEGER NOT NULL,
  deleted_at  INTEGER
) STRICT;
CREATE INDEX attachment_task ON attachment(task_id) WHERE deleted_at IS NULL;

CREATE TABLE ical_feed (
  id          TEXT PRIMARY KEY,
  user_id     TEXT NOT NULL REFERENCES user(id) ON DELETE CASCADE,
  org_id      TEXT REFERENCES organization(id) ON DELETE CASCADE,  -- NULL = all orgs
  token_hash  TEXT NOT NULL UNIQUE,
  created_at  INTEGER NOT NULL,
  last_used_at INTEGER
) STRICT;

-- Sync / infra
CREATE TABLE idempotency (
  op_id       TEXT NOT NULL,
  user_id     TEXT NOT NULL,
  status      INTEGER NOT NULL,
  response    TEXT NOT NULL,           -- full JSON response body (never truncated; bodies are small)
  created_at  INTEGER NOT NULL,
  PRIMARY KEY (op_id, user_id)
) STRICT;

-- Link invites (not tied to an email; better-auth's invitation.email is NOT NULL)
CREATE TABLE invite_link (
  id          TEXT PRIMARY KEY,
  org_id      TEXT NOT NULL REFERENCES organization(id) ON DELETE CASCADE,
  token_hash  TEXT NOT NULL UNIQUE,
  role        TEXT NOT NULL CHECK (role IN ('owner','member')),
  multi_use   INTEGER NOT NULL DEFAULT 0,
  uses        INTEGER NOT NULL DEFAULT 0,
  created_by  TEXT NOT NULL REFERENCES user(id),
  expires_at  INTEGER NOT NULL,
  revoked_at  INTEGER,
  created_at  INTEGER NOT NULL
) STRICT;

CREATE TABLE allowlist_entry (
  id         TEXT PRIMARY KEY,
  kind       TEXT NOT NULL CHECK (kind IN ('email','domain')),
  value      TEXT NOT NULL COLLATE NOCASE UNIQUE,
  created_by TEXT REFERENCES user(id),
  created_at INTEGER NOT NULL
) STRICT;

CREATE TABLE instance_setting (
  key   TEXT PRIMARY KEY,                 -- e.g. 'vapid_public', 'vapid_private', 'instance_id', 'last_boot_version'
  value TEXT NOT NULL
) STRICT;

CREATE TABLE job_run (
  job        TEXT NOT NULL,
  scope      TEXT NOT NULL,               -- e.g. userId|YYYY-MM-DD
  ran_at     INTEGER NOT NULL,
  PRIMARY KEY (job, scope)
) STRICT;

-- Full-text search. A self-contained FTS table keyed by task_id (UNINDEXED).
-- We deliberately do NOT map to task.rowid: VACUUM may renumber rowids of tables
-- without an INTEGER PRIMARY KEY.
CREATE VIRTUAL TABLE task_fts USING fts5(
  task_id UNINDEXED, org_id UNINDEXED,
  title, description, comments,
  tokenize='unicode61 remove_diacritics 2', prefix='2 3 4'
);
-- Maintained by SearchService inside the same transaction as task and comment writes
-- (delete + insert the task's row). This is simpler to test than SQL triggers.
-- `rooster admin reindex` (and boot, if the row counts mismatch) rebuilds it.
```

## 4. Invariants (enforced in services and covered by tests)

### 4.1 Placement invariant (the heart of My tasks)

A task `t` has a placement **iff** all of the following hold:
- `t.assignee_id IS NOT NULL`, and
- `t.parent_id IS NULL`, **or** `parent.assignee_id IS DISTINCT FROM t.assignee_id` (an "orphan subtask": it shows as its own row with a breadcrumb).

**Soft deletion does not remove a placement.** A soft-deleted task keeps its placement, so that undo, restore and Trash restore return it to its exact group and position. Placements are removed only by a hard delete (the purge, or a permanent delete). Every list query filters `task.deleted_at IS NULL`. If a soft-deleted task's group has been hard-deleted in the meantime, a restore puts the task at the top of the Inbox.

When it exists:
- `placement.user_id = t.assignee_id`
- `placement.org_id = t.org_id`
- `placement.group_id` references a non-deleted group owned by that user in that org.

`PlacementService.reconcilePlacements(taskIds)` runs inside **every** transaction that changes `assignee_id` or `parent_id` of a task **or of its parent**. It reconciles the task plus its direct children, because placement depends only on the parent's assignee. Deletion does not trigger it (see above). It behaves as follows:
- **Needs a placement, has none:** insert one in the assignee's **Inbox**, at the **top**. There are two exceptions:
  1. When the actor *is* the assignee and supplied a target group or position, use that.
  2. A **recurring next instance** is placed directly after the completed instance's placement (same user, same group), whoever completed it (D-14, FR-REC-3).
- **Has a placement, shouldn't:** delete it.
- **Assignee changed:** delete the placement and insert a new one in the new assignee's Inbox, at the top.

Completion **keeps** the placement, so that undo and "show completed" restore the exact position.

### 4.2 Groups
- Exactly one `kind='inbox'` group exists per `(user, org)` membership. It is created with the membership.
- At least one non-Inbox group is kept. Deleting the last normal group is rejected (`409 last_group`).
- **Deleting a group with `moveTasksTo`:** re-key the moved placements to the end of the target group, preserving their relative order, then soft-delete the group.
- **Deleting with `moveTasksTo`** also moves the placements of the group's *soft-deleted* tasks (to the end of the target group, in their relative order), so that no placement references a deleted group.
- **Deleting with `deleteTasks`:** soft-delete the tasks (`deleted_by` = actor) and the group. A restore restores both.
- **Purging a group** (hard delete after 30 days) first re-homes any placements still referencing it to the top of the owner's Inbox.
- **Removing a member from an org:**
  1. Set `assignee_id = NULL` on **all** their tasks in that org, both open and completed, including soft-deleted ones.
  2. Reconcile the placements, which deletes all of that user's placements in the org.
  3. **Hard-delete** their groups (including the Inbox), `org_member_pref` and `task_expansion` rows for that org.

  If the user re-joins later, they get a fresh Inbox and the default groups.

### 4.3 Tasks
- `seq` is assigned on insert: `UPDATE organization SET task_seq = task_seq + 1 … RETURNING task_seq`, in the same transaction.
- **Subtask depth limit:** 5 levels. Cycles are rejected: setting `parent_id` validates that the new parent is not a descendant.
- A subtask must be in the same org as its parent.
- **Soft delete cascades logically:** deleting a parent soft-deletes its descendants with the same `deleted_at`. Restoring a parent restores only the descendants that share that `deleted_at`.
- **The trash purge** hard-deletes tasks with `deleted_at < now - 30d`, and their blobs.

### 4.4 Field clocks (LWW)
- **Task** clock keys: `title`, `description`, `assignee`, `completed`, `parent` (`parent_id` and `subtask_position` together), and `due`.
  - `due` covers `due_date`, `due_time`, `due_tz`, `start_date`, `recurrence` and `recurrence_basis` **as one unit**. These fields have cross-field CHECK constraints, so they must never be merged independently: a patch touching any of them is applied (or skipped) as a whole.
  - Before writing, the server validates the merged result. If it would violate a CHECK constraint, the patch gets `422 validation_failed` (never a 5xx).
- **Placement:** the clock key is `pos:<userId>`, stored in the task's `field_clock`. 04 and 06 call this key "`pos`" for short.
- **Group:** `name`, `pos`, `collapsed`.
- **Deletion and restore** use the `deleted` key. A patch to a deleted task returns `410 conflict_deleted`, unless the patch is itself a restore.

### 4.5 Retention
| Data | Retention |
|---|---|
| Soft-deleted tasks and groups | 30 days |
| Idempotency rows | 7 days |
| Read notifications | 90 days |
| Completed tasks | forever (they are user data) |
| Activity | forever |
| Backups | 7 daily + 4 weekly |

## 5. DTOs (API shapes; zod schemas in `packages/core/schemas`)

```ts
type TaskDTO = {
  id: string; orgId: string; seq: number | null;
  parentId: string | null; subtaskPosition: string | null;
  title: string; description?: string;            // description omitted in list payloads
  assigneeId: string | null; createdBy: string;
  dueDate: string | null; dueTime: string | null; dueTz: string | null; startDate: string | null;
  recurrence: string | null; recurrenceBasis: 'due' | 'completion' | null;
  completedAt: number | null;
  tagIds: string[];
  counts: { subtasks: number; subtasksDone: number; comments: number; attachments: number };
  placement: { groupId: string; position: string } | null;  // only for the requesting user
  createdAt: number; updatedAt: number;
  deletedAt?: number; deletedBy?: string;          // only present in Trash payloads
};
type GroupDTO = { id: string; orgId: string; kind: 'inbox' | 'normal'; name: string; position: string; collapsed: boolean };
type MyListDTO = { groups: GroupDTO[]; tasks: TaskDTO[]; expandedTaskIds: string[]; serverTime: number };
type OrgDTO = { id: string; slug: string; name: string; isPersonal: boolean; avatarEmoji: string | null; color: string | null; role: 'owner' | 'member'; position: string; collapsed: boolean };
```

## 6. Recurrence format (P10)

- An RFC 5545 RRULE **subset**, stored without the `RRULE:` prefix:
  - `FREQ=DAILY|WEEKLY|MONTHLY|YEARLY`
  - `INTERVAL=n`
  - `BYDAY=MO,TH` (weekly) or `BYDAY=2TU` / `-1FR` (monthly nth weekday)
  - `BYMONTHDAY=15`
  - `COUNT=n` or `UNTIL=YYYYMMDD`
- `recurrence_basis='completion'` means the next date = completion date + interval, so only `FREQ` and `INTERVAL` are used.
- `packages/core/src/recurrence.ts` implements `nextOccurrence(rule, basis, fromDate, completedOn)`. It has exhaustive unit tests, including month-end clamping (Jan 31 + 1 month → Feb 28/29) and DST-safe date arithmetic (all floating dates).
