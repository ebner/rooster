# ADR 0073: Views, projects and the "All organisations" section

- Status: accepted (2026-11-17), scheduled as Phase 13 (09); Part A implemented (ADR 0074), Part B not yet
- Date: 2026-11-17
- Amends: 00 Non-goals ("Org-wide lists are limited to the 'Everyone's tasks' overview") and Q-01 (a cross-org "All" tab); 01 FR-VIEW; 02 §2 (sidebar), §10 (smart views), §13 (phone); 05 (new tables, `user.prefs`); 06 (new endpoints); 07 (CLI, TUI, MCP); 11 §5.2 (tools)

## Context
Two gaps came up together (maintainer, 2026-11-17):

1. **Projects inside an organisation.** Teams want one place per project (a client, a launch) that shows everything going on in it, across people. Today a tag can be filtered in My tasks (FR-TAG-4) and in Everyone's tasks (FR-VIEW-2), but the filter is per session and per person, and My tasks only shows your own tasks.
2. **One overview across organisations.** With Personal, a team org and maybe a club, "what is due today?" means visiting every org's Today. The spec's decision log has this as Q-01 ("A cross-org 'All' tab … Revisit after v1.0").

How other tools solve these (as known to us; details may have changed):
- **Asana:** projects are containers (sections, manual order; a task can be in several projects). My Tasks is per person with personal sections, exactly rooster's groups, and per workspace: people working in several workspaces have no combined list.
- **Jira:** the project is an issue's single home (its key prefix, permissions), closer to a rooster org. Saved JQL filters, private or shared, drive boards and dashboards.
- **Linear:** the team is the home (`ENG-42`); a project is a first-class, single-valued field; views are saved filters, personal or shared.
- **Todoist, Things, Microsoft To Do, Apple Reminders:** Today and Upcoming span every project or list; Apple Reminders' smart lists and Mail's "All Inboxes" span accounts too.

