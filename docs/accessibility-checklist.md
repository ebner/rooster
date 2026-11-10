# Accessibility checklist (manual pass per release)

CI covers the automated part of WCAG 2.2 AA (ADR 0052 §4):
- axe on every screen, on desktop and on phones (`e2e/a11y.spec.ts`, `e2e/a11y.mobile.spec.ts`);
- a keyboard-only journey (`e2e/keyboard-journey.spec.ts`);
- the list's accessible names (`src/features/list/row-name.test.tsx`).

This checklist is the part a machine can't judge: what a screen reader actually says, and whether it makes sense. Run it before each release, in English (the Swedish strings come from the same keys).

**Setup**
- Use a fresh account with a few tasks. One task should be due tomorrow and have 5 subtasks, 2 of them done; add a tag, a reminder and a weekly repeat. Add one overdue task and two groups besides the Inbox.
- Run three passes:
  - **VoiceOver + Safari on macOS**, keyboard only;
  - **VoiceOver + Safari on iOS**, an installed PWA on an iPhone;
  - **NVDA + Firefox on Windows**: browse mode for reading, focus mode for the list.
- Each step below says what to do, then what you should hear (→). The wording may vary by screen reader; the content should not.

**Reporting.** File each finding as a GitHub issue on `ebner/rooster` with the label `a11y`. Give the pass (e.g. "NVDA 2026.3 + Firefox 140"), the step number, what was announced and what was expected. A finding that blocks a task without a workaround is a release blocker.

## 1. Sign in and the shell (all passes)

1. Open `/login` and move through the page. → The page title, then the provider buttons ("Continue with …"). The rooster logo is not read out letter by letter.
2. Sign in, then list the landmarks (VO: rotor → Landmarks; NVDA: `D`). → "Main" navigation (the sidebar; on phones "Primary" and "Views"), the main region, and the task list.
3. Press `?`. → A "Keyboard shortcuts" complementary region. Its section headings can be read, and the list scrolls with the arrow keys once focused. `Esc` closes it and returns focus to where it was.

## 2. My tasks: the tree grid (VoiceOver macOS, NVDA)

1. Tab into the list. → "My tasks, tree grid", then the selected row.
2. Arrow onto the group header "Today". → "Today, group, 3 tasks, expanded" (NVDA may add "heading level 2").
3. `↓` onto "Book dentist". → "Book dentist, due tomorrow, not completed, 2 of 5 subtasks". The tag, reminder ("Reminder: …") and repeat ("Repeats: Weekly on …") follow in browse mode or with VO's "more content".
4. `→` expands the task, and `←` collapses it. → "expanded" / "collapsed". The subtask rows read one level deeper (NVDA: "level 3").
5. `←` on a group header. → "collapsed"; `→` → "expanded".
6. `Shift+↓` twice. → "2 selected", then "3 selected" (polite, not interrupting).

## 3. Editing and the core journey (VoiceOver macOS, NVDA)

1. `Q`, type "Call Bob fri 14:00", `Enter`. → In the edit box: "Task name, edit text". After `Enter`, `Esc` goes back to the row: "Call Bob, due Fri 14:00, not completed".
2. `Tab+S` (hold Tab, press S), type a subtask, `Esc`. → The new subtask row, one level deeper.
3. `↑` back to the parent, then `M`. → "Filter groups, combo box", then the group list. Type "Prio", `Enter`. → Focus is back on the row, now in Prio.
4. `Ctrl+Enter` (⌘+Enter on a Mac). → "Completed “Call Bob”" with an Undo button in a status message. The row says "completed".
5. `Ctrl+Z`. → "Undone: …", and the row is "not completed" again.
6. `Ctrl+↓` moves the task. Its new position is announced once the list settles, and focus stays on the task.
7. Drag handle by keyboard: Tab to "Move Call Bob, Drag handle", `Space`. → "Picked up Call Bob. Position x of y in Prio." Then `↓`. → "Call Bob is at position …". `Space` → "Moved to Prio, position …". `Esc` instead → "Drop cancelled."
8. `D` on a row. → A "Due date" dialog, with focus in "Type a date". `Alt+R` opens Reminders and `Esc` closes the dialog, returning focus to the row.
9. `Delete` on a row. → "Task deleted" with Undo. `Ctrl+Z` brings the task back.

## 4. Detail pane, palette, inbox, settings (VoiceOver macOS, NVDA)

1. `O` on a task. → A complementary region named after the task, with focus on the title field. Read on: the description editor ("Description"), subtasks (a tree grid "Subtasks"), attachments (each file's name and size, then "Download" and "Delete"), comments and activity in order, and the comment box.
2. `Esc`. → The pane closes, and focus is on the same row.
3. `Ctrl+K`, type "dent". → "Search tasks and actions, combo box", and the results are announced as you arrow ("Book dentist, Today, Tomorrow"). `Enter` opens the task.
4. `G I`. → Inbox: each notification reads actor, event, task and time. Comment excerpts are plain text (no `**`). `U` toggles read ("Mark as read" / "Mark as unread").
5. `G S`. → Settings: the "Settings sections" navigation, then the section heading. In Profile, the "Week starts on" radio group changes with the arrow keys, and the change saves without a separate button.
6. Admin (as an admin): every table has column headers, and "Back up now" reports "Backup created".

## 5. Sync status (VoiceOver macOS or NVDA)

1. Go offline (DevTools → Network → Offline) and complete a task. → The status pill announces "Offline · 1 pending".
2. Go back online. → "Syncing…", then the pill clears. Nothing is announced while you type.

## 6. Phone: VoiceOver on iOS (installed PWA)

1. Swipe through the header. → The org switcher button ("Personal"), the view switcher ("Views": My tasks, Today, 7 days, …), then "Sync status". The bottom nav reads "My tasks, Search, Inbox, Settings", and the current tab is announced as the current page.
2. Swipe to "Book dentist". → The same row name as in §2.3. Double-tap opens the detail sheet. The list behind it is not reachable while the sheet is open, and "Back" closes it.
3. The swipe actions (complete, date) have equivalents: in the detail sheet, "Mark complete" and the due date row. VoiceOver users never need a swipe.
4. "New task" (the floating button) → an edit field with the accessory bar ("Date", "Next", …) above the keyboard.
5. Long-press a row with a double-tap-and-hold. → Selection mode: "1 selected" is announced. The bulk toolbar ("Bulk actions for 1 task") replaces the bottom nav, and its buttons read "Complete", "Date", "Move to", "Tag", "Delete". "Done" leaves selection mode.
6. Due date sheet: each choice reads its label and date ("Tomorrow, Sat 11 Oct").
7. Settings → Behaviour: the swipe action pickers read their current value.

## 7. Zoom, contrast and motion (any browser)

1. Zoom to 200 % at 1280 px. → No horizontal scrolling in the list, the pane or settings, and nothing is cut off.
2. Set "Reduce motion" in the OS. → Completing, collapsing and opening the pane happen without animation.
3. Use Windows High Contrast (forced colors). → Focus rings, checkboxes and the selection bar stay visible.
