# 02: UX & Interaction Specification

This document defines **exact behaviour**. Visual styling (sizes, colours, type) is in [03-design-system](03-design-system.md). Any interaction not covered here should follow the principle *"the list is a text editor"*, then common task-manager conventions.

## 1. Principles

1. **No modals for everyday work.** Creating, renaming, dating, tagging, moving and completing all happen in the row or in a small anchored popover. Modal dialogs are allowed only for destructive, irreversible actions (deleting an org) and first-run flows.
2. **Keyboard-complete.** Every action is reachable by keyboard, and every keyboard action has a pointer and touch equivalent.
3. **Optimistic and instant.** Every mutation is applied locally within 16 ms (one frame) and synced in the background. A spinner never blocks typing.
4. **Forgiving.** Everything destructive is undoable (toast plus Ctrl/Cmd+Z). Empty, never-titled rows are never persisted.
5. **Exact order.** Nothing re-sorts the user's groups or tasks unless the user moves something.
6. **One concept per surface.** The list holds titles and dates. The pane holds everything else.

## 2. Screen anatomy (desktop ≥ 1200 px)

```
┌──────────────┬─────────────────────────────────────────┬───────────────────────────┐
│ Sidebar 248  │ Main                                    │ Detail pane 520 (split)   │
│ ───────────  │ ┌ Header ─────────────────────────────┐ │ ┌ Toolbar ──────────────┐ │
│ 🐓 rooster   │ │ My tasks · Personal   [filter] [⋯]  │ │ │ ✓ Complete  🔗 ⤢ ⋯ ✕  │ │
│ 🔍 Search ⌘K │ └─────────────────────────────────────┘ │ ├───────────────────────┤ │
│ 🔔 Inbox  3  │  ▾ Inbox                           2    │ │ Parent › Breadcrumb   │ │
│              │     ◯ Task assigned by Anna     Today   │ │ Title (multi-line)    │ │
│ PERSONAL   ⋯ │  ▾ Today                           3    │ │ Assignee   (A) Alex   │ │
│ › My tasks   │     ◯ Reply to Anna  #mail      Today   │ │ Due date   Fri, 14:00 │ │
│   Today    4 │     ◯ Book dentist            Tomorrow  │ │ Repeat     —          │ │
│   Next 7 d   │     + Add task                          │ │ Tags       #mail      │ │
│   Overdue  1 │  ▾ Prio                            2    │ │ Description           │ │
│   No date    │     ◯ Write Q4 plan   ▸ 2/5     Oct 12  │ │ Subtasks              │ │
│ WORK       ⋯ │     ◯ Renew passport                    │ │ Attachments           │ │
│   My tasks 7 │     + Add task                          │ │ ── Activity ───────── │ │
│   …          │  ▸ Upcoming                       12    │ │ Comment box (sticky)  │ │
│   Everyone   │  + Add group                            │ └───────────────────────┘ │
│ ───────────  │                                         │                           │
│ (A) Settings │                                         │                           │
└──────────────┴─────────────────────────────────────────┴───────────────────────────┘
```

- **Sidebar.** It contains:
  - The logo, Search (opens the palette) and the Inbox (notifications, from P6) with an unread count.
  - Then one **section per org**, in user order, draggable. The org header has an avatar, the name, and a "⋯" menu (org settings, invite, collapse).
  - Under each org: My tasks (open count), smart views (Today with a count, Next 7 days, Overdue with a red count only when > 0, No date), and Everyone's tasks (shared orgs only).
  - At the bottom: the user menu (settings, language, sign out).
  - The sidebar collapses to a 56 px icon rail with Ctrl/Cmd+\\ or the collapse button. The state is persisted.
- **Header.** It shows the view title, the org name in muted text, a filter button (tags, show completed), and a "⋯" menu (add group, show completed, collapse all, expand all, export, print).
- **The current org and view are reflected in the URL:**
  - `/o/:orgSlug/my`
  - `/o/:orgSlug/today`
  - `/o/:orgSlug/week`
  - `/o/:orgSlug/overdue`
  - `/o/:orgSlug/nodate`
  - `/o/:orgSlug/everyone`
  - `/o/:orgSlug/t/:taskId` (pane over the last list view, or over `my` on a direct load)
  - `/inbox`
  - `/settings/...`
  - `/admin`
