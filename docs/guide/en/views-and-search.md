# Views and search

Besides My tasks, each organisation has four **smart views** that sort your tasks by date, and the command palette finds anything in a few keystrokes.

## Smart views

Smart views show your tasks (the ones in My tasks, including subtasks assigned to you) grouped by date. They never change your groups or your order in My tasks. Rows work as usual: complete, re-date, tag or open them. Dragging is off in these views, because they are sorted; to change a date, press **D**.

| View | Shows | Go there |
|---|---|---|
| **Today** | an *Overdue* section, then everything due today (headed with today's date) | G then T |
| **Next 7 days** | one section per day: Today, Tomorrow, then each weekday | G then W |
| **Overdue** | everything past its due date, oldest first | G then O |
| **No date** | tasks without a due date, in My tasks order | G then N |

Each row shows its group as a small chip. The sidebar counts open tasks for Today and Overdue (the Overdue count is red), so you see at a glance whether something needs attention. Completed tasks are hidden unless you turn on **Show completed**.

![The Today view with an Overdue section](../../screenshots/today.desktop.light.png)

**Adding tasks in a view.** A task added in Today is due today, in a day of Next 7 days on that day, and in No date without a date. It goes to your Inbox; to put it in a group, end the title with `>Group`, for example `Order toner >Prio`.

![Next 7 days, one section per day](../../screenshots/next-7-days.desktop.light.png)

## All organisations

If you're in more than one organisation, the top of the sidebar has **All organisations** with Today, Next 7 days and Overdue across all of them: one place to see what's due, whether it's work, home or the club. The badges add up every organisation's counts.

- The sections are the same as in each organisation's views (Overdue, then Today; one section per day), with every organisation's tasks mixed by date. Each row has a small chip with its organisation's avatar.
- Rows work as anywhere else: complete, re-date, tag, assign or open them. Each change is saved in the task's own organisation, and it all works offline.
- **Adding a task** puts it in your **default organisation** (Personal, unless you change it in [Settings → Behaviour](./settings-and-data.md#behaviour)). The new row shows that organisation as a muted chip. To pick another, type `^` and its name: `Book the venue ^Kestrel`. Suggestions appear as you type, and the chip follows. The task goes to that organisation's Inbox, or to a group you name with `>Group`.
- No date and My tasks stay in each organisation: they're about where a task is filed.
- To go there from the keyboard, open the palette (Ctrl+K) and choose **All organisations: Today** (or Next 7 days, Overdue). To start rooster on All organisations · Today, see [Behaviour](./settings-and-data.md#behaviour).

## Everyone's tasks

Shared organisations also have **Everyone's tasks**, all open tasks grouped by person (G then E). See [Working together](./collaboration.md#everyones-tasks).

## The command palette

Press **Ctrl+K** (⌘K on a Mac), click **Search** in the sidebar, or press **/** when no text field has focus.

![The command palette with search results](../../screenshots/palette.desktop.light.png)

- With an empty box, it shows your **Recent** tasks and the **Actions** you can take, including those for the selected task.
- Type to search tasks. Results show the title, the group or organisation, and the due date. Enter opens the task in its list.
- Below the tasks, **Help** lists the best matches from this guide. Enter opens the page at that section. To see every match, search on the [guide's own pages](./getting-started.md).
- Start with `>` to search only actions: go to a view or organisation, create a task, show completed tasks, open Trash, export, and every task action, such as **Make subtask of…**. Shortcuts are shown next to them.
- Search covers the current organisation. Turn on **All organisations** to search them all.

## Search syntax

Search looks in titles, descriptions and comments. Each word matches the start of words (`dent` finds *dentist*), ignoring case and accents. Use double quotes to keep a phrase together: `"quarterly report"`.

| Filter | Finds |
|---|---|
| `#tag` | tasks with that tag (several `#` filters must all match) |
| `@name` | tasks assigned to that person (name or email); `@me` for yours |
| `due:today` | due today or earlier, like the Today view |
| `due:week` | due within the next 7 days |
| `due:overdue` | past their due date |
| `due:none` | without a due date |
| `is:open` / `is:done` | only open / only completed tasks |

Without `is:`, completed tasks are included, after the open ones. Swedish filter words work too: `due:idag`, `due:försenade`, `due:vecka`, `due:utan`, `is:öppen`, `is:klar`.

Example: `invoice #finance due:week` finds tasks mentioning *invoice*, tagged *finance*, due within a week.

## Offline

Without a connection the palette searches the tasks stored on your device and says *Offline — showing cached tasks*. See [Phone and offline](./phone-and-offline.md).
