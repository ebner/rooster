# ADR 0072: Move tasks between organisations

- Status: accepted
- Date: 2026-11-17
- Amends: 01 FR-ORG-7 ("Tasks never move between orgs in v1"), 05 §4.3 ("A subtask must be in the same org as its parent" stays; tasks may now change org), 06 (new endpoints), 02 (new action), 07 (CLI, TUI, MCP), 11 §5.2 (new tool)
- Code: `TaskService.moveToOrg` and `previewMoveToOrg`, `POST /api/v1/tasks/move-to-org`, `GET /api/v1/tasks/move-to-org/preview`, the `task.moveToOrg` list op, migration `0017_task_former_seq`

## Context
A task created in the wrong organisation (Personal instead of the team, or the other way round) could only be retyped in the right one: a task's `org_id` never changed. Everything bound to an org had to be decided for a move: the org-scoped number (`#42`), tags, every member's groups and placements, the assignee, subtasks, followers, reminders, notifications, comments, attachments, the search index, grant constraints, SSE audiences and the clients' per-org caches. The maintainer chose the behaviour below on 2026-11-17.

## Decisions

### Who and what
1. **Anyone who can edit the task may move it** to another org they are a member of: the same rule as delete (a member of both orgs; a grant needs `tasks:write` on the whole subtree in the source and on the landing group in the target, 11 §2). Only live tasks move (a task in Trash gets `410`).
2. **A move takes the whole subtree.** Every descendant moves with it, live or soft-deleted (a subtask must stay in its parent's org, 05 §4.3).
3. **A subtask moves on its own by detaching:** it arrives as a top-level task (with its own subtasks). Its old parent loses it.
4. **Several tasks move together** (the bulk bar): all from one source org (`422 validation_failed` otherwise), placed consecutively in the given order. A selected task whose ancestor is also selected travels with the ancestor.
5. **Same org:** `422 same_org`.

### Where it lands
6. **The mover picks the org, then one of their groups there.** The moved tasks become the mover's (see 8) and land at the **top** of that group, or at an ordering intent (`afterId`/`beforeId`, used by undo). Without a group: the top of the mover's first normal group (the first non-Inbox group in their order).

### What changes on the tasks
7. **A new number.** Each moved task gets the target org's next `seq` (in tree order: root first, then depth-first by subtask position). The old number is recorded in `task_former_seq (org_id, seq, task_id)`:
   - **Refs keep working:** `GET /tasks/resolve` falls back to it, so `acme#42` still finds the task (when the actor can read it).
   - **A task that returns to an org gets its old number back** (counters never reuse numbers, so it is free), which makes undo exact.
8. **Assignees:** the moved roots become the mover's (it lands in the group they picked). A descendant keeps its assignee when that person is a member of the target org; otherwise it takes its new parent's assignee. In a personal target org everything is the owner's (no null assignee there, FR-COL-6).
9. **Tags are matched by name** (case-insensitive) in the target org; a missing tag is created there with the next colour. A grant that may not create tags in the target (`write` not `all`) gets `403` when a tag would have to be created.
10. **Field clocks:** the `pos:<user>` keys are reset (they named the old placements); `parent` (a detached root) and `assignee` (changed assignees) are stamped with the move's edit time.
11. **Recurring tasks:** the moved instance keeps its rule and `series_id`; completed instances stay where they are, so a series can span orgs. The next instance is created in the task's org at completion time.

### What travels and what stays
12. **Everything about the task travels:** description, comments, activity, attachments (rows only; blob keys keep the old org id, which is cosmetic), the user's reminders, completion.
13. **Confirm before sharing content:** when the moved tasks carry comments or attachments by someone other than the mover **and** the target org has a member who is not a member of the source org, the clients confirm before moving ("3 comments and 2 files will be visible to members of Riverside Garden Club"). `GET /tasks/move-to-org/preview` reports this; the server doesn't require the confirmation (it is the mover's choice), so the move endpoint stays idempotent and offline-capable.
14. **Membership-bound rows are cleaned up** for people who aren't members of the target org: followers, reminders, expanded-state rows (`task_expansion`) and their notifications about the moved tasks. Notifications of people who keep access are re-pointed to the target org (`org_id`, the snapshot's `taskSeq`). Activity and attachment rows get the target `org_id`. Stored idempotent responses of people who lose access are forgotten (as on member removal).
15. **People who lose the task are told:** its assignee and followers before the move who are not members of the target org (the mover excepted) get an in-app notification `moved_away` ("Maja moved 'Call the bank' to another organisation"). It names neither the target org nor links the task (they can't open it): `orgId` is the source org, `task` is null, and the title is in the snapshot. In-app only, outside the preference matrix.
16. **Activity:** each moved root gets an `org_moved {fromOrgId, toOrgId}` entry. Clients show the source org's name only to viewers who are members of it ("moved this task here from Kestrel Lane"), otherwise "from another organisation". Descendants get no entry.

### Events
17. Two audiences: the source org's members and the list users the task had before the move (`my-list`, `everyone`, `trash` of the source org, the tasks' keys), and the target org's members (`my-list`, `everyone`, `trash` of the target org, the tasks' keys). Recipients of `moved_away` and of deleted notifications also get `['notifications']`.