- Ctrl/Cmd+1…9 switches to My tasks of org number N in sidebar order.
- **Scroll position.** Another page, settings section, guide page or list view opens at its top; Back and Forward return to where each page was left. The list keeps its place while the pane opens, follows the cursor and closes over it, and another task opens the pane at its top. Side menus (settings sections, the guide's pages) stay pinned below the header while the page scrolls, and the content column keeps the scrollbar's room on short pages, so it does not shift between sections.

### Breakpoints

| Name | Width | Sidebar | Pane |
|---|---|---|---|
| mobile | < 768 | hidden (org switcher in header, bottom nav) | full-screen sheet |
| tablet | 768–1199 | icon rail by default, expands over the content | overlay from the right (480 px) |
| desktop | ≥ 1200 | expanded by default | split (D-29); overlay if the list would be < 480 px |

## 3. The list: model and modes

### 3.1 Structure

- The list is a sequence of **group headers**, each followed by its **task rows**, then an **"+ Add task" row**. The view ends with an **"+ Add group"** row.
- When a parent is expanded, its subtasks follow it, indented 24 px per level, and end with an "+ Add subtask" row.
- **Accessibility tree:** `role="treegrid"`.
  - Group headers are `row` at `aria-level=1` with `aria-expanded`.
  - Tasks are at `aria-level=2`; subtasks at `aria-level=3` and deeper.
  - Cells: checkbox, title, meta (tags, counters) and due date.

### 3.2 Two modes

| Mode | What has focus | How you enter it | How you leave it |
|---|---|---|---|
| **Navigate** | a row is *selected* (highlighted background, no caret) | Esc from Edit; click on the row padding, checkbox gutter or date gap; ↑/↓ after Esc | Enter, F2 or I starts Edit (caret at the end). Other printable keys are shortcuts or ignored (§6). |
| **Edit** | caret in the title input of a row | click on the title text; Enter, F2 or `I` in Navigate; creating a new task | Esc (commit, then Navigate); click outside (commit); ↑/↓ moves the caret to the adjacent row (stays in Edit) |

The pane (if open) always shows the **selected** row (D-29). Moving the selection with the pane open updates the pane without a route push: the URL is updated with `replace`.

### 3.3 Selection & multi-select

- Click on the row body selects the row and opens the pane. Click on the title selects the row and enters Edit, but does not open the pane.
- Ctrl/Cmd+click toggles a row in or out of the selection.
- Shift+click selects a range. Shift+↑/↓ extends the selection.
- Ctrl/Cmd+A in Navigate selects all tasks in the current group. Pressing it again selects all tasks in the view.
- **With ≥ 2 rows selected**, the pane closes and a **bulk bar** floats at the bottom centre: "3 selected · ✓ Complete · 📅 Date · ↦ Move to · # Tag · 👤 Assign (shared orgs) · 🗑 Delete · ✕". All of these work through popovers. Esc clears the selection.

### 3.4 Creating tasks

| Trigger | Result |
|---|---|
| **Enter** in Edit, title non-empty | Commits the current title and inserts a new empty row **directly below** in the same group (or as a sibling subtask). The caret moves into it. Text after the caret is **not** split off. |
| **Shift+Enter** in Edit | Same, but the new row goes **above**. |
| Enter in Edit, title empty | No-op if the row is new. If it is an existing task whose title was deleted, the old title is restored and a hint "Title can't be empty" is shown. |
| **N** / **Shift+N** in Navigate | New row below / above the selected row. |
| Click **"+ Add task"** (or Enter on it) | New row at the end of that group. |
| **Tab+Q** or **Q** in Navigate | New row at the **top of the first visible group** (Inbox excluded), scrolled into view. |
| **Ctrl/Cmd+V** of multi-line text into an empty title | Inline chip: "Create 5 tasks? ↵". Enter creates one task per non-empty line in order. Esc pastes the text as one line. |

**Draft rows.** A new row is a *draft* until its title is non-empty and committed (Enter, Esc, blur or ↑/↓). Drafts are never sent to the server. A draft that loses focus while empty disappears silently. This prevents stray empty tasks.

**A draft's date.** A draft has its date cell, with the calendar icon showing while the row is edited. Clicking it or pressing Tab+D opens the date popover without committing the title: the title stays in edit, and the caret returns to it when the popover closes. The date is applied when the task is created; a date phrase in the title still wins. The draft's popover has no Repeat or Reminders section (type `every mon` or `!1h` instead). On phones, tapping the calendar or the accessory bar's date button (§13.3) opens the date sheet instead, with the same effect.

**Context inheritance.** A new task inherits the **group** and assignee (me) of its position. In a smart view, a new task inherits the view's date: creating in *Today* sets the due date to today, in *Next 7 days → Wed* it sets Wednesday, and *No date* leaves it empty. It goes into the **Inbox** unless a group is chosen via `>Group` (below).

**Inline title tokens** (parsed on commit, highlighted while typing, each cancellable by clicking its highlight or by pressing Backspace directly after it):
- Date phrases: §8.
- `#tag`: adds a tag. Shows an autocomplete popover; the tag is created if new.
- `@name`: assign (shared orgs, P6). Autocompletes from org members.
- `>Group`: only in smart views and in the CLI. Places the task in that group.
- `!` alone at the end is *not* special; no priorities exist.
- Escape hatch: wrap literal text in backticks, e.g. `` `next week` ``, to prevent parsing. The backticks are stripped.

### 3.5 Editing & deleting

- **Title commits** on Enter, Esc, blur or ↑/↓. A commit is a no-op when the title is unchanged.
- **Backspace on an empty title** (the caret is in an empty title and the title was *already empty before this keypress*):
  - If the row is a draft, or a task with no description, subtasks, comments or attachments: delete it, move the caret to the end of the previous row's title, and show an undo toast.
  - Otherwise: do nothing, and show the hint "Use Tab+Delete to delete tasks with content".
  - Holding Backspace (auto-repeat) never deletes more than **one** row. Auto-repeat `keydown` events with `event.repeat === true` are ignored for row deletion.
- **Tab+Delete / Tab+Backspace** (Edit or Navigate), or **Delete** in Navigate: soft-deletes the selected task(s) and shows an undo toast "Task deleted · Undo".

### 3.6 Completing

- Triggers: click the checkbox, **Ctrl/Cmd+Enter** (Edit or Navigate), or swipe right on mobile.
- Sequence:
  1. The checkbox fills with the success colour and plays a 300 ms "pop".
  2. The title gets a strikethrough with a `--dur-fast` transition.
  3. The row holds for **1.5 s** (setting: 1.5 s / 3 s / until reload).
  4. The row height collapses over `--dur-slow` (250 ms).
  5. The toast reads "Completed 'Book dentist' · Undo".
- Completing again during the hold window un-completes the task. Undo restores the task to its exact position.
- Completing a parent with open subtasks completes the parent only. The toast adds "2 open subtasks" with no action.
- **Show completed** (header toggle, or `Shift+H`): completed tasks render in place at 60 % opacity with strikethrough. Their checkbox un-completes them.

### 3.7 Undo

- A session-scoped undo stack holds the last 50 user operations. Ctrl/Cmd+Z undoes; Ctrl/Cmd+Shift+Z or Ctrl+Y redoes.
- Undo applies to: create, title edit, date change, move, complete, delete, group create/rename/delete/move, and tag add/remove.
- While a text input has focus with local text history, Ctrl/Cmd+Z is handled by the input (native text undo). Only in Navigate, or when the input has no further native history, does it go to the app stack.
- Undo is implemented as **inverse mutations** sent through the normal mutation pipeline, so it works offline too.

## 4. Groups (sections)

| Action | Interaction |
|---|---|
| Create at the cursor | **Tab+N** (Edit or Navigate) inserts a new group header **directly below the selected task**. The tasks below the cursor in the same group move into the new group, splitting the group (shown in the undo toast). With a group header selected, or on its last task, it creates an empty group after the current one. The caret is placed in the new group's name. |
| Create via a colon | Typing a task title that ends with `:` and pressing Enter shows an inline chip "↵ again to turn into group 'Prio'". A second Enter converts the row into a group header at that position, splitting the group as above. Any other key dismisses the chip and creates a normal task. Implementation details:<br>• **On a draft** (most common): the client sends only `POST /groups` with `{name, splitAfterTaskId: <task above>}`.<br>• **On an existing task:** the client sends `POST /groups` with `{splitAfterTaskId: <the task>}`, then `DELETE /tasks/:id`.<br>Either way, the client records **one** undo entry whose inverse ops restore the task and delete the group (moving the split tasks back). |
| Create at the end | Click "+ Add group" at the bottom of the list. |
| Rename | Click the group name, or F2 with the header selected. Enter or blur commits; Esc cancels. |
| Collapse / expand | Click the chevron, or ←/→ with the header selected. Alt+click collapses or expands **all** groups. The state is persisted per user. |
| Reorder | Drag the header (see §5). In Navigate with the header selected, Ctrl/Cmd+↑/↓ moves the whole group. |
| Delete | Header "⋯" → Delete. An empty group is deleted immediately with an undo toast. A non-empty group opens an anchored popover with radio options: "Move 7 tasks to: [group ▾]" (default: the group above, or the one below for the first group) or "Delete the tasks too"; a [Delete group] button; and Esc to cancel. |
| Header content | Chevron · name · open-task count (muted, tabular) · on hover: "+" (add task at top of group), "⋯" (rename, add group below, delete, collapse others). |

**Inbox.** A system group with a light accent tint background on its header and a 📥 icon.
- It is rendered first and only when it has ≥ 1 open task.
- It has no rename, delete or move. Tasks can be dragged out of it, and can be dragged into it; doing so is unusual but allowed.
- Header hint: "Triage: drag tasks into your groups".

## 5. Drag and drop

| Aspect | Spec |
|---|---|
| Library | dnd-kit (`@dnd-kit/core` + `@dnd-kit/sortable`) behind an internal `useListDnd()` hook, so the library can be swapped (see 04). |
| Grab | **Mouse:** press on the 6-dot handle (visible on row hover, 16 px left of the checkbox) **or** anywhere on the row except the title input in Edit mode, the checkbox, the date cell or chips; drag starts after **4 px** of movement. **Touch:** long-press **350 ms** anywhere on the row (with a haptic pulse via `navigator.vibrate(10)` where supported), then drag. **Keyboard:** focus the handle (Tab from the row in Navigate), press Space to lift, ↑/↓ to move, Ctrl+↑/↓ to jump groups, Space to drop, Esc to cancel. |
| Drag preview | The row lifts with `shadow-lg`, 2° rotation (pointer only), 95 % opacity, and the width of the original row. In a multi-drag, a stacked-card look with a count badge "3". |
| Drop indicator | A 2 px accent line with an 8 px ring at its left end, at the insertion gap, indented to the target level. The original row stays as a 40 % opacity placeholder. |
| Targets | Between tasks in any group, including collapsed groups: hovering a collapsed header for 600 ms expands it, and dropping on the header itself inserts at the **top** of that group. Subtasks can only be reordered among their siblings. |
| Moving groups | Dragging a group header **temporarily collapses all groups** to headers during the drag, so the move is easy, then restores their state. The Inbox cannot be moved. |
| Auto-scroll | Within 64 px of the scroll container edge, with speed proportional to proximity. |
| Disabled | Smart views and Everyone's tasks, which are sorted views. Grabbing shows a tooltip "Sorted view: drag in My tasks". |
| Commit | On drop, the client sends `move` with the `{groupId, beforeId, afterId}` intent (see 06). The optimistic position is computed locally with the same fractional-index library. The server's key replaces it on response. |
| Announcements | A live region announces, for example, "Picked up Book dentist. Position 2 of 3 in Today.", "Moved to Prio, position 1 of 2." and "Drop cancelled." |

**Keyboard moves** (no drag needed; selection-aware, so they work for multi-selection):

| Keys | Move |
|---|---|
| Ctrl/Cmd+↑ / ↓ | Up or down one position (crossing group boundaries at the edges) |
| Ctrl/Cmd+Shift+↑ / ↓ | To the end of the previous group / the start of the next group |
| Alt+Shift+↑ / ↓ | To the top / bottom of the current group |
| **M** or Tab+M (Navigate) | "Move to…" popover: a filterable group list with digit shortcuts 1–9 |

## 6. Keyboard reference

The Mac uses ⌘ where Ctrl is listed.

- **Tab chords:** while **Tab is held**, pressing another key triggers the chord. Releasing Tab without another key keeps native Tab behaviour. Within the list, the tab order per row is **drag handle → title → date cell**, then the next row's drag handle. The handle is a focusable button that is visually hidden until focused or hovered.
- **Focus wins:** keys act on the focused element first. Delete or Backspace with the **date cell** focused clears the date. With the row (or title in Navigate) focused, they delete the task.
- **Single keys** work only in Navigate (no text input focused).

### Global (modifier chords only, work even while typing)
| Keys | Action |
|---|---|
| Ctrl+K | Command palette / search |
| Ctrl+\\ | Toggle sidebar |
| Ctrl+1…9 | Go to My tasks of org N |
| Ctrl+Z / Ctrl+Shift+Z | Undo / redo (see §3.7 for text inputs) |

### Navigate-only app keys (never fire while a text input has focus)
| Keys | Action |
|---|---|
| / | Focus search (palette in search mode) |
| ? | Shortcut cheat sheet (overlay, non-modal, Esc closes) |
| G then M / T / W / O / N / E / I / S | Go to My tasks / Today / Next 7 days / Overdue / No date / Everyone / Inbox / Settings |

**G is a reserved prefix.** After G, the next key within 1 s is interpreted as the sequence's second key, and the single-key actions for M, T, W, O, N, E, I and S are suspended. G followed by any other key, or by a timeout, does nothing. Printable keys never start Edit implicitly: only Enter, F2 and I enter Edit (this replaces the "typing a printable character" rule in §3.2).

### List: both modes
| Keys | Action |
|---|---|
| Enter / Shift+Enter (Edit) | New task below / above |
| Ctrl+Enter | Complete or uncomplete the selected task(s) |
| Ctrl+↑↓, Ctrl+Shift+↑↓, Alt+Shift+↑↓ | Move (§5) |
| Tab+N | New group at the cursor |
| Tab+Q | Quick add at the top |
| Tab+D | Date picker |
| Tab+T | Add tag |
| Tab+A / Tab+M | Assign (P6) / Move to group |
| Tab+S | Add subtask (expands the parent, new subtask draft) |
| Tab+R | Focus the description in the pane |
| Tab+C | Focus the comment box (P6) |
| Tab+Enter | Open the pane and focus its title |
| Tab+X | Pane full screen |
| Tab+Delete | Delete |
| Ctrl+D | Duplicate |
| Esc | Edit → Navigate → close the pane → clear the selection |

### List: Navigate only (single keys)
| Keys | Action |
|---|---|
| ↑/↓ or K/J | Move the selection (rows and group headers) |
| ←/→ | Collapse or expand (group or parent task); → on an expanded parent selects its first subtask |
| Enter, F2, I | Edit the title (caret at the end) |
| N / Shift+N | New task below / above |
| Q | Quick add |
| Space | Peek: toggle the pane for the selection without moving focus |
| O | Open the pane and move focus into it |
| X | Toggle the selected row in the multi-selection |
| D | Date picker |
| T or # | Tag picker |
| A | Assign (P6) |
| M | Move to group |
| S | Add subtask |
| C | Add comment (P6) |
| Delete / Backspace | Delete (with undo) |
| Shift+H | Toggle show completed |
| Home / End | First / last row |

The **cheat sheet** (`?`) is generated from the same keymap registry that dispatches the keys (`apps/web/src/keymap.ts`). Keys are never documented in two places.

## 7. Due-date cell & date picker

- **Cell.** The cell is right-aligned, 112 px wide, and shows the relative label (§8.3).
  - Empty cell: no text. On hover, a muted calendar icon appears; also while a draft is edited (§3.4).
  - Click, Tab+D or D opens the **date popover** anchored to the cell.
- **Date popover** (320 px wide), from top to bottom:
  1. A text input with autofocus and the placeholder "Type a date… (e.g. fri, next week, 12 oct)". A live preview below it reads "→ Fri, Oct 10" or "Can't understand that".
  2. Quick chips: Today · Tomorrow · Next week · Weekend · No date. Each chip has the hint **Alt+T, Alt+M, Alt+W, Alt+E, Alt+0** (⌥ on macOS, matched by `event.code`). Plain letters always go to the text input.
  3. A month calendar with ←/→ month navigation. Today is ringed and the selected date is filled with the accent. Arrow keys move the day when the calendar has focus. The week starts on the user's setting.
  4. Footer toggles: "+ Time" (reveals an HH:MM input with 15-minute suggestions), "+ Start date" (switches the calendar to range mode), and (P10) "↻ Repeat" (presets plus Custom) and "🔔 Reminder" (**Alt+R**).
  5. (P10, FR-REM) **Reminder section:** the task's reminders as removable chips ("1 h before · Fri 13:00"), then presets: *At due time* (timed tasks), *15 min before*, *1 hour before*, *1 day before*, *On the day at 09:00* (all-day tasks; the user's default reminder time), and *Custom…* (an offset, or a date and time). The input also accepts the title tokens (`15m`, `1h`, `1d`, `due`) and phrases like "fri 14:00". Without a due date only absolute reminders are offered. Choosing a reminder keeps the popover open, like the Time sub-mode; Esc or a click outside closes it.
