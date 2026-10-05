# 01: Product Requirements

Requirements are numbered `FR-<AREA>-<n>`. **P** is the phase that delivers each one (see [09-phases](09-phases.md)). Exact interaction behaviour is in [02-ux-interaction](02-ux-interaction.md). Where this file and 02 overlap, 02 defines *how* and this file defines *what*.

## Personas


---

## FR-AUTH: Accounts & sign-in

| ID | Requirement | P |
|---|---|---|
| FR-AUTH-1 | Users sign in with **Google** or any configured **generic OIDC provider** (Keycloak, Authentik, Entra ID, Zitadel and so on). There are no passwords. | 1 |
| FR-AUTH-2 | Sign-in is permitted only if the verified email matches the **allowlist**: emails or domains from env plus admin-managed DB entries, or a pending **invitation**. Everyone else sees a friendly "not invited" page. | 1 |
| FR-AUTH-3 | On first sign-in, an account is created along with the **Personal org** and its groups. The default groups are *Today*, *Prio* and *Upcoming* (localised names), plus the system *Inbox* group. | 1 |
| FR-AUTH-4 | Sessions are httpOnly cookies that last 30 days with sliding renewal. Users can see and revoke their sessions under Settings → Security. | 1 |
| FR-AUTH-5 | A user can link several identities, for example both Google and the company OIDC provider, to one account with the same verified email. | 1 |
| FR-AUTH-6 | **Personal access tokens (PATs):** users create, name, scope (`read` or `write`, where `write` implies `read`), give an optional expiry to, and revoke tokens. A token is shown once and stored only as a hash. | 8 |
| FR-AUTH-7 | **Device login for the CLI** follows RFC 8628. The user approves a device code in the web UI while signed in. | 8 |
| FR-AUTH-8 | Instance admins (`ROOSTER_ADMIN_EMAILS`) manage the allowlist and can list and deactivate users in an Admin page. | 1 |

## FR-ORG: Organisations

| ID | Requirement | P |
|---|---|---|
| FR-ORG-1 | Every user has exactly one **Personal org**: single member, not shareable, not deletable. | 1 |
| FR-ORG-2 | Any allowed user can create an org with a name, a short slug and a colour/emoji avatar. The creator becomes `owner`. | 1 |
| FR-ORG-3 | Owners can invite by email or by **invite link**. In P1, both produce a copyable link. From P7, an email is also sent when SMTP is configured. An invite link is single-use or multi-use, expires after 7 days by default, and can be revoked. | 1 |
| FR-ORG-4 | Owners can change roles, remove members, rename the org and delete it. Deleting requires typing the org name. Removing a member unassigns their tasks, which then appear in *Everyone's tasks → Unassigned*, and deletes that member's groups in the org. | 1 |
| FR-ORG-5 | The last owner cannot leave or be demoted. | 1 |
| FR-ORG-6 | Orgs appear in the sidebar in a user-defined order, with drag to reorder. The Personal org is first by default but can be moved. | 1 |
| FR-ORG-7 | Each org has its own tags. Tasks never move between orgs in v1. A future "move to org" is out of scope. | 3 |

## FR-GRP: Groups (personal sections)

| ID | Requirement | P |
|---|---|---|
| FR-GRP-1 | Each user has their own ordered list of groups **per org**. Names are arbitrary (1–80 characters, emoji allowed). Duplicate names are allowed but warned about. | 2 |
| FR-GRP-2 | Groups are created inline at the cursor position (see 02 §4), renamed inline, collapsed and expanded (persisted per user), and reordered by drag and drop or keyboard. | 2 |
| FR-GRP-3 | Deleting a group shows an inline confirmation popover with two choices: **Move tasks to…** (any other group, defaulting to the group above) or **Delete tasks too** (soft delete, undoable). An empty group is deleted immediately with an undo toast. | 2 |
| FR-GRP-4 | The **Inbox** system group exists once per user and org. It is pinned above all other groups, **hidden when it has no open tasks**, and cannot be renamed, deleted or reordered. Its header shows a count badge and a "Triage" hint. | 2 |
| FR-GRP-5 | Tasks land in the Inbox when they are assigned to me by someone else, created via CLI, API or MCP without a group, or created from *Everyone's tasks* for me. | 2/6 |
| FR-GRP-6 | Group order is **exactly** what the user sets. It is never sorted automatically. | 2 |

## FR-TASK: Tasks in the list

