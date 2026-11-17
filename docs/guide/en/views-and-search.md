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

## Views and projects

A **view** gathers the tasks of one organisation that match a few filters, and keeps them a click away in the sidebar: everything tagged *juniper*, what's unassigned, what you finished this week. It never moves tasks: they stay in each person's groups.

- **Create one** with **+ New view** under the organisation in the sidebar, or with **Save as view** from the tag filter in My tasks, from the filters of Everyone's tasks, or from a palette search that uses filters (`#juniper @amara due:week`). Name it, then choose what it gathers with the chips under the name: **Tags** (any or all of them), **Assignee** (anyone, me, unassigned or a member), **Due** and **Status**.
- **Private or Shared:** a private view is only yours. A shared one shows in every member's sidebar, and any member may change, archive or delete it. Sharing a view shows nothing new: everyone in an organisation can see all its tasks anyway; a view only gathers them. In your personal organisation every view is private.
- **Rows** are grouped by person (you first, then the others by name, then *Unassigned*), each by due date. A task shows when it matches itself: a tagged subtask shows under its own assignee with its parent's name, and a tagged task doesn't pull in its untagged subtasks. Completed tasks are hidden until you turn on **Show completed**. Rows work as anywhere else.
- **A project view** is a view with exactly one tag. A task you add in it gets the tag and the person of the section you typed it in (landing at the top of their Inbox; under *Unassigned* it stays unassigned), and the header shows the progress: "7 open · 12 done". When the project is done, **⋯ → Archive view**: the view leaves every sidebar, and [Organisation settings → Views](./settings-and-data.md#organisation-settings) brings it back.
- **Your own order:** drag views in the sidebar (or lift one with its grip from the keyboard) to order them; each member has their own order. The number next to a view counts its open tasks.
- **Tags change, views follow:** a renamed tag stays in its views, a merged one is replaced by the tag it went into, and a deleted tag leaves every view.
- From the keyboard, the palette (Ctrl+K) has **Go to view**, **New view**, **Save search as view** and every action on the open view.

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