- **Commit rules:**
  - Clicking a calendar day, clicking a chip, or pressing Enter in the input with a valid parse **sets the date and closes the popover** immediately.
  - Exception: when the Time or Start date sub-mode is active, the popover stays open until Enter or a click outside.
  - Esc closes without changes.
- **Clearing:** the "No date" chip, or Backspace/Delete on a **focused date cell** (with undo). See "Focus wins" in §6. Clearing the date also pauses relative reminders (FR-REM-2); the undo toast says so, and undo restores the date and with it the reminders.
- **Detail pane (P10):** a "Reminders" line under the due date lists the user's reminders with their resolved times and an "Add reminder" button that opens the same reminder section.
- **Phone (P10):** the date sheet has the same reminder section, below the calendar.

## 8. Natural-language dates

### 8.1 Behaviour

- Parsing runs on every keystroke, debounced 50 ms, in `packages/core/src/dates/parse.ts`, which is pure, deterministic, takes a `now` and settings, and is unit-tested per phrase.
- **Position rule in titles.**
  - Weekday, relative (`in 3 days`, `next week`, `om 2 veckor`) and recurrence phrases match only at the **end of the title**, optionally followed by a time phrase or other tokens (`#tag`, `>Group`, `@name`). So "Call Bob mon" parses, but "Mon Repos hotel booking" does not.
  - Unambiguous phrases (`today`, `tomorrow`, `idag`, `imorgon`, explicit dates like `12 oct`, ISO dates) may appear anywhere.