### API (06)
18. `POST /api/v1/tasks/move-to-org`, body `{ ids: string[1..200], orgId, groupId?: string | null, afterId?, beforeId? }`, response `{ orgId, tasks: Task[] (the moved roots, as the actor sees them in the target org), movedIds: string[] (every moved task, descendants included) }`. Idempotent (`Idempotency-Key`), with `X-Rooster-Edit-Time`. Errors: `404` (a task, the target org or the group the actor can't see), `410 conflict_deleted`, `422 same_org`, `422 validation_failed`, `403` (grant).
19. `GET /api/v1/tasks/move-to-org/preview?ids=a,b&orgId=…`: `{ tasks, subtasks, comments, attachments, exposes: boolean, newTags: string[], reassigned: number }`, where `comments`/`attachments` count those by people other than the actor and `exposes` is decision 13's condition. No side effects.

### Clients
20. **One list op, `task.moveToOrg`**, queued under the **source** org (`entityId` = the source org id, like bulk ops). Optimistically the moved subtrees leave the source org's list; the target org's list is refetched when the server confirms. Undo enqueues the inverse under the **target** org: a move back into the original group at the original position (and, for a detached subtask, a re-parent under its old parent). The numbers come back (decision 7); assignees, followers and created tags are not restored.
21. **The picker needs a connection** (it shows the preview); the op itself goes through the outbox like every list op.
22. **Web entry points:** the detail pane's ⋯ menu (desktop) and the task sheet's menu (phone), the palette action "Move to organisation…" (keyboard path, no shortcut of its own), and the bulk bar (desktop multi-select and phone selection mode). The picker is two steps in one popover or sheet: the orgs (the current one checked, not selectable), then the target org's groups (digits 1–9, like Move to group); the confirmation of decision 13 is a third, inline step. No modal. After the move: a toast "Moved to <org>" with Undo; the cursor goes to the next row; an open pane follows the task to `/o/<target>/t/<id>`.
23. **A pane whose task is in another org than the URL** replaces the URL with the task's org (a moved task, an old link).
24. **CLI:** `rooster mv <ref…> --to-org <org> [--group <name>] [--yes]`; when the preview says `exposes`, it asks on a terminal and needs `--yes` otherwise (exit 2). **TUI:** the move picker (`m`) gets "Another organisation…", then the org and group steps and the confirmation. **MCP:** `move_task_to_org { ref, org?, toOrg, group?, shareContent? }` (`tasks:write`); when the preview says `exposes` and `shareContent` isn't `true`, the tool answers with what would be shared instead of moving.

## Implementation decisions
Recorded from the implementation (2026-11-17).

### Server (`services/task-org-move.ts`)
- **Landing group:** `groupId`, else the group of the `afterId`/`beforeId` anchor in the actor's list in the target org (`422 validation_failed` when the anchor isn't there; undo and chunked moves use this), else the actor's first normal group, else the Inbox.
- **Assignees:** a descendant without an assignee stays unassigned in a shared target and becomes the owner's in a personal one. Changed assignees get no `assigned` activity or notification; the roots get only `org_moved`.
- **Followers:** a personal target has none (the owner's are deleted too); in a shared target the mover follows each root and anyone newly assigned follows that task.
- **`moved_away`** goes once per user per moved root, with the root's title, to the assignees and unmuted followers of the live tasks in the subtree who aren't target members, the mover excepted. Kept notifications get the target `org_id` and the new `data.taskSeq`.
- **Stored idempotent responses** are forgotten only where they mention a moved task's id, for source members who aren't target members (`forgetResponsesMentioning`), narrower than member removal.
- **Clocks:** `parent` and `assignee` are stamped with the larger of their value and the edit time; there is no `org` clock key (the move isn't last-write-wins).
- **The old parent** of a detached subtask gets no activity entry.
- **Grants:** like duplicate and restore, the check also covers where every moved task lands in the actor's list. The preview applies the same rules (a read-only grant gets `403`).
- **`visibleKeys`** (grant-access.ts) judges a task's prior group by the event's org rather than the task's current org, so a grant reading one group of the source org still learns that the task left.
- **Old refs:** `GET /tasks/resolve` falls back to `task_former_seq` only when nothing matches `org#n`, and only for members of the task's current org whose grant reaches it; everyone else gets `404`. The table has an extra index on `(task_id, org_id)`.
- **Events:** one domain event, `task.org_moved`, with the source audience (reach captured before the move, Trash included) and the target audience; `['tags', target]` when a tag was created; `['notifications']` for everyone whose notifications were deleted or re-pointed.

### Web
- **Undo is instant:** the inverse op carries an unsent `restore` snapshot of the subtrees, so the tasks reappear in the source list at once (with their original assignees until the refetch). Undo and redo of an entry that spans two orgs replay the recorded ops instead of recomputing them; the pipeline queues a `task.moveToOrg` under its `entityId` and replays it into both the queue org and the arrival org.
- **The inverse** is one move-back per run of adjacent moved rows, anchored on their unmoved neighbours; roots without a row of the mover's go back to the top of the Inbox. More than 200 roots are sent in chunks anchored on the previous chunk.
- **Only tasks the server has can move** (`movableToOrg`: live, a server `seq`, no queued create).
- **The picker:** Enter on an org opens its groups with the default group active (Enter, Enter lands there; click and digits behave the same). Nothing can be picked while the preview can't load. The confirmation's Move button is primary, not danger: sharing is an informed choice, not a warning.
- **Everyone's tasks** offers the move in the pane only. Phone selection mode has it in a ⋯ menu in the selection header (the bottom bar is full). The bulk bar's visible label is "Organisation…" (accessible name "Move to organisation…").
- **The pane trusts a move it followed for up to 60 s,** so decision 23 doesn't send it back before the task's detail refetches.
- A `moved_away` notification only marks itself read when opened.

### CLI, TUI and MCP
- `--to-org` takes a slug, an id, `personal` or a unique org name (case-insensitive; an ambiguous name exits 4 with the slugs). `same_org` is caught before any request.
- The TUI's confirmation needs `y` (Enter does nothing there). The TUI offers the org move for tasks with their own row in My tasks, like Move to group; a subtask under its parent moves from the CLI or MCP. Its undo moves the task back to its old place (else the default group) and tries to restore the parent.
- MCP's "not moved" answer is a normal result marked `moved: false`, not a tool error.

## Considered
- **Copy into the target and delete the original** (duplicate already exists): loses comments, activity, attachments and the task's id (links, follows, reminders), and leaves a Trash entry.
- **Keeping the colleague as assignee** when they are a target member: the mover's group pick would then not apply, and the result would depend on the target's membership.
- **Dropping other people's comments and files** on the way: destroys the conversation that the move was supposed to keep.
- **A server-enforced confirmation** (`confirm: true`): the op couldn't be retried from the outbox without the client re-deciding; the preview gives the clients what they need.
