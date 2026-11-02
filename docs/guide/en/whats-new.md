# What's new

What changed for you in each version of rooster, newest first. After an update, rooster offers this page once. You can open it at any time from Settings or the guide's page list. The notes for whoever runs rooster (upgrades, settings, security) are in the [changelog](../../../CHANGELOG.md).

## Unreleased

- **Know when an older rooster CLI signs in.** Approving a sign-in from an older version of the rooster command line now puts the same "was connected to your account" notice in your inbox (and email) as newer versions do.

## 1.9.0

_2026-11-02_

- **Drag a task while you're still typing it.** Once a new task has a name, grab its handle and drag it where it belongs; it's created as you drag.

## 1.8.2

_2026-11-02_

- **See what you type on your phone.** A new task's row now moves to the top of the list, so the keyboard never hides it.

## 1.8.1

_2026-10-23_

- **No more flickering date sheet on Android.** Tapping the calendar on a new task's row opens the date sheet once, and you can keep typing the task's name afterwards.
- **No more stray empty rows.** With the detail pane open, adding a task could leave an empty row in the list that you couldn't remove until you reloaded the page. That's fixed.

## 1.8.0

_2026-10-22_

- **Sign in on machines without a browser.** `rooster login` and AI agents set up with `rooster mcp setup --remote` show a code; type it on rooster's **Connect a device** page on any device. The page shows who is asking and from where, and your Inbox tells you when a device was connected.
- **MCP tokens for AI agents.** Create a token that works with MCP under Settings → Security → Connected apps → New token, and paste the setup line rooster shows into Claude Code or Codex.
- **New tasks open in the detail pane.** When the pane is open, a task you add shows there as soon as you press Enter, so you can write its description right away.
- **Clear a due date with one click.** An **×** next to the due date in the detail pane removes it.

## 1.7.2

_2026-10-19_

- **"Syncing…" really clears now.** If another rooster tab on the same phone or computer stops sending your changes, the app in front takes over after a short while.
- **Updates don't get stuck.** If your changes can't be sent, Reload still installs the update after a few seconds. Your changes stay on the device and are sent by the new version.

## 1.7.1

_2026-10-19_

- **No more endless "Syncing…".** On some phones, changes could stay on "Syncing…" without ever being saved, and were lost when the app was closed. They are now sent even when the browser's storage stops answering.

## 1.7.0

_2026-10-16_

- **Switch organisations with a swipe.** On a phone, swipe the organisation name at the top left to go to the next or previous organisation, or hold it and slide your finger to the one you want. You stay on the same view.
- **Open links on your phone.** Tap a link in a task's description to see where it goes, then tap the address to open it. You can also edit or remove the link from there.

## 1.6.2

_2026-10-13_

- **Tomorrow is blue.** A task due tomorrow has a blue date instead of an orange one, so only overdue tasks look red.
- **A slightly smaller layout on large screens.** On screens 1600 pixels wide or more, everything is now the same size as on screens from 1440 pixels, a step smaller than before. If you had zoomed your browser out to make rooster smaller, you can set it back to 100 %.

## 1.6.1

_2026-10-12_

- **Picking a date in the list stays in the list.** Choosing a day in a task's date picker sets the date without opening the task's details.
- **A larger logo in emails.**

## 1.6.0

_2026-10-12_

- **Search the guide.** Type in the field above the guide's page list to find every section about something, with the words highlighted. Accents don't matter, and it works offline too. The command palette (Ctrl+K, or **Search** on a phone) shows the best matches from the guide under **Help**, after your tasks.
- **The guide's header says Help**, and the page list beside it shows which page you're on.
- **The terminal app (TUI) is easier to find in the guide.** Its page shows a picture of it and lists all of its keys.
- **Tags no longer run into the icons on a row.** When a row is too narrow for all of its tags, for example with the details open beside the list, the tags that don't fit are left out instead of overlapping the icons next to them. The details always show every tag.
- **Emails show rooster's logo** in their header, the same as in the app.
- **Admins can send a test email** from Admin → System, to check that rooster's email works.
- **A lighter tab icon.** rooster's icon in the browser tab has a thinner line, closer to the logo in the app.

## 1.5.3

_2026-10-12_

- **What's new:** this page. After an update, rooster offers it once in a message at the bottom of the screen, and Settings links to it at any time.
- **On a phone, a new task's row shows its calendar.** Tap it to give the task a date while you type its name, just like the **Date** button above the keyboard. The date shows on the row at once, and this also works for a new subtask.
- **Screenshots in this guide show at their real size.** Phone screens are no longer blown up to the full width, and on wide screens two phone pictures sit side by side.

## 1.5.2

_2026-10-11_

- **Give a new task a date while you type its name:** click the calendar on the right of the row, or press **Tab+D**. The name stays open, and Enter creates the task with that date.
- **Pages open at their top.** Settings sections, Admin and guide pages no longer start where the previous page was scrolled to. Back and Forward still return you to where you were.
- **The settings menu stays in place** while a section scrolls, and no longer shifts sideways between sections.
- **On phones and tablets,** rows without a date show a faint calendar where the date goes, and tags show their remove button, since there is no hover to reveal them.
- **Pull to refresh** on a phone shows its spinner for at least half a second, so you can see that it ran.

## 1.5.1

_2026-10-11_

- The Android app icon shows the rooster larger and centred, and the logo is a bit bigger in the sidebar and on phones.

## 1.5.0

_2026-10-10_

- **This guide**, in English and Swedish, at Help (G then H). It works offline too.
- **The list's ⋯ menu:** add a group, show completed tasks, collapse or expand all groups, export, and print just the list (Ctrl/⌘+P).
- **Settings → Behaviour:** turn off date recognition in task names, and choose how long completed tasks stay in the list.
- **Settings → Data** shows how much attachment storage you use.
- **Removed sign-ins stay removed:** a sign-in method you unlink in Settings → Security can't sign you in again until you allow it there.
- **Apps and tokens no longer see your colleagues' email addresses.** Assigning by name still works.
- **Faster with long lists:** the list stays quick with 2,000 tasks.
- **Accessibility:** screen readers get full names for rows and groups, and focus and touch targets are easier to see and hit.