| ID | Requirement | P |
|---|---|---|
| FR-TASK-1 | Tasks are created **inline**: Enter creates below the current task, Shift+Enter creates above, and there is an "Add task" row at the end of each group. Creating a task in My tasks assigns it to me. | 2 |
| FR-TASK-2 | The title is edited inline (1–500 characters, single line, no Markdown rendering in the row). | 2 |
| FR-TASK-3 | The due date is set inline from the row's date cell or by NL parsing in the title. The cell shows a relative label coloured by the date semantics in 03. | 2 |
| FR-TASK-4 | Completion uses the checkbox, Ctrl/Cmd+Enter, or a swipe on mobile. The row fades and is hidden after about 1.5 s. An undo toast (6 s) is shown and Ctrl/Cmd+Z also undoes. | 2 |
| FR-TASK-5 | A "Show completed" toggle in the list header shows completed tasks in their original position (greyed, struck through). They can be uncompleted. Completed tasks keep their group and position. | 2 |
| FR-TASK-6 | Tasks are reordered within and between groups by drag and drop (mouse, touch and keyboard) and by keyboard shortcuts. Multi-select supports bulk drag. | 2 |
| FR-TASK-7 | **Multi-select** (Shift-click, Ctrl/Cmd-click, Shift+↑↓) shows a bulk bar with Complete, Set date, Move to group, Add tag, Assign (P6) and Delete. | 2 |
| FR-TASK-8 | Delete is soft and undoable. Deleted tasks go to Settings → **Trash** per org, which keeps them for 30 days and offers restore and permanent delete. | 2 |
| FR-TASK-9 | Pasting multiple lines into a title creates one task per line, after a confirm chip ("Create 5 tasks?"). | 2 |
| FR-TASK-10 | Rows show subtask progress ("2/5"), comment count (P6), an attachment indicator (P10), a recurrence icon (P10), tag chips, and the assignee avatar (only in *Everyone's tasks* and for subtasks assigned to others). | 3+ |
| FR-TASK-11 | **Subtasks inline:** a chevron on the parent expands its subtasks as indented rows, which can be edited inline. Enter in a subtask creates a sibling subtask. Expansion state is persisted per user. | 3 |
| FR-TASK-12 | A subtask assigned to me whose parent is not assigned to me appears as its own top-level row with a muted breadcrumb "Parent title ›" before its title. | 3/6 |
| FR-TASK-13 | **Duplicate task** (Ctrl/Cmd+D) copies the title, description, dates, tags and subtasks, and inserts the copy below the original. | 3 |

## FR-DATE: Dates

| ID | Requirement | P |
|---|---|---|
| FR-DATE-1 | A due date is a calendar date (floating). The optional due time is HH:MM in the creator's timezone and is stored with that timezone. | 2 |
| FR-DATE-2 | The optional start date must be ≤ the due date. It displays as a range "Oct 10 – 12". | 3 |
| FR-DATE-3 | The date picker popover has a text input (NL), quick chips (Today, Tomorrow, Next week, Next weekend, No date), a month calendar, an "Add time" toggle, an "Add start date" toggle (P3) and (P10) Repeat. **Picking a date closes the popover.** | 2 |
| FR-DATE-4 | Natural-language parsing in the title and the picker works in **English and Swedish** (grammar in 02 §NL dates). The recognised phrase is highlighted while typing. On commit it is removed from the title and set as the due date. Clicking the highlight cancels the parse for that phrase. A setting can disable title parsing. | 2 |
| FR-DATE-5 | The relative display and colours follow 03 §Due-date semantics. They respect user settings for date format, week start, 12/24 h time and timezone. | 2 |

## FR-DET: Detail pane

| ID | Requirement | P |
|---|---|---|
| FR-DET-1 | The pane opens with a click on the row body (not the title text when it is already in edit mode), Tab+Enter, `Space` (peek) or `O`. The URL changes to `/o/:orgSlug/t/:taskId`, which is deep-linkable. | 3 |
| FR-DET-2 | Pane content: breadcrumb (parent chain), title (multi-line edit), completion button, assignee, due date, start date, repeat, tags, description (rich Markdown editor), subtasks (inline list with the same keyboard model), attachments (P10), and activity and comments (P6). | 3 |
| FR-DET-3 | The description is a WYSIWYG Markdown editor. Supported: headings H1–H3, bold, italic, strike, inline code, code block, links, bullet, ordered and task lists, quotes and horizontal rules. Content is stored as Markdown. Long descriptions collapse after about 12 lines with a "Show more" control, so subtasks stay visible. | 3 |
| FR-DET-4 | The pane has a toolbar with complete, copy link, duplicate, full-screen (Tab+X), "…" (delete, copy task ID, open in new tab) and close. | 3 |
| FR-DET-5 | Edits autosave on blur and after a 600 ms debounce. A subtle "Saved" or "Offline – will sync" status appears. | 3 |

## FR-TAG: Tags

| ID | Requirement | P |
|---|---|---|
| FR-TAG-1 | Tags belong to an org and have a name (1–40 characters) and a colour from the 10-colour tag palette (03). | 3 |
| FR-TAG-2 | Tags are added via Tab+T or `#` typed in the title (`#urgent`), which autocompletes and creates the tag when it is new. They are shown as chips after the title. | 3 |
| FR-TAG-3 | Settings → Tags lets the user rename, recolour, merge and delete tags. | 3 |
| FR-TAG-4 | A filter by tag is available in the My tasks header. | 3 |

## FR-VIEW: Smart views, Everyone's tasks, search

| ID | Requirement | P |
|---|---|---|
| FR-VIEW-1 | Built-in smart views per org: **Today** (due ≤ today, including overdue), **Next 7 days** (grouped by day), **Overdue**, **No date**. They are read-only groupings, but rows are fully editable (completing a task, setting its date and so on). Each sidebar entry shows a count badge. | 5 |
| FR-VIEW-2 | **Everyone's tasks** (org overview, shared orgs only): all open tasks in the org grouped by assignee (me first, then alphabetical, then *Unassigned*). Each group is sorted by due date, then created date. Filters: tag, has due date. Tasks can be created inline under any assignee (they land in that person's Inbox). | 6 |
| FR-VIEW-3 | **Search** (Ctrl/Cmd+K, then type) does full-text search over titles, descriptions and comments in the current org, with a toggle for all orgs. It supports prefix matching and filters `#tag`, `due:today`, `is:done` and `@person`. | 5 |
| FR-VIEW-4 | The **command palette** (Ctrl/Cmd+K) offers search results plus actions: go to an org or view, create a task, toggle completed, open settings, and any task action for the selected task(s). | 5 |