- In the **title**, the *last* matching phrase is highlighted with an accent-tinted background and 2 px radius. On commit the phrase is removed from the title (whitespace collapsed) and applied.
- Clicking the highlight, or pressing Backspace immediately after the phrase, marks it *ignored* for this edit. It renders as normal text and is not reparsed.
- The **title-parsing grammar** is the user's UI language **plus English full words**. Abbreviations are only active for the UI language. For example, `tom` means tomorrow only when the language is English, because in Swedish *tom* means "empty".
- Title parsing can be disabled in Settings. The **date picker input always parses** both languages fully.

- (P10) **Reminder token in titles:** `!15m`, `!2h`, `!1d` (that long before the due moment) and `!due` (at the due moment), at the end of the title like the relative phrases, in any order with `#tag`, `>Group` and `@name`. It is highlighted like a date phrase, removed on commit and applied as a relative reminder (FR-REM). A bare `!` or `!` followed by anything else is plain text, so "Ship it!" stays a title.

### 8.2 Grammar

Matching is case-insensitive, on word boundaries. *Weekday* means the next occurrence **after today**; `this <weekday>` includes today.

| Meaning | English | Swedish |
|---|---|---|
| today | today, tod | idag, i dag |
| tomorrow | tomorrow, tom, tmr | imorgon, i morgon, imorn |
| day after tomorrow | — | i övermorgon, övermorgon |
| weekday | monday…sunday, mon…sun, next mon, this fri | måndag…söndag, mån…sön, nästa måndag, på fredag |
| next week | next week (= next week-start day) | nästa vecka |
| weekend | weekend, this weekend (Sat), next weekend | i helgen, helgen, nästa helg |
| next month | next month (1st) | nästa månad |
| relative | in 3 days, in 2 weeks, in 1 month, +3d, +2w, +1m | om 3 dagar, om 2 veckor, om en månad |
| explicit | oct 12, 12 oct, october 12th, 2026-10-12, 12 oct 2027 | 12 okt, 12 oktober, den 12 oktober, 2026-10-12 |
| end of period | end of week, end of month, eow, eom | slutet av veckan, slutet av månaden |
| time suffix | at 14, at 14:30, at 2pm, @ 9am | kl 14, kl. 14.30, klockan 9 |
| recurrence (P10) | every day, daily, every weekday, every mon, every mon and thu, every 2 weeks, every month, every month on the 15th, every last fri, every year, every 3 days after done | varje dag, dagligen, varje vardag, varje måndag, varannan vecka, var tredje dag, varje månad, den 15:e varje månad, varje år, var 3:e dag efter klar |

