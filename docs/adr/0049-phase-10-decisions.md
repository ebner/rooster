# ADR 0049: Phase 10 decisions (recurrence, reminders, attachments, iCal)

- Status: accepted
- Date: 2026-10-10
- Amends: 01 FR-REC-3/4, FR-REM-2/3, FR-ATT-1/3, FR-CAL-1/2, FR-SET-1; 05 §3, §6; 06 §2.1, §2.4, §2.7, §2.8
- Contract: ADR 0050

Spec gaps settled before implementation. Implementation may refine details; every refinement is
added below as an amendment.

## 1. Recurrence (WP 10.1)
1. **Storage.** The rule is stored normalised by `normalizeRule`: canonical part order, and the anchor made explicit from the due date (WEEKLY gets `BYDAY` of the due date's weekday, MONTHLY `BYMONTHDAY`, YEARLY `BYMONTH` + `BYMONTHDAY`). Month-end clamping therefore never drifts: a rule anchored on the 31st gives Feb 28/29 and then Mar 31 again. `BYMONTH` (YEARLY only) joins the subset of 05 §6. With basis `completion` only FREQ, INTERVAL and the end condition are kept.
2. **The next date.**
   - Basis `due`: the first occurrence of the rule strictly after the completed instance's due date **and not before the completion date**. A late completion therefore skips the missed occurrences instead of leaving a trail of overdue instances, and an on-time completion gives the next one (AC-10.1).
   - Basis `completion`: the completion date plus INTERVAL × FREQ (AC-10.1: "every 3 days after done", completed Oct 7, gives Oct 10).
   - The completion date is the day of the completion's edit time (`X-Rooster-Edit-Time`, so offline completions count when they happened) in the task's `dueTz` for a timed task, and otherwise in the completing actor's timezone.
3. **End conditions.** `COUNT` means the instances left, including the current one. The next instance gets `COUNT − 1`, and completing at `COUNT=1` ends the series. `UNTIL` is inclusive; a next date after it ends the series.
4. **The next instance** is created in the completion's transaction:
   - Placement and assignee: same assignee, same group, directly after the completed instance (05 §4.1 exception 2). A subtask's next instance is the next sibling.
   - Copied (FR-REC-3): title, description, tags, active followers, due time and `dueTz`, the start date shifted by the same number of days, the rule (COUNT decremented), the basis and `series_id`.
   - Subtasks are copied recursively and open, in order, with their due dates shifted by the same number of days and no recurrence of their own.
   - Not copied: comments and attachments.
   - Reminders: every user's relative reminders carry over and resolve against the new due date (FR-REM-5); absolute ones do not.
   - Activity is `created` on the new instance. It sends no notifications.
   - `series_id` is the first instance's id, set when a rule is first applied.
5. **At most one open instance per series.** Completing an instance while another open, non-deleted instance of the series exists creates nothing (`next` is absent). Reopening and re-completing a task therefore never duplicates.
6. **Client-chosen id.** `POST /tasks/:id/complete` accepts `nextId`. Optimistic clients create the next instance locally with it (core reducers, from `nextInstance`), and undoing a completion is "reopen, then delete `nextId`" (to Trash). Reopening by itself never removes the next instance.
7. **Deleting an instance (FR-REC-4):**
   - "This and following" is a plain `DELETE`. Only one instance is open, so the series simply ends.
   - "This" is `POST /tasks/:id/skip {nextId?}`. The occurrence goes to Trash and the next instance is created as if the task had been completed today. `422 not_recurring` without a rule.
   - Bulk delete is always a plain delete.
8. **Clearing.** `dueDate: null` clears the rule and the basis, and `recurrence: null` stops the series. A PATCH that replaces the due unit without naming the recurrence fields keeps them. An instance's rule changes only that instance and those that follow it.
9. **The iCal feed** lists only the open instance, with no RRULE (§4), so calendars never show instances that don't exist yet.

## 2. Task reminders (WP 10.4)
1. **Resolution.** `fire_at` is computed by core `resolveFireAt` for the reminder's owner (their timezone and `prefs.allDayReminderTime`, default 09:00). It is recomputed in the same transaction as:
   - any change to the task's due unit, for every user's reminders on the task;
   - a change of the owner's timezone or `allDayReminderTime`;
   - the creation of a recurring next instance.
2. **Clearing the due date makes relative reminders dormant** (`fire_at` NULL); they are not deleted. Setting a due date again revives them, so undoing a cleared date restores them with no extra ops.
   - The UI lists dormant reminders muted ("needs a due date") with a remove button, and they never fire.
   - This refines FR-REM-2's "removes": from the user's side they are gone until the task has a date again.
3. **Firing.**
   - The `task-reminders` job runs every minute and once at boot. It takes `fire_at <= now AND fired_at IS NULL`, oldest first, in batches.
   - Each row is claimed (`UPDATE … SET fired_at = now WHERE id = ? AND fired_at IS NULL`) before anything is sent, so it fires exactly once across restarts and overlapping runs (AC-10.4).
   - A claimed row is dropped silently when:
     - the task is completed or deleted;
     - the owner can no longer read it, or is disabled;
     - it is more than 24 h overdue (`REMINDER_LATE_MAX_MS`).
   - Otherwise it becomes a `reminder` notification (no actor; data `{reminderId, fireAt, late}`), with `late` meaning more than 10 minutes after `fire_at` (the grace window of ADR 0035).
   - In-app, push and email follow the "Task reminders" preference row: by default in-app and push on, email off.
   - Email goes out immediately, never batched, because a reminder is time-bound.
   - It is the one notification sent for the user's own actions (FR-REM-3).
   - The push carries the tag `reminder:<taskId>`, the task title as its title, and the due moment as its body.
4. **Privacy.**
   - Reminders, `nextReminderAt` and reminder SSE invalidations are for the owner only. Another member never sees the bell or the reminder (AC-10.4).
   - Reminder changes publish a `direct` per-user invalidation (`DomainEvent.direct`), not an org-wide one.
   - Removing a member deletes their reminders on that org's tasks.
5. **Limits and idempotence.** There are at most 5 reminders per user per task, fired ones included until removed (`409 too_many_reminders`). Creating an identical reminder (same offset, or same instant) returns the existing one. An absolute reminder more than a minute in the past is `422 reminder_in_past`.
6. **Grants.** Reminders need the task to be readable and, for grants, the `tasks:write` scope. Group write constraints do not apply, because a reminder changes nothing that others see.
7. **Clients.**
   - The web sends reminder creates and deletes through the outbox, as ops `reminder.create` and `reminder.delete` (like follows, ADR 0028), and computes `nextReminderAt` optimistically with `resolveFireAt`.
   - The `!15m` token in a title becomes `reminders` on the task create. `parse: true` does the same on the server, for the CLI and MCP.

## 3. Attachments and avatars (WP 10.2)
1. **Upload.**
   - One multipart `file` per request, streamed by busboy into a temp file under `<dataDir>/tmp`, counted while streaming and aborted above the limit with `413 payload_too_large` (AC-10.2). Temp files are removed in `finally`, and boot clears the directory.
   - The `/api/v1` 1 MB body limit does not apply to the upload routes; they enforce `ROOSTER_UPLOAD_MAX_MB` (default 25) and 2 MB for avatars themselves.
   - Uploads are online-only and bypass the idempotency middleware.
   - At most 100 live attachments per task (`409 too_many_attachments`).
2. **Type.**
   - The stored `mime` is sniffed with `file-type`, never taken from the client. An undetected type is `text/plain` when the content is UTF-8 text without NUL bytes, and `application/octet-stream` otherwise.
   - A declared raster image (by part `Content-Type` or extension) whose sniffed type differs is rejected with `415 mime_mismatch` (10 §5 "uploads with a spoofed mime rejected").
   - SVG is never an image here: it only downloads.
3. **Images.** PNG, JPEG, GIF, WebP and AVIF get their size from sharp and a WebP thumbnail that fits inside 320 × 320 px, EXIF-rotated and never enlarged.
   - sharp runs with `limitInputPixels` (40 MP) and `failOn: 'error'`. If thumbnailing fails, the file is kept without a thumbnail.
4. **Storage.**
   - `BlobStore { put, get, delete, signedUrl? }` (04 §4.8), with key schemes `<orgId>/<attachmentId>`, `<orgId>/<attachmentId>.thumb.webp` and `avatars/<userId>`. Keys are validated against these shapes, so there is no traversal.
   - Local storage lives under `<dataDir>/attachments`. S3 is used when `ROOSTER_S3_BUCKET` is set.
   - `attachment.storage` records the backend, so changing the configuration doesn't orphan old files.
5. **Download.**
   - Every download first checks that the task is readable; otherwise `404` (AC-10.2).
   - Local storage streams the file with:
     - the sniffed type;
     - `Content-Disposition: attachment` (inline only for `?inline=1` on a raster image), with an RFC 5987 file name;
     - `X-Content-Type-Options: nosniff` and `Content-Security-Policy: default-src 'none'; sandbox`;
     - `Cache-Control: private, max-age=300`.
   - S3 answers `302` to a 60 s presigned URL that carries the same type and disposition (`no-store` on the redirect).
6. **Delete** is allowed for the uploader or the task's assignee, otherwise `403`. It removes the row and then the blobs after commit; there is no undo.
   - Blobs are deleted through a queue. An `AFTER DELETE` trigger on `attachment` (migration 0011) writes every deleted row's keys to `blob_gc`, whatever path deleted it: DELETE, a task purge or permanent delete cascading, or an org deletion.
   - A blob GC job drains the queue every minute, and the attachment routes kick it after commit. Failures stay queued and are retried.
   - Activity records `attachment_added`.
7. **Avatars (FR-SET-1, deferred to P10).**
   - `PUT /me/avatar` takes a raster image of at most 2 MB and stores a 256 × 256 WebP (cover crop).
   - It sets `user.image` to `/api/v1/avatars/<userId>?v=<avatar_at>` and keeps the provider's picture in `user.oidc_image`. `DELETE` restores it.
   - Sign-in never overwrites an uploaded avatar.
   - `GET /api/v1/avatars/:userId` is for signed-in users who share an org with that user (themselves included), otherwise `404`, with `Cache-Control: private, max-age=86400`.
8. **Web.**
   - Uploads go through XHR in `src/data/attachments.ts`, for progress.
   - The whole pane is the drop zone. A pasted image anywhere in the pane, including the description editor, becomes an attachment, never inline content.
   - Raster images open in a lightbox (←/→, Esc, download).

## 4. Calendar feeds (WP 10.3)
1. **Tokens.**
   - A token is `rcal_` plus 32 random bytes in base64url, stored as a SHA-256 hash and shown once (04 §4.10).
   - A user has at most 10 feeds. `POST /me/ical-feeds {orgId?, replaces?}` regenerates by replacing a feed in the same transaction.
   - The request log redacts `/ical/<token>`.
2. **Access.**
   - `GET /ical/<token>.ics` takes no auth.
   - An unknown or revoked token, a disabled user, or an org feed whose user has left the org is `404`.
   - More than 20 misses per IP in 10 minutes gives `429` (10 §5, token brute force).
   - `last_used_at` is written at most every 5 minutes.
3. **Content.**
   - Events are the user's open, non-deleted tasks assigned to them that have a due date (subtasks included), in orgs they still belong to, from 90 days ago onwards, at most 1,000.
   - An all-day task is `DTSTART;VALUE=DATE` with `DTEND` the next day. A timed task is a 30-minute event in UTC (`…Z`).
   - `UID` is `<taskId>@<host>`, `SUMMARY` is `☐ <title>`, and `DESCRIPTION` and `URL` link to the task. The description text itself is not exported.
   - The calendar has `X-WR-CALNAME` "rooster – <org name>" (all orgs: "rooster"), `PRODID -//rooster//rooster <version>//EN`, and a 15-minute refresh hint.
   - The output follows RFC 5545: escaping, 75-octet folding that is UTF-8 safe, and CRLF line ends.
4. **Caching.** `Content-Type: text/calendar; charset=utf-8`, `Cache-Control: private, max-age=900`, and an ETag over the body with `304` (FR-CAL-2).

## Amendments: core (WP 10.1, 10.4)
- **Natural language:**
  - A new series starts on the first occurrence on or after today, so "every mon" typed on a Monday is due today; "after done" also starts today.
  - "after done" is only accepted after an interval phrase ("every 3 days", "weekly"), never after weekdays.
  - English "every 2nd/last fri" is the nth weekday of the month; "every other fri", "varannan fredag" and "var andra fredag" are every second week.
  - Recurrence phrases match only at the end of a title. A recurrence word that doesn't form a whole phrase still blocks a one-off date.
- **Week cadence:** weeks start on Monday, anchored on the current due date, so each instance anchors the next.
- **Reminder tokens:**
  - A token must be its own word, followed only by other tokens or one unbroken date phrase.
  - `!29d` (over the four-week maximum), `Ship it!` and `!1h later` stay plain text.
  - `>Group` and `@name` may be followed by reminder tokens.
- **Partial recurrence patches:** `recurrenceBasis` alone re-normalises the current rule; `recurrenceBasis: null` without `recurrence` changes nothing.
- **Reducers:**
  - `ReducerContext` gains `timezone` (for the completion date and all-day reminders) and `allDayReminderTime`.
  - The optimistic next instance has no subtask copies and `nextReminderAt: null`; the response fills them in.
  - A complete or skip response without `next` removes the optimistic instance. This is how "at most one open instance" reaches the client, which has no `seriesId`.
  - `reminder.delete` carries the deleted spec (not sent) as its undo.
- **New exports:** `firstOccurrence`, `recurrencePresets`, `presetOf`, `describeRule` (structured, for localisation), `reminderTokenSpans` and `touchesRecurrence`.

## Amendments: web, attachments and settings (WP 10.2, 10.3 web, FR-SET-1)
- **Paste:** an image becomes an attachment only when the clipboard has no `text/plain`, so a selection pasted from an office app stays text. Paste and drop are caught in the capture phase on `[data-pane-root]`, so the editor and the composer never see them. A pasted screenshot is named "Pasted image <date time>.png" (localised).
- **Uploads:**
  - They run one at a time per task in a module store, so closing the pane neither cancels them nor loses their progress.
  - Failures keep their reason: 413 (also a proxy's bare 413), `mime_mismatch` and 409 each have their own text, and other failures offer Retry.
  - The cache is updated from the 201; then the detail, `my-list`, `everyone` and `activity` are invalidated.
- **Layout:** images are a 3-column grid; everything else, SVG included, is a download row. Delete has an inline confirm, shown only to the uploader or the assignee, and only online.
- **Keys:** `Tab+U` (`attachFile`) opens the file picker from the pane. The lightbox has its own keymap scope (←/→ wrap around, Esc), swipes on touch, preloads its neighbours, and returns focus to the last image's thumbnail.
- **Calendar feed:**
  - It is its own settings page between Notifications and Security, with a phone index entry.
  - The URL is shown once, with Copy and a `webcal://` Subscribe link.
  - "New link" regenerates (`replaces`) and Revoke has a danger confirm. At 10 feeds the New button is disabled.
- **Avatar:** Upload/Change and Remove (only shown for an uploaded picture). The type and the 2 MB limit are checked on the client too. `/me` is updated, and member, everyone, activity and notification caches are invalidated.

## Amendments: web, recurrence and reminders (WP 10.1, 10.4 web)
- **Picker:**
  - A second footer row holds "↻ Repeat" and "🔔 Reminder" (Alt+R). Open sections stack below it, and the popover scrolls.
  - Repeat changes are a draft that keeps the popover open. Enter or a click outside commits them, and Esc discards them. Choosing a day still commits and closes.
  - A preset is stored by id and follows the chosen date: "Weekly" moves with the task.
  - Custom offers every N of a unit, weekdays, day of the month / nth / last weekday, "Count from completion", and an end (never, a date or a count).
  - Choosing a repeat without a date sets the date from `firstOccurrence`.
- **Reminders:**
  - Chips show dormant reminders muted with "needs a due date", and fired ones muted.
  - Presets that already exist are disabled; at 5, none are offered.
  - Custom accepts `2h`/`1d`/`due` or a phrase; a date without a time uses `allDayReminderTime`.
  - Adding a reminder first saves the date draft, so a relative reminder resolves against the new date.
- **Pane:** the reminders sit as a second line in the Due date cell, followed by a Repeat row ("Doesn't repeat" or the rule). On phones, both the date sheet and the pane sheet have Repeat and Reminders rows.
- **Recurring delete:**
  - Applies to an open recurring task with a due date: an anchored popover on desktop (row, or the pane's ⋯), a sheet on phones.
  - "Delete this task" is focused first, with toasts "Task deleted · the series continues" and "… it no longer repeats".
  - Bulk delete stays plain. Recurring tasks inside a multi-select complete one by one, each with a `nextId`.
- **Title tokens:** `!1h` applies only when the title has a date phrase or the task already has a due date; otherwise it stays plain text.
- **Row meta order:** description, bell, subtasks, paperclip count, repeat.
- **Settings:** "All-day reminder time" sits in Timing, which is now always shown.

## Amendments: server, recurrence and reminders (WP 10.1, 10.4 server)
- **`nextId` and skip:**
  - A `nextId` (or reminder id) that is already taken is `409 id_conflict`, and nothing changes.
  - Skip needs `tasks:delete` and honours the `deleted` clock; a stale skip returns `{next: null}`.
- **Patches:** a rule-only PATCH keeps the dates; a basis on a task without a rule is 422.
- **The next instance:**
  - It copies followers including muted ones, so an unfollow sticks, and keeps the original `createdBy`.
  - Copied subtasks keep their own assignee and tags, and each gets a `created` activity.
- **Reminder state:**
  - `nextReminderAt` is null on completed or deleted tasks; reopening brings the bell back while the reminder is still unfired.
  - A fired relative reminder is re-armed when a due change moves it into the future.
  - One whose resolved time is already past fires at the next run, marked late after 10 minutes.
  - Reminders can be added to completed tasks.
- **`parse: true`:** `!` tokens on a task that ends up without a due date give `422 reminder_needs_due`.
- **Routes and events:**
  - `GET /tasks/:id/reminders` lists the actor's reminders.
  - Reminder changes publish a `task.updated` invalidation to the owner only (an audience of one), not `DomainEvent.direct`, which carries no invalidations. This is a deviation from §2.4, with the same privacy.
- **Delivery:**
  - Reminder emails go out at once regardless of `emailMode`. The push body is the localised due moment, with a delay note when late.
  - The notification's `data.to` holds the due date and time when it fired, so the inbox can show "due Fri 14:00".

## Amendments: server, attachments and calendar feeds (WP 10.2, 10.3 server)
- **Uploads:**
  - Access is checked before any byte is read, and again in the transaction that records the attachment.
  - A file exactly at the limit is accepted. A declared Content-Length above the limit plus 64 KB is 413 at once.
  - A missing `file` part is `422 validation_failed`, and a body that isn't multipart is 415.
  - An `Idempotency-Key` on an upload is format-checked but never stored.
  - CSRF origin checks still apply; multipart is allowed only on the two upload routes.
- **Type check:** strict. The claimed raster type (from the part type with aliases normalised, or else the extension) must equal the sniffed type, so a PNG named `.jpg` is 415. For avatars, a non-image is `415 unsupported_media_type`.
- **File names:** the last path segment, NFC-normalised, without control, bidi or BOM characters, trailing dots and spaces trimmed, at most 255 characters keeping the extension. An empty name becomes `file.<ext>`.
- **Trash:** attachments of a task in Trash can still be downloaded; uploads and deletes there are `410 conflict_deleted`. Delete also needs `tasks:write` within the grant's groups.
- **Events and blob GC:**
  - Attachment changes publish `task.updated`.
  - Blob GC is kicked after a delete, after a failed upload, and on `task.purged`/`org.deleted`. The retention purge waits for the minute job.
- **Avatars:**
  - They live in the current backend, are always streamed (never presigned), and fall back to the other backend on read.
  - DELETE removes the blob directly, because the key is reused. PUT and DELETE are serialised per user and need the browser session. GET accepts any credential, through the orgs it reaches.
  - better-auth does not overwrite `image` on sign-in today; an update hook re-asserts the uploaded avatar as a safeguard.
- **Calendar feeds:**
  - Managing feeds is browser-session only, and replaying a create is `409 token_shown_once`.
  - Once an IP is over the miss limit, all its feed requests are 429.
  - DTSTAMP is the task's `updatedAt`, so the ETag is stable. All-day events are TRANSP:TRANSPARENT.
- **S3:** checksum calculation `WHEN_REQUIRED` for compatible stores; presigned redirects carry `private, max-age=60`; the endpoint must be http(s).

## Amendments: CLI and MCP (07)
- **`--remind`:**
  - `15m`/`1h`/`1d`/`due` (an optional leading `!`) are relative. Anything else is parsed as a date phrase into an absolute instant in the user's timezone; a date without a time uses `allDayReminderTime`.
  - Recurrence phrases are rejected (exit 5), and duplicates collapse.
  - MCP `remind` takes one string or up to 5.
- **`edit --no-remind`** sends `clearReminders`; together with `--remind` it clears first, then adds, in one PATCH.
- **Recurrence:**
  - A recurrence phrase in `--due` or MCP `due` sets both the date and the rule.
  - `--repeat <phrase|none>` (MCP `repeat`) never moves an existing due date, and gives a task without one the phrase's first occurrence.
  - `rm --occurrence` uses skip; a plain `rm` and the TUI Delete end the series.
- **TUI `d`:**
  - Accepts recurrence phrases and `!` tokens.
  - Undo restores the old date and rule, and removes only the reminders this change created (201, never 200).
- **TUI `x`** on a recurring task shows the next date. Undo reopens the task and moves the next instance to Trash (amends ADR 0047 §3).
- **Display and MCP data:**
  - `↻` and `🔔` mark recurring rows and rows with a pending reminder in `ls`, task lines and the TUI. `show` and the TUI details list the rule, reminders and attachments, all through `clean()`.
  - MCP rows carry `repeat`, `repeatFrom` and `nextReminder`; `get_task` carries reminders and attachments inside the framed data block. `remind`, `clearReminders` and `repeat` need only `tasks:write`.
