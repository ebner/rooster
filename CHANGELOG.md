# Changelog

All notable changes to rooster are listed here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow [SemVer](https://semver.org/). Container images are tagged `x.y.z`, `x.y` and `x`.

**Downgrades:** migrations are forward-only. To go back to an older version, restore the automatic "Before update" backup (`pre-migrate-*.db`) that the newer version wrote to `/data/backups/` when it first started (see [operations §7](docs/spec/08-operations.md#7-backups--restore)). Each release lists its migrations below.

## [Unreleased]

### Fixed
- With the detail pane open, creating a task left an empty row under it that was neither a task nor editable and couldn't be removed (until a reload). The pane's selection sync ended the new row's edit; it now never interrupts a title being typed (regression in 1.8.0, ADR 0064).

### Changed
- **The project lives at `github.com/201works/rooster`.** Images are published to `ghcr.io/201works/rooster`. The MCP Server Card's name is `io.github.201works/rooster`.

### Migrations
- None.

## [1.8.0] - 2026-10-22

### Added
- **The OAuth device grant (RFC 8628)** for machines without a browser (Phase 12, 11 §9, ADRs 0065, 0066). `POST /api/auth/oauth2/device-authorization` (with `resource`, no `verification_uri_complete`) and the device grant type at `/api/auth/oauth2/token`. New setting `ROOSTER_OAUTH_DEVICE=off|first-party|all` (default `first-party`: only rooster's CLI). Third-party clients need a Client ID Metadata Document listing the grant and are always shown as Unverified with their domain. Codes are hashed (the legacy CLI flow's too), live 10 minutes, and code entry locks for 10 minutes after 10 wrong codes. Every approval sends the user a `device_connected` notice, emailed when SMTP is configured.
- **The `/device` approval page** shows the client and its domain, the code to compare, the requesting IP and its age, and a phishing warning; the user always types the code.
- **MCP tokens:** personal access tokens get an audience, `api` (default) or `mcp`. An MCP token works only at `/mcp` and is refused by `/api/v1`, never carries `admin`, and comes with setup lines for Claude Code and Codex.
- **CLI:** `rooster login` uses the device grant with rotating refresh tokens (refresh serialised per profile across processes; logins from 1.7 keep working). New `rooster mcp header` (a `headersHelper` for Claude Code) and `rooster mcp setup --remote`; `rooster token create --audience mcp`.
- An × next to the due date in the detail pane (desktop and the phone sheet) clears it like "No date" (ADR 0064).

### Changed
- **Refresh-token reuse has a 60 s grace period:** the previous refresh token may be redeemed once more within 60 s of a rotation if its successor is unused, so a lost response no longer revokes the grant. Any other reuse still revokes it (ADR 0066).
- A task created while the detail pane is open takes the pane as soon as its title is committed. Before, the pane kept showing the previous task until another row was selected. From the empty row Enter leaves below, O, Tab+Enter and Tab+R act on the new task (ADR 0064).

### Migrations
- `0016_p12_device_grant`: device code columns (`oauth_client_id`, `resource`, `request_ip`, `created_at`), `access_grant.audience`, and the refresh-token grace columns (`successor_id`, `grace_used_at`). Existing device codes are pending logins at most 10 minutes old; their plaintext codes stop working after the upgrade (start `rooster login` again).

## [1.7.2] - 2026-10-19

### Fixed
- 1.7.1 did not cure the phone that sat on "Syncing…": it still sent nothing. Another rooster page on the same browser (a forgotten tab, possibly on an older version) can hold the sending lock and answer the app's "are you alive?" check without ever sending. The app in front now takes the lock from a leader that answers but leaves the same change unsent for 45 s without reporting a failure (ADR 0019 §9).
- Reload no longer waits forever for a queue that doesn't drain: after 10 s it goes ahead when every queued change is stored on the device, and the new version sends them. This deviates from 04 §6.3, which waited for an empty outbox (ADR 0021 amendment).

### Migrations
- None.

## [1.7.1] - 2026-10-19

### Fixed
- The web app's sync queue could stop sending for good, showing "Syncing…" with nothing reaching the server, when the browser's IndexedDB stopped answering (seen on an Android phone). Every send waited for its op's outbox write, with no time limit; the ops lived only in memory and were lost when the app was closed. Outbox reads and writes now get 4 s each: after that, ops are sent anyway, and outbox records that arrive after the start-up read gave up still join the queue. A refused tag create no longer waits without limit for the tag lookup either (ADR 0019 §8).

### Migrations
- None.

## [1.7.0] - 2026-10-16

### Added
- On phones, a sideways swipe on the org name in the header switches to the next or previous org, with dots under the name for the position; holding the name and sliding to an org in the sheet picks any org. Every phone org switch now keeps the view (Today stays Today) where the other org has it (ADR 0063).
- On touch screens, a tap on a link in a task's description shows a link card under it: the address, which opens the link in a new tab, plus Edit and Remove. Before, a tap only placed the caret, and opening a link took the formatting toolbar (ADR 0062).

### Fixed
- With S3 storage, an upload that S3 refused before rooster had opened its temporary file could end the server process with an uncaught `ENOENT` once the file was cleaned up. The error is now ignored; the refused upload still fails as before.

### Migrations
- None.

## [1.6.2] - 2026-10-13

### Changed
- A task due tomorrow has a blue date label (blue-700, 6.7:1 on white) instead of orange-700, which read as red next to overdue; in 16-colour terminals the CLI now prints it blue rather than red. The unused `orange-700` palette value is gone (ADR 0061).
- The desktop UI scale stops at 112.5 % (from 1440 px): windows of 1600 px and wider no longer step up to 125 %, which looked a step too big at 100 % browser zoom (ADR 0061).

### Migrations
- None.

## [1.6.1] - 2026-10-12

### Changed
- The logo in the emails' header is larger: 36 px tall instead of 28.

### Fixed
- Picking a day in a row's date picker sets the date without opening the task's detail pane. Clicks inside a row's popovers no longer count as clicks on the row.

### Migrations
- None.

## [1.6.0] - 2026-10-12

### Added
- **Send test email** in Admin → System: a test to the signed-in admin's own address that reports whether the SMTP server accepted it, with its SMTP code and status if not (`POST /api/v1/admin/mail/test`, ADR 0059). `docs/operator.md` describes relaying through the host's Postfix, including TLS for its outbound mail.
- **Search in the guide:** a field above the guide's page list (and on `/help`, also on phones) finds the sections that contain every word, ignoring case and accents, with highlighted snippets. It runs on the loaded guide, offline too, and the query is in the URL (`?q=`), so Back returns to the results. The command palette (Ctrl+K, and Search on phones) shows the best five sections under **Help**, after the tasks (ADR 0058).

### Changed
- Emails show the app's logo (mark and name) in their header: a small PNG sent inline with each message, with "rooster" as its alt text (ADR 0059).
- On desktop the guide's header says "Help" instead of repeating the open page's title, which the page list already marks.
- The guide calls the full-screen terminal app a TUI, names it in the page title ("Terminal app, command line and AI agents"), lists all of its keys and shows a screenshot of it, which `pnpm docs:screenshots` renders from the real TUI.
- The favicon has a lighter line (4 units on the 48 grid instead of 5), closer to the logo in the app.

### Fixed
- In a narrow row (for example with the detail pane open), tag chips that don't fit drop out whole instead of running under the description, reminder, subtask and attachment icons.

### Migrations
- None.

## [1.5.3] - 2026-10-12

### Added
- **What's new:** after an update, rooster offers once a page listing what changed for users in each version, in English and Swedish. It's in the guide and in Settings at any time. Releases need its notes (`docs/guide/{en,sv}/whats-new.md`; ADR 0057).

### Changed
- On phones a new task's row shows its calendar too: tap it to pick the date while you type the name, as with the Date button above the keyboard. This also works for a new subtask, which has no button bar.
- Releases are cut with `pnpm release X.Y.Z`, which checks the notes and the migration fixture, then runs the whole pipeline with the image before the release commit and tag. The timing budgets get one retry everywhere.

### Fixed
- On phones, a date picked for a new task shows on its row at once, not only after the task is created.
- Screenshots in the guide show at their real size: phone screens are no longer blown up to the full column, and a cropped picture has the same zoom as the full-screen ones beside it. On wide screens the two phone-layout pictures sit side by side.

### Migrations
- None.

## [1.5.2] - 2026-10-11

### Added
- A new task can get its due date while you type its name: click the calendar on the right of the row, or press Tab+D. The name stays open for typing, and Enter creates the task with that date.

### Fixed
- Pages open at their top: settings sections, Admin and guide pages no longer start where the previous page was scrolled to. Back and Forward still return to where you were, and the task list keeps its place while a task's pane opens and closes.
- The settings menu stays in place while a section scrolls, as the guide's page list does, and no longer shifts sideways between short and long sections.

### Changed
- On phones and tablets, rows without a due date show a faint calendar where the date goes, and tag chips show their remove button.
- Pull to refresh on phones shows its spinner for at least half a second, so a quick refresh is visible.

### Migrations
- None.

## [1.5.1] - 2026-10-11

### Changed
- The Android app icon shows the rooster larger and centred. The logo is a bit bigger in the sidebar and the phone header.

### Migrations
- None.

## [1.5.0] - 2026-10-10

Hardening (Phase 11): a full security audit, accessibility, performance with 2,000 tasks, the user guide in the app, and operations tooling.

### Added
- **The user guide**, in English and Swedish, in the app at `/help` (G then H, or the `?` cheat sheet, the user menu and Settings) and in `docs/guide/`. It works offline. The README and the guide show screenshots of a demo team.
- **The list's ⋯ menu:** add group, show completed, collapse or expand all groups (Shift+← / Shift+→), export, and print (Ctrl/⌘+P prints just the list).
- **Settings → Behaviour:** turn off recognising dates in task names, and choose how long completed tasks stay (1.5 s, 3 s or until reload).
- **Admin → System:** version, database and WAL size, last backup, job runs, mail and push status, live connections, attachment storage, and a "Rebuild search index" action.
- **Storage quota:** `ROOSTER_USER_STORAGE_MB` (default 1024 MB of attachments per user, 0 for none). Settings → Data shows what you use.
- **Removed sign-ins:** an identity you unlink in Settings → Security can no longer sign you in until you allow it again there.
- **Operations:** `compose.litestream.yaml` for continuous replication, the operator guide (`docs/operator.md`), `CONTRIBUTING.md`, the ASVS L2 map (`docs/security/asvs.md`) and a manual screen-reader checklist.

### Changed
- **Apps and tokens no longer see your colleagues' email addresses.** Assigning by email, full name or `me` still works in the CLI and MCP, through `GET /orgs/{orgId}/members/resolve`. Older CLI and MCP versions can no longer assign by the part of an email before the @.
- **Approving an app (OAuth consent) or a CLI login (device approval)** is now tied to the browser session that showed the request; a page left open across a sign-out or account switch must be reloaded.
- **Regenerating the push keys** pauses push instead of turning it off: each device renews itself the next time rooster is opened there. Push keeps at most 20 devices per person.
- **No app or token can delete a task permanently**; emptying the Trash needs the browser.
- **Uploads:** at most 3 at a time per person.
- **Signing in as another account in one tab** now reloads rooster's other open tabs (ADR 0051).
- **Performance:** the list stays fast with 2,000 tasks (keypress to screen under 30 ms at p95), and the server idles under 150 MB.
- **The Docker image** is smaller (about 249 MB): rooster's files are owned by root, and boot refuses database files it can't make private.
- The initial-bundle budget is 500 KB.

### Security
- A full security audit of every trust boundary, with each finding fixed or recorded (`docs/security/security-review.md`, ADR 0056).
- CI checks dependencies (`pnpm audit`) and scans for secrets (gitleaks).
- API responses are `Cache-Control: no-store` by default.

### Fixed
- **Uploads in the Docker image:** attachments and avatars failed with a 500 in the 1.4.0 image, because the bundled server couldn't load a module that file-type detection imports at runtime (ADR 0054).
- On phones, the swipe reveal sits behind the row it belongs to, and rows with many icons keep a readable title.
- Inbox, email and push previews of comments show plain text instead of Markdown.
- Accessibility: the list's rows and groups have full screen-reader names, focus and target sizes meet WCAG 2.2 AA, and the phone task sheet hides the list behind it from assistive technology.

### Removed
- `ROOSTER_METRICS_TOKEN` (there was no metrics endpoint).

### Migrations
- `0012_p11_attachment_uploader`: an index for the storage quota.
- `0013_p11_avatar_storage_push_rotation`: where an avatar is stored, and which push subscriptions wait for renewal after a key rotation.
- `0014_unlinked_identity`: removed sign-ins.
- `0015_p11_avatar_id`: one key per avatar upload.

### Upgrade notes
- **Litestream:** put `LITESTREAM_ACCESS_KEY_ID` and `LITESTREAM_SECRET_ACCESS_KEY` in `litestream.env`, not `.env`.
- **The data directory must be owned by the container user** (65532). Rooster now refuses to start if it can't make its database files private.

## [1.4.0] - 2026-10-10

Recurring tasks, task reminders, attachments and the calendar feed (Phase 10), plus isolation between accounts on a shared browser.

### Added
- **Recurring tasks:** "↻ Repeat" in the date picker and the task pane (daily, weekdays, weekly, monthly, yearly, or custom: every N days/weeks/months/years, chosen weekdays, the nth or last weekday, counting from completion, ending on a date or after N times), and in titles ("Water plants every mon", "varannan vecka", "every 3 days after done"). Completing a recurring task creates the next one directly below it, with its subtasks, tags, followers and reminders. Deleting one asks "this task" or "this and following" (ADR 0049).
- **Task reminders:** "🔔 Reminder" (Alt+R) in the date picker, a Reminders line in the pane, and `!15m`, `!1h`, `!1d` or `!due` at the end of a title. Reminders are personal and arrive in the inbox, as a push, and (if you turn it on) by email; "Task reminders" has its own row in Settings → Notifications, and all-day tasks remind at a time you choose (default 09:00). A bell in the row shows a pending reminder.
- **Attachments:** drop files on a task, paste a screenshot, or choose files. Images get thumbnails and open in a viewer (←/→, Esc); other files download. The limit is 25 MB per file (`ROOSTER_UPLOAD_MAX_MB`). Files are stored under `/data/attachments`, or in S3-compatible storage with `ROOSTER_S3_*`.
- **Your own avatar:** upload a picture in Settings → Profile, or go back to the one from your sign-in provider.
- **Calendar feed:** Settings → Calendar feed gives a secret link (for one organisation or all) that Google Calendar, Apple Calendar or Outlook can subscribe to. It shows your open tasks with due dates; you can replace or revoke the link at any time.
- **CLI, TUI and MCP:** `rooster add/edit --remind 1h` (or `"fri 14:00"`), `edit --no-remind`, `--repeat "every mon"`, `rm --occurrence`; `ls` marks repeating (↻) and reminded (🔔) tasks and `show` lists reminders and attachments. The TUI's `d` accepts repeat phrases and `!1h`; MCP `create_task`/`update_task` take `remind`, `clearReminders` and `repeat`.

### Changed
- The Docker image includes sharp (image thumbnails). The image budget is now 350 MB (ADR 0048).
- The CLI checks the whole command line first: unknown option spellings, a missing value, or a value that looks like another option are refused (exit 2) before anything is sent. Pass a value starting with `-` as `--title=-5 degrees`, or put words after `--`.

### Security
- **Signing in as someone else in another tab:** open rooster tabs used to wipe their data on noticing the change, but kept running. Edits, uploads, undo, drafts, a revealed calendar or token link, or an OAuth approval still in progress could then carry on as the new account. Now a tab that notices another account stops sending at once, finishes clearing push and local data, and reloads (ADR 0051).
- An oversized upload that stalls is cut off within seconds instead of holding the connection for minutes. Pending uploads are dropped when the session ends.

### Migrations
- `0011_p10_reminders_attachments_ical`: adds `task_reminder`, `attachment`, `ical_feed` and `blob_gc` (with a trigger that queues the files of deleted attachments for removal), `user.avatar_at`, `user.oidc_image`, and an index on open recurring instances.

### Upgrade notes
- **Uploads behind a reverse proxy:** allow request bodies of at least 30 MB on `/api/v1/` (Apache `LimitRequestBody`, nginx `client_max_body_size`); `docker/proxy/` has updated snippets. Forward `/ical/` to rooster for calendar feeds.
- **Backups:** a database backup plus the `attachments/` directory is a complete backup.

## [1.3.0] - 2026-10-09

AI agents, the terminal UI and agent access (Phase 9), plus phone and settings fixes.

### Added
- **AI agents and other apps (Phase 9):**
  - **Remote MCP:** add `https://<your rooster>/mcp` to an AI agent (Claude, IDEs, …) and it finds the rest itself. You approve it on a consent screen that shows who is asking and lets you choose what it may do and where: which organisations and groups, whether it may delete tasks ("Allow deleting tasks", off by default) and for how long, including "This session only". If an agent later needs more, it asks again and only the new part is highlighted (ADRs 0041, 0043, 0045, 0046).
  - **`rooster mcp`** serves the same tools to local agents over stdio, and **`rooster mcp setup`** creates a separate, narrower login for the agent and prints or writes the config for Claude Code, Claude Desktop or Cursor (ADR 0044).
  - **The rooster skill:** `rooster skill install` teaches an agent how to plan the day, capture and triage with rooster. Each server also publishes it, along with an MCP Server Card, `/.well-known/ai-catalog.json` and `/llms.txt`, so agents can discover rooster from its address alone (turn this off with `ROOSTER_AGENT_DISCOVERY=off`).
  - **Third-party apps** can use the REST API through the same OAuth sign-in, with tokens that only work for the API they were issued for.
- **Terminal UI:** `rooster` without arguments opens a full-screen, keyboard-only rooster with views, orgs, editing, dates, tags, moves, details, undo and live updates (ADR 0047).
- **Settings → Security → Linked identities:** see which sign-in accounts are linked and unlink one (never the last).
- **Admin from the command line:** admins can give a CLI login or token the admin capability (`rooster login --admin`) and run `rooster admin reindex`.
- **New settings:** `ROOSTER_OAUTH_DCR=on` lets older MCP clients register themselves (shown as "Unverified app"); `ROOSTER_AGENT_DISCOVERY` (default on).

### Changed
- On the `/device` approval page and the consent screen, deleting tasks is its own checkbox.
- **Settings on phones** open as a list of sections; each section has a "‹ Settings" back button, instead of a strip of tabs that pushed the page sideways.
- The desktop settings menu is as wide as its longest label, so "Notifications" is no longer cut off.

### Fixed
- `rooster show` lists the newest comments when a task has more than 100.
- Choosing "Only these groups" when creating a token no longer blanks the screen on phones or adds a second scrollbar on desktop.
- On phones, "+ Add task" lines up with the task titles above it.
- The token summary no longer reads "Can read ; …" before any group is chosen.

### Migrations
- `0010_oauth_provider`: adds the OAuth provider's tables (`oauthClient`, `oauthResource`, `oauthClientResource`, `oauthRefreshToken`, `oauthAccessToken`, `oauthConsent`, `oauthClientAssertion`) and `access_grant.idle_timeout_ms`.

### Upgrade notes
- For remote MCP behind a reverse proxy, forward `/mcp`, `/mcp/server-card`, `/.well-known/*` and `/llms.txt` to rooster, and don't buffer `/mcp` (it may stream). `docker/proxy/` has updated Apache and nginx snippets.

## [1.2.0] - 2026-10-09

Collaboration, notification delivery and the command line (Phases 6 to 8).

### Upgrade notes
- Four migrations run on first start; the automatic "Before update" backup is written first, as for every version change.
- Email is optional: set `ROOSTER_SMTP_URL` and `ROOSTER_MAIL_FROM` to send invites, notifications and the digest. Push keys are generated on first start unless `ROOSTER_VAPID_*` is set.
- Personal access tokens and CLI logins are grant-based: Settings → Security → Connected apps lists them. `/api/auth` accepts only browser sessions.

### Added
- **Collaboration in shared organisations (Phase 6):**
  - **Assignment:** assign a task with Tab+A or A, from the task pane, with `@name` when you type a new task, or for a whole selection. The task moves to the top of the other person's Inbox, and Undo puts it back where it was (ADR 0032).
  - **Everyone's tasks:** a view with a section per member plus Unassigned. It has filters for due date, people and tags, lets you add a task under any member, and you drag between sections to reassign (ADR 0032).
  - **Comments and activity:** the task pane shows comments and a history of changes. Comments support bold, italic, code, links and lists, and `@mentions` with suggestions as you type. You can edit or delete your own comments. Comments work offline and sync later (ADRs 0028, 0031).
  - **Followers:** the creator, the assignee, commenters and mentioned members follow a task automatically. You can follow or unfollow any task.
  - **Inbox:** notifications for tasks assigned to you, comments on tasks you follow, mentions, your tasks completed or re-dated by someone else, and accepted invites. The sidebar and the phone's new Inbox tab show the unread count live. Settings → Notifications turns each kind on or off (ADRs 0029, 0031).
  - None of this appears in your personal organisation.
- **Command line and access tokens (Phase 8):**
  - **The `rooster` CLI:** list and add tasks, complete, move, tag, comment and search from a terminal, with natural-language dates, `#tags` and `>Group` in titles, JSON output for scripts, shell completion, and binaries for Linux, macOS and Windows on each release. Sign in with `rooster login`, approving on any device (ADR 0039).
  - **Choose exactly what a token or CLI login may do:** capabilities (read, add and change, comment, assign, manage groups, delete) and which organisations and groups it may read or change, plus an expiry. Everything connected to your account is listed under Settings → Security → Connected apps, where you can narrow or revoke it (ADRs 0036–0038).
  - **API:** every route is documented with descriptions, error codes and examples at `/api/docs`; personal access tokens (`rooster_pat_…`) work as `Authorization: Bearer`; `GET /tasks/resolve` looks up tasks by number or ID prefix; `parse: true` also reads `#tags`.
- **Notification delivery (Phase 7):**
  - **Push notifications:** turn push on per device in Settings → Notifications. You get the same events as the inbox, a test button, and an optional morning reminder of today's tasks at a time you choose. On an iPhone, add rooster to the Home Screen first (ADRs 0034, 0035).
  - **Email** (when the server has SMTP configured):
    - invites by email;
    - notification emails, sent immediately or collected every 15 minutes;
    - an optional daily digest of what's overdue, due today and new in your Inbox.
    - Every email has an unsubscribe link for its kind. Without SMTP, email options are hidden and invites stay copyable links.
  - **Settings → Notifications** is now a full grid: each event by in-app, push and email, plus the digest and the reminder with their times. Defaults: email only for assignments and mentions, and the digest and reminder off (ADR 0033).
  - **Admin:** regenerate the push keys.
  - **New settings:** `ROOSTER_SMTP_URL`, `ROOSTER_MAIL_FROM`, and optionally `ROOSTER_VAPID_PUBLIC`/`_PRIVATE`/`_SUBJECT`. Push keys are otherwise generated on first start.
- **API:** `assigneeId` on task create and update, and the bulk op `assign`. Task lists accept `view=everyone`, `assignee` and `hasDue`. New routes for comments, the activity feed, followers, notifications and notification preferences. A new SSE event, `notification`. Search now also finds comments, and the export includes them.

### Changed
- **Today view:** the section for today's tasks is now labelled with the date ("Friday, Oct 9") instead of repeating "Today" under the Today heading.
- **Larger logo** in the desktop sidebar and the collapsed rail.
- **New app icon:** the rooster now appears as it does in the app: dark line and amber comb on a cream tile, instead of a white line on a dark tile. Installed apps may need to be reinstalled before some launchers show it.

### Fixed
- **A tab woken from the background now shows changes made in another tab meanwhile.** Every tab of a browser shared one client id, so each tab took the others' changes for its own and skipped refreshing; a tab frozen by Android could stay stale until reload. Each tab now has its own id.
- Closing search (Esc) after opening it with the mouse no longer leaves a focus ring on the sidebar's Search item. When you do use the keyboard, the ring is now drawn inside the item, so its top edge is no longer cut off.
- A task due at a time that happens twice when the clocks go back (such as 02:30 on 25 October in Sweden) now counts as due at the first of the two, whatever time zone the server runs in. Before, a server in UTC used the second one.

### Security
Phases 6 to 8 went through an additional independent security review, and everything it found is fixed (ADR 0040):
- Token and CLI access is checked for every task a change touches (duplicates, subtasks, reassignments, restores and deletes), and reads that reference other tasks (notifications, live updates, activity, search) only show what the grant may read.
- Retried requests (`Idempotency-Key`) only replay to the same credential; a new access token is never stored for replay.
- Push subscriptions accept only canonical URLs of the known push services, and sign-out turns push off for that device.
- The CLI only sends a login to the server it was created for, keeps one credential store per profile, never opens a browser or editor through a shell, and strips control characters from everything it prints.
- Comment formatting runs in linear time on any input.

### Migrations
- `0005_collab`: adds the `comment`, `activity`, `follower`, `notification` and `notification_pref` tables.
- `0006_delivery`: adds the `push_subscription` and `job_run` tables and an index for pending notification emails.
- `0007_agent_access`: adds `access_grant`, the API key and device code tables, and a grant link on sessions.
- `0008_grant_hardening`: drops stored replays that contained an access token, and makes the creators and assignees of existing shared tasks followers.
- `0009_task_parent_index`: adds an index on `task.parent_id` covering deleted tasks.

## [1.1.0] - 2026-10-09

### Changed
- **Bigger on large screens:** on desktop windows from 1440 px wide the whole interface is 12.5 % larger, and from 1600 px 25 % larger, as if the browser were zoomed in. Laptops below 1440 px, tablets and phones are unchanged. If you had zoomed your browser to get this, set it back to 100 % (ADR 0027).
- **New logo and app icon:** a redrawn rooster head with a hand-painted amber comb and a new "rooster" wordmark, used the same way everywhere: sign-in (where the comb is painted in as the page loads), the sidebar, the phone header, empty views, the loading screen, the 404 and error pages, the favicon and the installed app's icon (ADR 0026).
- **New accent colour:** amber replaces the coral-red accent (buttons, selection, focus rings, the app icon), so red is left for things that really need attention, such as overdue dates and delete buttons. "Tomorrow" dates are now orange (ADR 0024).
- **Backups before every update:** the server now writes a "Before update" backup whenever it starts with a different version, not only when the database schema changes (ADR 0023). The first start after upgrading takes one.

### Added
- **Description indicator:** rows show a small lines icon when the task has a description (ADR 0025). The API's task objects gain `hasDescription`.
- **Opening links in descriptions:** Ctrl+click (⌘+click on a Mac) opens a link in a new tab; holding the key shows the hand cursor, and links have a tooltip (ADR 0022).

### Fixed
- Choosing **Organisation settings** or **Invite** in an organisation's ⋯ menu in the sidebar no longer moves that organisation down the list.
- **"+ Add task", "+ Add subtask" and "+ Add group"** now highlight on hover like other rows and buttons.

### Migrations
- None.

## [1.0.2] - 2026-10-09

### Fixed
- **"Syncing…" never cleared on phones** when the installed app and a Chrome tab were open at the same time: Android froze the background tab while it held the outbox, so edits in the app were never sent. A visible app now takes over sending after about 4 s; requests that get no answer time out after 20 s and are retried safely (ADR 0019).
- **Drag and drop:** the dragged row now stays exactly under the pointer or finger (it was drawn up to several hundred pixels too high, more when scrolled), the drop line follows auto-scroll, and dropping an item right before or after itself is no longer offered (ADR 0018).
- **Phone layout:** the bottom navigation and header stay put; the page itself can no longer scroll or bounce, including after pull-to-refresh (ADR 0020). The add button (FAB) no longer overlaps the bottom navigation and sits above toasts.

### Added
- **Update prompt:** besides the "New version available · Reload" toast, every header shows an "Update" chip until you reload; the app also checks for a new version when it comes back to the foreground, works without a service worker, and never reloads another tab while you're typing (ADR 0021).

### Migrations
- None.

## [1.0.1] - 2026-10-08

A security-hardening release after an audit of 1.0.0. No cross-org or cross-user data path was found; the changes below close weaker spots (ADR 0017).

### Upgrade notes
- **Everyone signs in once more** on https: the session cookie is now `__Host-rooster.session`.
- **Generic OIDC providers no longer link to existing accounts by email** unless they have `"trustEmail": true` in `ROOSTER_OIDC_PROVIDERS` (Google is always trusted). Only set it for providers where users cannot change their own email. See `docs/oidc-setup.md`.
- **New:** `ROOSTER_TRUSTED_PROXY_HOPS` (default 1). Your reverse proxy must not pass a client-supplied `X-Forwarded-For` on: Apache `RequestHeader unset X-Forwarded-For early`, nginx `$remote_addr` (08 §5, `docker/proxy/apache.conf`).
- The server refuses weak `ROOSTER_AUTH_SECRET` values (containing `change-me`, or fewer than 10 distinct characters) with exit code 78.
- Existing data files keep their permissions: run `chmod 700 data data/backups` and `chmod 600 data/*.db*` once on the host.

### Security
- Sign-in: account linking only from email-authority providers; single-use invites accepted atomically; `__Host-` cookies; weak secrets rejected.
- Requests: client IP from the right-most trusted proxy hop (the sign-in rate limit can no longer be dodged); body limits of 64 KB on `/api/auth` and 1 MB on `/api/v1`; the CSRF check is skipped only for token-authenticated clients.
- Realtime: at most 4 live-sync streams per session and 12 per user; a member's client id is no longer sent to other members.
- Data: stored request replays are forgotten when someone loses access to an org; filtered search is capped; expired sign-in state is purged; data files are created private (umask 0077).
- Logs: no invite tokens, search text or SQL parameter values.
- Web: sign-out also clears per-user local storage (palette recents); orgs you were removed from disappear from the cache, offline search and the outbox; queued edits are bound to their user; caches unconfirmed for 30 days are not restored; description links allow only http, https, mailto and relative URLs; source maps and the build manifest are no longer served.
- Supply chain: CI actions pinned to commit SHAs, base images pinned by digest, Dependabot for both.

### Migrations
- None.

## [1.0.0] - 2026-10-06

The first switch-over release: rooster is ready for daily use (D-18).

### Added
- **Sign-in and organisations** (Phase 1): Google and generic OIDC sign-in with an email allowlist, personal and shared orgs with members and invites, profile and behaviour settings, active sessions, and an admin area (users, allowlist, backups).
- **The list** (Phase 2): personal groups with an Inbox, inline task creation and editing that behaves like a text editor, natural-language due dates in English and Swedish, drag and drop (with keyboard alternatives), multi-select and bulk actions, undo and redo, completion with a hide delay, and nightly backups.
- **Detail pane** (Phase 3): Markdown descriptions, start dates, subtasks up to five levels deep, tags with colours and a tag filter, and duplicate.
- **PWA, offline and realtime** (Phase 4): an installable app that reads offline and queues edits in an outbox, live updates across tabs and devices over SSE, and phone and tablet layouts with swipe actions, a FAB and a bottom navigation.
- **Smart views** (Phase 5): Today, Next 7 days, Overdue and No date per org, with sidebar counts, a group chip on each row, and inline add that inherits the view's date (`>Group` picks the group).
- **Search and command palette** (Phase 5): Ctrl/Cmd+K (or `/`) searches titles and descriptions with prefix matching and `#tag`, `@person`, `due:` and `is:` filters, lists recent tasks, and runs any action, including "Make subtask of…". It works offline over cached tasks.
- **Data** (Phase 5): Settings → Data exports an org as JSON or Markdown, and lists the org's Trash with restore and permanent delete.
- `POST /api/v1/admin/search/reindex` rebuilds the search index. The server also rebuilds it at boot when it is out of step.
- A leaner first load: the editor, popovers, palette and sign-in client load on demand, and only the active language is downloaded (about 370 KB gzip of JavaScript for My tasks, checked in CI).
- The REST API v1 with OpenAPI docs at `/api/docs`.

### Migrations
- `0000_init` to `0003_subtasks_tags`: the initial schema (Phases 0–3).
- `0004_task_fts`: the full-text search table `task_fts` (FTS5), filled from existing tasks.

### Not included
- Move tasks over from another tool by pasting a multi-line list into a group.

[Unreleased]: https://github.com/201works/rooster/compare/v1.0.2...HEAD
[1.0.2]: https://github.com/201works/rooster/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/201works/rooster/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/201works/rooster/releases/tag/v1.0.0
