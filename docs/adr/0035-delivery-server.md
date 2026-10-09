# ADR 0035: Push, email and the scheduler on the server (Phase 7)

- Status: accepted
- Date: 2026-10-09
- Amends: 04 §4.6 (job timing), 06 §2.6 (unsubscribe: GET confirms, POST acts), 08 (env vars, boot)
- Code: `apps/server/src/push/*`, `src/mail/*`, `src/routes/{push,unsubscribe}.ts`, `src/services/{pref-store,job-runs,assigned-tasks,deliverable}.ts`, `src/jobs/register.ts`, `src/lib/task-queue.ts`, migration `0006_delivery`

## Decisions
1. **Scheduled sends have a 10-minute grace window.**
   - The reminder and digest jobs run every minute. A user is due when their local time is between the target and target + 10 minutes, and the `job_run(job, "<userId>|<local date>")` claim is free.
   - The claim is taken before sending, so a crash loses a send rather than repeating it. A restart at 07:59:30 therefore still sends exactly one 08:00 reminder (AC-7.1).
   - Yesterday is also checked, so a 23:55 send that fires after midnight counts for the right day.
   - A time skipped by DST fires at the shifted instant, and a repeated time fires only at its first occurrence.
   - The reminder claims the day even when nothing is due, so a task added later that morning never triggers a late reminder.
2. **The due reminder** lists the Today view across the user's live orgs: overdue plus due today, open, subtasks included.
   - The title is "N tasks today", and the body holds the first three titles and "and N more".
   - It opens the Today view of the org with most of those tasks.
3. **Email batching.** A notification to be emailed is marked pending.
   - Every 5 minutes, a user whose oldest pending notification is at least 15 minutes old gets all of them in one email. A batch of one uses the single-notification template.
   - Cells switched off in the meantime are left out, and pending items older than 24 hours are dropped.
   - The send is claim-then-send (`emailed_at` first, reset on failure). An immediate email that fails waits for the next batch.
4. **The digest** has three sections: Overdue, Due today, and New in your Inbox (open tasks placed in the user's Inbox groups since the last digest, or the last 24 hours).
   - Each section is capped at 10 items. The org name is shown only when the tasks span several orgs.
   - An empty digest is not sent.
   - Every digest and reminder query joins `member` and checks that the org is live.
5. **In-app off, push or email on.** When a type is off in-app but on for push or email, a hidden, already-read row carries the delivery state. The inbox, the unread count and mark-read never show it.
6. **Push.**
   - TTLs: notifications 24 h at `normal` urgency, reminders 4 h `high`, the test push 5 min `high`. Encoding is aes128gcm with a 15 s timeout.
   - A 404 or 410 from the push service deletes the subscription.
   - `isAllowedPushEndpoint` is checked again before every send (ADR 0033), and redirects are never followed.
   - Sends run after commit through a bounded queue (concurrency 4), which is drained on shutdown.
7. **Email markup.** The wordmark in email is text ("rooster" in a serif face), not SVG or an image: Gmail and Outlook drop inline SVG, images are often blocked, and the rooster is drawn only from `brand.ts`. The layout is tables with inline styles using token values.
   - Every email carries a hidden preview line, one unsubscribe link per category, and the headers `List-Unsubscribe`, `List-Unsubscribe-Post` and `Auto-Submitted`.
   - Invites carry no unsubscribe header, because there is no user yet.
8. **Unsubscribe confirms before acting** (amends 06 §2.6). Mail scanners such as Outlook Safe Links open links in advance, so `GET /unsubscribe/:token` only shows a localised page with an "Unsubscribe" button: a form that POSTs to the same URL, with no JavaScript.
   - `POST` (the button, or RFC 8058 one-click) turns off exactly that category's email cell, and is idempotent.
   - The route sits outside `/api/v1`: no session, no Origin check, and its own limit of 30 per minute per IP.
   - The token is `<userId>.<category>.<HMAC-SHA256>`, keyed with `ROOSTER_AUTH_SECRET`, and never expires.
   - The service worker leaves `/unsubscribe/*` to the server.
9. **Invite email language** is the invitee's locale if the address belongs to an existing user, otherwise the inviter's. Link invites never send email.
10. **Configuration.**
    - `ROOSTER_SMTP_URL` (`smtp:` or `smtps:`) needs `ROOSTER_MAIL_FROM`.
    - VAPID keys come from the env (both or neither) or are generated once at boot into `instance_setting`. Regenerating them through the admin is refused (`409 push_keys_from_env`) when they come from the env.
    - Invalid values exit with code 78.
11. **Retention.** The daily purge also drops `job_run` rows older than 30 days.
12. **Bundle.** The server build defines `process.env.NODE_ENV` as production, so react ships one build. Prettier, which `@react-email/render` imports only for its unused `pretty` option, is aliased to a stub.