- Explicit dates without a year resolve to the **next** occurrence (today or later).
- Numeric slash dates (`12/10`) are accepted **only in the picker**, interpreted per the user's date format. They are never parsed in titles (to avoid matching "1/2 cup").

### 8.3 Display (relative labels)

| Condition | EN | SV |
|---|---|---|
| today | Today | Idag |
| tomorrow | Tomorrow | Imorgon |
| yesterday | Yesterday | Igår |
| within the next 2–6 days | Fri | fre |
| other date, current year | Oct 12 (or 12 Oct, per setting) | 12 okt |
| other year | Oct 12, 2027 | 12 okt 2027 |
| with a time | Today 14:00 / Fri 2 PM | Idag 14:00 |
| with a start date | Oct 10 – 12 / Oct 30 – Nov 2 | 10–12 okt |

Colours and icons follow 03 §Due-date semantics. A tooltip on hover shows the full date ("Friday, 10 October 2026, 14:00").

## 9. Detail pane

### 9.1 Behaviour
- It opens per FR-DET-1. On desktop it **splits** (D-29), slides in over 180 ms, and its width is resizable by dragging its left edge (400–720 px, persisted).
- Focus: `O` and Tab+Enter move focus into the pane's title. A click opens the pane while focus stays on the list.
- Esc inside the pane returns focus to the list. Esc again closes the pane.
- **Full screen** (Tab+X or ⤢): the pane takes the main area and the sidebar stays. Esc returns to the split.
- Navigating to another task with the pane open crossfades the content (120 ms). Unsaved edits are committed first.
- **Deep link** `/o/:org/t/:id`: if the task isn't in the current view (for example a task assigned to someone else), the pane opens over My tasks and no row is selected.

