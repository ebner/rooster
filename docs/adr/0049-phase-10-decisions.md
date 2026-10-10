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
