# ADR 0074: All organisations, implementation (Phase 13 Part A)

- Status: accepted
- Date: 2026-11-17
- Implements: ADR 0073 Part A (FR-VIEW-5, WP 13.1–13.2, AC-13.1, AC-13.2, the All organisations half of AC-13.5)
- Code: core `selectAllView`/`allViewCounts` (`views.ts`) and the `^org` token (`dates/tokens.ts`); `TaskService.allView` behind `GET /api/v1/me/views/{view}`; `UserService` (`prefs.defaultOrgId`); web `features/all-orgs/`, `data/all-views.ts`, `routes/_app/all*.tsx`, `features/shell/{sidebar-all-section,all-orgs-mark,start-page}`; CLI `rooster ls --all-orgs`; MCP `list_tasks {allOrgs}`

## Context
ADR 0073 decided what All organisations is. This records what the spec left open while building it.

## Decisions

### Core
1. **Ordering inside a section** is due date and time (timed before untimed on a day), then the org's place in the viewer's sidebar order, then that org's My tasks order (`selectView`'s rank). Sections are the per-org ones merged: Overdue (only when non-empty), Today, or the seven days.
2. **The `^org` token** is `^name` or `^"Org name"`, anywhere in the title like `#tag`, outside backtick escapes. It names an org by whole name or slug, else by a unique prefix of the name, of a later word of the name, or of the slug, ignoring case and accents. Two whole-name/slug matches are ambiguous. A token that names no single org stays text. `^…` counts as an inline token for the tail rules, so `Call the venue fri ^Kes` still reads "fri" as the date (in every list, not only All).

### Server, CLI, MCP
3. **`GET /me/views/{view}`** builds each org's input exactly as the per-org query does (`TaskService.smartViewSource`, shared by both), in the order `/me` lists the orgs. Orgs a grant doesn't reach are skipped silently (the view is the actor's, not an org's); rows outside a group-limited grant are dropped after selecting, as in `query()`. Not paged. A grant that reaches none of the actor's orgs still gets the empty day sections, so every client renders the same headings.
4. **`prefs.defaultOrgId`:** `PATCH /me` accepts only an org the user is a member of; a missing, deleted or foreign id gets the same `422` (no existence oracle). `GET /me` returns null for a stored org the user left, or one the grant doesn't reach; the stored value is kept until the next write. Choosing Personal stores null.
5. **CLI:** `rooster ls today|week|overdue --all-orgs` is one request and one listing with the web's section headings; `--group` keeps the old per-org loop (a group is one org's); `--json` stays a flat array in section order; a `404` (older server) falls back to the per-org loop. **MCP** `list_tasks {allOrgs: true}` is refused with another view or with `org`/`group`; each row names its org; the skill's daily planning reads today with `allOrgs`.

### Web
6. **Shown from the second org on.** With only Personal, All organisations would repeat Personal's views, so the sidebar section, the phone sheet entry and swipe stop, the palette entries and the whole Behaviour section (default organisation, start page) appear only with two or more orgs (`hasAllOrgs`).
7. **Data:** the sections come from the per-org `['my-list', orgId]` caches (prefetched for every org at start), so All organisations works offline and has no query of its own. The summed badges use `useQueries` over the same caches with a structurally shared result.
8. **Editing across orgs:** `MyListView` is split into a per-org wrapper and a shared `ListViewCore`, which the new `AllListView` also renders, so keys, selection, popovers, the bulk bar and the phone chrome stay one implementation (the keymap is unchanged). `AllListController` extends `ListController`: it reads all orgs as one merged state for navigation and selection, splits every op by its task's org (a bulk op becomes one op per org, each queued under its own org), and records the parts as one undo entry (`UndoEntry.more`). Commands that belong to one org (titles with their tokens, new tasks, tags, assignment, Move to group, Make subtask of) go to that org's own controller.
9. **Mixed selections:** tags, Move to group and Assign work on tasks of one org at a time; with a mixed selection the shortcut says so in a toast and the bulk bar hides those actions. Move to organisation stays in the pane. The ⋯ menu has Show completed and Print (export is per org); there is no tag filter.
10. **Inline add:** the new row's chip shows the target org (dashed, "Goes to <org>" for screen readers): the default org, or the one a resolved `^org` names. Picking from the `^` suggestions inserts `^FirstWord` when that word names one org, else `^"Full name"`. Pasted lines all go to the chip's org. `>Group`, `#tag` and `@name` resolve against the target org; a typed date phrase wins over the section's date. A subtask (S) goes to its parent's org.
11. **Rows** show the org's avatar and name (avatar only on phones) before the group chip; the accessible name includes "in <org>".
12. **The pane** opens at `/all/t/<id>` over the last All view. A task in no cached list opens under the default org and the pane then follows it to its real org, with the URL staying on `/all`. The pane's tag picker offers only its task's org's tags.
13. **The All mark** is a neutral square (`bg-bg-muted`, Lucide `LayoutGrid`) the size of an org avatar, used in the sidebar, the phone switcher and its sheet. The sidebar section has a muted label, not a heading (heading order), and no menu, drag or collapse. On phones it is the first entry of the org sheet and the first stop of the swipe order (its dot counts); switching from All to an org keeps Today, Next 7 days or Overdue, and from an org to All lands on the same view or Today. On `/all` the ⋯ menu drops Organisation settings, and the bottom nav's My tasks tab shows as active.
14. **Start page:** "The last view" is the last list view (`/o/<slug>/<view>` or `/all/<view>`, never the pane, settings or inbox) shown in this browser, stored per user with `userStorageKey` and swept on sign-out. `/` uses it when it passes `safeRedirectPath`, has a list view's shape and names an org the user is still in; otherwise Personal → My tasks. The choice reads the cached `/me` and fetches it only when there is none.

## Consequences
- The list controller now knows that rows may come from several orgs (`orgIds`, `orgOfTask`, `scoped`, `refuseAcrossOrgs`, `titleScope`, `orgChoices`); a new command that touches more than one task must route by org there.
- Part B (views and project views) reuses the merged rendering and the org-aware controller hooks.