### 9.2 Layout (top to bottom)

1. **Toolbar:** [✓ Mark complete] (a button that turns into "✓ Completed" in the success tint), 🔗 copy link, ⧉ duplicate, ⤢ full screen, ⋯ (delete, copy ID, open in new tab, move to group), ✕ close.
2. **Breadcrumb:** the parent chain, as clickable links (subtasks only).
3. **Title:** a 24/32 semibold textarea that auto-grows. Enter commits; Shift+Enter is ignored, because titles are single-line.
4. **Property grid** (label column 112 px, muted 13 px labels; values are inline-editable controls that open the same popovers as the row):
   - Assignee (shared orgs)
   - Due date
   - Repeat (P10)
   - Group (mine only, a select)
   - Tags (chips + "+")
   - Created (muted text: "Created by Anna · 3 days ago")
5. **Description:**
   - A Tiptap editor with the placeholder "Add more detail…".
   - Markdown shortcuts work (`# `, `- `, `[] `, `**`, `` ` ``, ``` ``` ```).
   - The floating bubble toolbar on selection has B, I, S, code, link, H, list and checklist.
   - Links: a plain click places the caret, so a link's text can be edited; **Ctrl+click** (⌘+click on a Mac) opens it in a new tab. Holding the modifier shows the pointer cursor on links, and each link has a "Ctrl+click to open" tooltip. The toolbar's "Open link" button (Mod+K inside a link) is the keyboard path. On touch screens, a tap on a link places the caret and shows a link card under it: the address (which opens the link in a new tab), **Edit** and **Remove** (ADR 0062). Read-only descriptions open links on a plain click.
   - When the description exceeds 12 lines it collapses, with "Show more"; editing expands it.