## FR-COL: Collaboration (shared orgs)

| ID | Requirement | P |
|---|---|---|
| FR-COL-1 | Tasks are assigned to any org member via Tab+A or the assignee field in the pane. When reassigned, the task leaves the previous assignee's groups and appears in the new assignee's **Inbox**. Assigning to myself from *Everyone's tasks* also puts it in my Inbox. | 6 |
| FR-COL-2 | Tasks can be unassigned. They are then visible only in *Everyone's tasks → Unassigned* and as subtasks of their parent. | 6 |
| FR-COL-3 | Comments are Markdown-light (bold, italic, code, links, lists) and support **@mentions** of org members. They can be edited (marked "edited") and deleted by their author. | 6 |
| FR-COL-4 | **Followers:** the creator, the assignee, commenters and mentioned users follow a task automatically. Users can follow or unfollow manually. | 6 |
| FR-COL-5 | The **activity log** in the pane is interleaved with comments: created, renamed, due changed, assigned, completed or reopened, description edited (collapsed), subtask added, attachment added. Events of the same kind by the same actor within 5 minutes are grouped. | 6 |
| FR-COL-6 | Personal orgs hide every collaboration UI element (assignee, followers, Everyone's tasks). | 6 |

## FR-NOT: Notifications

| ID | Requirement | P |
|---|---|---|
| FR-NOT-1 | The **in-app inbox** (bell icon) shows notifications for: assigned to me, comment on a followed task, @mentioned, a task I created was completed by someone else, a due date on my task changed by someone else, and an invite accepted. Notifications can be marked read or unread individually or all at once, and clicking one opens the task. | 6 |
| FR-NOT-2 | **Web Push** is opt-in per device (the permission is requested only from a user gesture in Settings → Notifications). It sends the same events plus an optional **due reminder** at a user-chosen time (default 08:00 local) listing today's tasks. | 7 |
| FR-NOT-3 | **Email** is available when SMTP is configured. It covers invites, notifications as immediate or a 15-minute batch, and an optional **daily digest** (due today, overdue, new in Inbox). Every email has an unsubscribe link per category. | 7 |
| FR-NOT-4 | A per-user preference matrix (event × channel) controls notifications. Users never receive notifications for their own actions. | 6/7 |

## FR-REC: Recurring tasks

| ID | Requirement | P |
|---|---|---|
| FR-REC-1 | Supported patterns: every N days, weeks (on chosen weekdays), months (on day D, or on the nth or last weekday) or years; and *N days/weeks after completion*. An optional end condition is either an end date or a count. | 10 |
| FR-REC-2 | NL phrases are supported: "every day", "every mon", "every 2 weeks", "every month", "varje måndag", "varannan vecka" and so on (see 02). | 10 |
| FR-REC-3 | When a recurring task is completed, the next instance is created with the next date. It goes into the **same group at the position directly after the completed task**, for the same assignee. Title, description, tags, followers and subtasks are copied, with subtasks reset to open. Comments and attachments are not copied. | 10 |
| FR-REC-4 | Removing the due date or the repeat rule stops the series. Deleting an instance asks "this / this and following". | 10 |

## FR-ATT: Attachments

| ID | Requirement | P |
|---|---|---|
| FR-ATT-1 | Files are attached by drag and drop onto the pane, paste (images), or a file picker. The limit is 25 MB by default (`ROOSTER_UPLOAD_MAX_MB`). | 10 |
| FR-ATT-2 | Images get thumbnails generated server-side (WebP, 320 px) and open in a lightbox. Other files download with `Content-Disposition: attachment`. | 10 |
| FR-ATT-3 | Storage is local `/data/attachments` by default, or S3-compatible when `ROOSTER_S3_*` is set. Downloads are always proxied or served through short-lived signed URLs and access is checked. | 10 |


## FR-CAL: iCal feed

| ID | Requirement | P |
|---|---|---|
| FR-CAL-1 | Settings → Calendar feed creates a private, secret URL `/ical/<token>.ics`, either per org or for all orgs, containing my open tasks that have due dates. A due date only becomes an all-day VEVENT; a due date with time becomes a 30-minute VEVENT. The title is prefixed with ☐, and the description links back to the task. | 10 |
| FR-CAL-2 | The token can be regenerated or revoked. Responses are cacheable for 15 minutes. | 10 |

## FR-SET: Settings

| ID | Requirement | P |
|---|---|---|
| FR-SET-1 | **Profile:** name, avatar (from OIDC in P1; upload in P10 together with the image pipeline), language (English or Svenska), timezone, week start, date format (`Oct 12` or `12 Oct`), time format (24 h or 12 h). Defaults come from the browser. | 1 |
| FR-SET-2 | **Behaviour:** NL date parsing in titles (on/off), completion hide delay (1.5 s / 3 s / until reload), mobile swipe actions (left and right action each chosen from Complete, Date, Move, Delete). | 2/4 |
| FR-SET-3 | **Security:** active sessions, linked identities, PATs (P8), authorised CLI devices (P8). | 1/8 |
| FR-SET-4 | **Org settings** (owners): name, avatar, members, invites, tags, danger zone. | 1 |
| FR-SET-5 | **Data:** export all my data in an org as JSON (and Markdown), Trash, Import. | 5 |

## FR-CLI, FR-MCP

Specified in [07-cli](07-cli.md).

## FR-PWA: Mobile & offline

| ID | Requirement | P |
|---|---|---|
| FR-PWA-1 | The app is installable (manifest, icons, maskable icon, splash). It opens standalone and its theme colour matches the app chrome. | 4 |
| FR-PWA-2 | The app shell loads offline. The last-seen data for all orgs (My tasks, groups, tags, smart views, and task details opened in the last 14 days) is readable offline. | 4 |
| FR-PWA-3 | Every list and pane mutation works offline and is queued. An "Offline · 3 pending" pill appears in the header (02 §14). The queue syncs automatically when online, on app foreground, and on SSE reconnect. | 4 |
| FR-PWA-4 | Conflicts use per-field last-write-wins. If a queued op targets a task that was deleted or moved out of the user's reach, the op is dropped and a toast shows "1 change couldn't be applied" with details. | 4 |
| FR-PWA-5 | The mobile layout (≤ 768 px) has a bottom nav (My tasks · Search · Inbox · Settings; the Inbox tab is added in P6, and P4 ships the other three), a header org switcher, a FAB, swipe actions, long-press drag, and the detail pane as a full-screen sheet. | 4 |
| FR-PWA-6 | Update flow: when a new version is deployed, a "New version available – Reload" toast appears. The app never reloads silently while the outbox is non-empty or the user is editing. | 4 |