rooster has two independent axes: **groups** are personal and ordered by hand ("when and how do I work on it"), **tags** belong to the org ("what is it about"). A project is about the second axis, so it should be a lens over tasks, not a container competing with groups: a container would force a task to choose between "Prio" and "Juniper". The "when" views (Today, Next 7 days, Overdue) should span every org, while the "where" lists (an org's My tasks, its projects) stay in their org: the pattern of Apple Reminders and Mail.

**Access stays where it is.** The organisation remains rooster's only access boundary: every member of a shared org sees every task in it. A view chooses what is shown together, never who may see it. Restricted work goes in its own org (and can be moved there, ADR 0072). Private projects with their own members would be a second boundary across every read path (lists, search, notifications, SSE, export, iCal, refs, grants) and are out of scope here; a project-field model would leave room for them later.

## Decisions

### Part A: the "All organisations" section (answers Q-01)
A1. **Three cross-org smart views:** Today, Next 7 days and Overdue over every org the user is a member of, at the top of the sidebar under "All organisations". No date and My tasks stay per org (they are about filing, which belongs to an org's groups).
A2. **Arranged by date, not by org:** the same sections as the per-org views (Today: Overdue, then Today; Next 7 days: one per day), mixed across orgs. Each row carries its org's avatar and colour as a small chip (its accessible name includes the org). Within a section: by due time, then the viewer's own order (the org's sidebar order, then group order and position), as in the per-org views (`selectView`).
A3. **Rows are fully editable,** as in any smart view; every op is queued under the task's own org. Sorted views: no drag (02 §8).
A4. **New tasks** typed in an All view go to the user's **default organisation**, a new preference (`prefs.defaultOrgId`, Personal unless changed in Settings → Behaviour), shown as a muted org chip on the draft row. The title token **`^org`** (org name or slug, completed like `#tag`) picks another org, and the chip updates as you type. Otherwise the per-org smart view rules apply: the date comes from the section, the task goes to the Inbox unless `>Group` names one of the target org's groups. Overdue has no add row.
A5. **Badges sum every org** (Today, Overdue in red only when > 0); per-org badges stay.
A6. **Start page:** Settings → Behaviour, "Open rooster on: the last view (default) / All · Today".
A7. **Phone:** "All organisations" is the first entry of the org sheet and of the header's swipe order (ADR 0063); its view switcher shows Today · 7 days · Overdue.
A8. **Keyboard:** no shortcut of its own; the palette lists "All organisations: Today / Next 7 days / Overdue" (the keyboard path, hard rule 8), and the sidebar is reachable as today. URLs: `/all/today`, `/all/week`, `/all/overdue`.
A9. **Data:** computed on the client from the per-org `my-list` caches the app already keeps for the sidebar badges and the offline palette, so it works offline. The server gets `GET /api/v1/me/views/{today|week|overdue}` (all orgs, grant-filtered) for the CLI, TUI and MCP; `rooster ls today --all-orgs` exists and uses it.

### Part B: views and projects (per organisation)
B1. **A view is a saved query** in one org, **private** (only its creator sees it) or **shared** (every member). In a personal org every view is private.
B2. **The query** is structured, edited as chips, and maps onto the search grammar (FR-VIEW-3): tags (`any` or `all` of them), assignee (`anyone`, `me`, `unassigned`, a member), due (`any`, `today`, `week`, `overdue`, `none`), status (`open` (default), `done`, `any`). No free text: views stay stable and computable offline.
B3. **A view with exactly one tag is a project view**, with three touches: a task typed in it gets the tag; the header shows "7 open · 12 done"; it can be archived when the project is done. (Typically shared; a private one in Personal works the same.)
B4. **Rows are grouped by person, then due date:** me first, then members alphabetically, then Unassigned (like Everyone's tasks, FR-VIEW-2); each section by due date, then created. In a personal org there are no person headers.
B5. **Matching tasks only:** a task shows when it matches itself. A tagged subtask shows under its assignee with a breadcrumb to its parent; a tagged parent doesn't pull in untagged subtasks (its subtask count shows). Completed tasks are hidden; "Show completed" in the header shows them.
B6. **New tasks in a view** get the view's tags and the person whose section they were typed in (Unassigned stays unassigned), landing at the top of that person's Inbox (FR-COL-1). The other filters (due, status) aren't applied.
B7. **Creating and editing inline, no modal:** "+ New view" in the org's sidebar section opens an empty view whose header is editable: the name, then the query as chips (each opens the existing tag, member, date pickers), then Private/Shared. Also "Save as view" from the My tasks tag filter, from Everyone's tasks' filters, and from a palette search that uses filters.
B8. **Any member** may create, edit, archive and delete a shared view (like tags); the view records its creator. Private views are their creator's only.
B9. **Sidebar:** each org's section gets "Views" under Everyone's tasks: shared and private views mixed, in **each member's own order** (drag, like orgs; a new view goes to the end), with an open-task count. Icons: `#` for a project view, `⌕` (search) otherwise.
B10. **Archive:** an archived view leaves every sidebar; Org settings → Views lists archived views to restore or delete. The tag is untouched.
B11. **Tags and views:** a renamed tag follows (views store tag ids); merged tags are remapped; a deleted tag is removed from every view's query (a project view may thereby become a plain view).
B12. **Reach:** phones (views in the view switcher after Everyone's tasks; the chips in a sheet), the palette ("Go to view …", "Save as view"), the CLI (`rooster view ls`, `rooster ls --view <name>`), the TUI (views in its view bar), MCP (`list_tasks {view}` and `list_views`).
B13. **Not access control:** the UI and the guide say so where views are shared ("Everyone in Kestrel Lane can see these tasks anyway; a view just gathers them").

### Data model (05) and API (06), sketch
- `saved_view (id, org_id, created_by, shared INTEGER, name 1–60, query TEXT (JSON, zod-validated), archived_at, created_at, updated_at)`; `saved_view_pref (user_id, view_id, position TEXT)` for each member's sidebar order. Both cascade with the org; a member removal deletes their private views and prefs.
- `user.prefs.defaultOrgId` and `prefs.startPage: 'last' | 'all-today'`.
- `GET/POST /orgs/{orgId}/views`, `PATCH/DELETE /views/{id}`, `POST /views/{id}/move` (own order), `POST /views/{id}/archive|restore`, `GET /views/{id}/tasks?completed=` (rows plus open/done counts), `GET /me/views/{today|week|overdue}`. SSE: `['views', orgId]` to the org's members for shared views, the owner for private ones; the task keys already in use invalidate the rows.
- Grants: reading views needs `tasks:read` (rows filtered by the grant's constraints as everywhere); managing them needs `groups:write` (organising lists, like groups). New MCP tools in 11 §5.2.

### Phasing
Part A first (smaller, client-computed, closes Q-01), then Part B. They share the computed-list rendering (sorted sections, editable rows, org chips).

## Considered
- **Projects as containers with their own order (Asana).** Multi-homing and per-project sections compete with My tasks for "where a task lives", and are an explicit non-goal.
- **A project field (Linear: one project per task, with a lead and status).** Cleaner semantics than a tag, but a new concept next to tags; it can grow out of project views if needed, and it's the model that would carry private projects later.
- **Tag sections inside My tasks.** Filing a task under "Juniper" would take it out of "Prio" or "Today": it mixes the two axes.
- **Private projects with their own members.** A second access boundary inside the org; use a separate org instead (ADR 0072 makes moving work there easy).
- **A Home dashboard** (today, inbox counts and project progress on one page): more to design and a second place next to the All views; can come later.
- **All views grouped by organisation:** keeps contexts apart, but the earliest deadline can sit in the third section.
- **A Ctrl/⌘+0 shortcut for All · Today:** not wanted for now; the palette covers it.