6. **Subtasks:**
   - A header "Subtasks 2/5" with "+".
   - The same row component as the list, in compact mode. Same keyboard model, and drag reorders within the list.
   - "+ Add subtask" row.
7. **Attachments** (P10): a thumbnail grid plus file rows. The whole pane is a drop zone.
8. **Activity** (P6):
   - A "Comments only / All activity" toggle.
   - A chronological feed: avatar · name · relative time · body.
   - The **comment composer is sticky** at the bottom of the pane: a placeholder, @mention autocomplete, and Ctrl+Enter or Tab+Enter to post. Followers are listed as an avatar stack with a "Follow" toggle next to the composer.

### 9.3 Save states
A tiny status label sits in the toolbar's left area:
- "Saving…" (only if > 300 ms)
- "Saved"
- "Offline · will sync" (an amber dot)
- "Couldn't save · Retry" (danger)

## 10. Smart views

- **Today**:
  - Section *Overdue* (sorted by due date ascending) and a section for today, labelled with the date ("Friday, Oct 9"), because the view's title already says Today.
  - Rows show their **group name as a muted chip** in place of tags overflow.
  - Inline add creates with due = today in the Inbox (with a `>Group` token to override).
- **Next 7 days:** one section per day (Today, Tomorrow, then weekday plus date) for 7 days. Dropping is disabled; use D to re-date.
- **Overdue:** a single flat section.
- **No date:** a flat list of My tasks with no due date, sorted by group order and then position (it mirrors the My tasks order).
- All smart views include **subtasks assigned to me** as rows with breadcrumbs. They exclude completed tasks unless "Show completed" is on.

## 11. Everyone's tasks (P6)

- Sections per assignee: me first, then other members alphabetically, then *Unassigned*. Each section header has an avatar, name and open count.
- Rows are sorted by due date (no-date tasks last), then created date.
- Filters: tag, due (any, overdue, this week, no date), and a member multi-select.
- Inline add under a member creates a task assigned to them, which lands in their Inbox. The toast reads "Added to Anna's Inbox".
- Reassigning by drag between member sections **is** allowed. It is the only drag in this view, and it is an assignment change, not an ordering change.

## 12. Command palette (Ctrl+K)

- It is a centred floating panel, 640 px wide and 60 % of viewport height at most. It is non-modal: the backdrop is transparent and a click outside closes it.
- **Empty query:** recent tasks (the last 8 opened), followed by Actions (contextual for the current selection).
- **Typing** searches tasks (FTS, 150 ms debounce) and fuzzy-matches actions.
  - Prefix `>` limits to actions only.
  - Prefix `#`, `@` or `due:` applies a filter.
- Results show the title, the group or org chip, and the due label. Enter opens the task (navigating to its org) and selects it in the list.
- After the tasks, a **Help** section lists the five best-matching sections of the user guide (ADR 0058), unless the query is `>` or filters tasks (`#`, `@`, `due:`, `is:`). Enter opens the page at that heading.
- The palette is fully usable offline over cached data, using client-side filtering of cached tasks.

## 13. Mobile (< 768 px)

### 13.1 Frame
- **Header (56 px + safe area):**
  - The org switcher button on the left: avatar, org name and ▾. It opens a bottom sheet listing the orgs, with "Create org". A sideways swipe on it moves to the next or previous org, with dots under the name for the position, and press-and-slide (hold, slide to an org in the sheet, lift) picks any org. A switch keeps the view where the other org has it (ADR 0063).
  - Centre: nothing.
  - Right: the offline/sync pill (when relevant) and ⋯.
- **View switcher:** a horizontally scrollable segmented control below the header: My tasks · Today · 7 days · Overdue · No date · Everyone. It sticks to the top while scrolling.
- **Bottom nav (64 px + safe area):** My tasks · Search · Inbox (badge; added in P6) · Settings. Icons with labels; the active tab is shown in the accent colour.
- **FAB:** a 56 px accent (amber) circle with "+", 16 px above the bottom nav at the right. It is hidden while the keyboard is open.

### 13.2 Rows & gestures
- Row height 52 px. The checkbox hit area is 44×44. Title on one line with an ellipsis. Date label on the right.
- Tag chips: at most 1 is shown, plus "+2".
- **Tap the row:** opens the detail sheet. **Tap the checkbox:** completes the task.
- **Swipe right** (≥ 30 % of the width, or a fling): Complete. The green background reveals ✓ and the row collapses. Undo is available in the snackbar.
- **Swipe left:** the **quick date sheet** (Today, Tomorrow, Weekend, Next week, Pick date…, No date).
- The swipe actions can be configured in Settings: each direction is Complete / Date / Move / Delete.
- **Long-press 350 ms:** lifts the row for dragging (with haptics). Dragging near the top or bottom auto-scrolls. Dropping commits.
- Long-press then release without moving enters **selection mode**: checkboxes turn into selection circles and a bulk action bar replaces the bottom nav.
- Pull to refresh: refetch plus outbox flush. The spinner turns until both settle, and for at least 0.5 s, so a fast refetch still reads as a refresh.

### 13.3 Inline creation on mobile
- Tapping the FAB inserts a draft row **at the top of the first visible group** (or of the current smart view section), focuses it, and opens the keyboard.
- An **accessory bar** sits directly above the keyboard (positioned using `visualViewport`):
  - [📅 Date] [▤ Group: Today ▾] [# Tag] [↵ Next].
  - "Next" (the keyboard's Enter) creates the task and opens another draft below; the keyboard stays open.
  - Tapping outside or swiping the keyboard down commits and ends.
- The "+ Add task" row at the end of each group works the same way.
- NL date highlighting works exactly as on desktop.

### 13.4 Detail sheet
- A full-screen sheet that slides up (250 ms). Close it with a swipe down from the top drag handle area, the ‹ back button, or the system back gesture (the sheet is a history entry).
- Content is the same as the pane (§9.2), in a single column. Property rows are 48 px tall and open bottom sheets in place of popovers.
- The comment composer sticks above the keyboard.

### 13.5 PWA specifics
- `display: standalone`. `theme_color` is the white header. Status bar style `default`. All fixed elements respect `env(safe-area-inset-*)`.
- Installation prompt: a dismissible banner in Settings → "Install app" (and on Android a one-time `beforeinstallprompt` toast after the 3rd visit). On iOS, a tip sheet: "Share → Add to Home Screen".
- **The iOS PWA has its own storage**, so the user signs in again after installing. The onboarding sheet says so explicitly.

## 14. Feedback, empty, loading and error states

| State | Spec |
|---|---|
| First run | My tasks shows the default groups, each empty. The Today group contains a ghost hint row: "Type a task and press Enter ↵". Bottom-right: a "Keyboard shortcuts ?" hint chip, dismissible. |
| Empty group | No rows, only "+ Add task". |
| Empty smart view | A centred illustration (small line-art rooster) with "Nothing due today. 🎉" or the view-specific text. |
| Initial load | Skeleton rows (3 per group, shimmer disabled under `prefers-reduced-motion`). Cached data (IndexedDB) renders instantly if present. Skeletons only appear on a cold start. |
| Offline | The header pill "Offline" (neutral). With pending ops: "Offline · 3 pending" (canonical text). After reconnect it shows "Syncing…" and then disappears. |
| Mutation failed (4xx) | The local change is reverted, with a toast: "Couldn't save 'title' – task was deleted by Anna". |
| Server error (5xx or timeout) | Retried with backoff (1, 2, 4, 8, 16, 30 s, capped). After 3 failures the pill turns amber: "Sync problem · Retry". |
| Toasts | Bottom-left on desktop and above the bottom nav on mobile. At most 3 stacked. Default 6 s, paused on hover. Each toast has at most one action. |

## 15. Accessibility requirements (summary; details in 10)

- WCAG 2.2 AA.
- All interactive elements are reachable by keyboard, with visible focus rings (03 §Focus).
- Every drag action has a keyboard alternative (WCAG 2.5.7).
- Touch targets are ≥ 44 px on mobile, and ≥ 24 px on desktop (WCAG 2.5.8).
- `prefers-reduced-motion` disables the pop, fade-collapse, slide and crossfade animations; changes become instant.
- Screen reader announcements cover: completion, move, delete with undo, sync status changes, and the bulk selection count.
