# ADR 0040: Hardening after the first security review

- Status: accepted
- Date: 2026-10-09
- Amends: 06 §1 (idempotency), 08 (push key rotation), 11 §2.3 (grant enforcement), ADRs 0033, 0035, 0037, 0039
- Code: `apps/server/src/lib/idempotency.ts`, `services/{grant-access,grant-service,task-service,notification-service,activity-service}.ts`, `events/hub.ts`, `push/{endpoint,push-service}.ts`, `lib/request-log.ts`, `packages/core/src/{push-hosts,comment-markdown}.ts`, `apps/web/src/data/push.ts`, `apps/cli/src/{secrets,editor,completion}.ts`, migration `0008_grant_hardening`

## Context
An independent security review of Phases 6–8 (structured plus security-focused) found exploitable gaps that the earlier reviews had missed, all reproduced by the reviewer. From now on, security-relevant changes always get an independent review.

## Decisions
1. **Idempotent replays are bound to their credential.**
   - A stored response records the credential (`session` or `grant:<id>`) and the grant's version.
   - Another credential replaying the key gets `422 idempotency_key_reuse`, and a replay after the grant changed gets `409 idempotency_stale`.
   - Secret-bearing responses (a new PAT) are never stored; their replay is `409 token_shown_once`.
   - Migration 0008 purges stored PATs.
2. **Grant checks cover every task a change touches**:
   - duplicate (each copied subtask);
   - create (the group the task lands in after reconcile);
   - reassign and re-parent (the before and after groups of the task and its children);
   - delete, restore and permanent delete (the whole subtree).

   Reads that reference other tasks are filtered: notifications (org reach and task readability, also for mark read and unread), SSE keys (per task and per scope), activity entries naming hidden tasks, and ref resolution (filtered before its scan limit).
3. **Push endpoints are canonical.**
   - Only `new URL(u).href` is stored, checked and sent, and `isAllowedPushEndpoint` refuses anything else.
   - The legacy `url.parse` used inside `web-push` must agree on the host.
   - Trailing-dot and IP hosts are refused.
   - Queued sends re-read the subscription and skip it if it was removed or moved to another user.
4. **No silent re-subscription.**
   - The service worker and the app renew a push subscription only through `renewsEndpoint`, which must name a live subscription of the same user (`410 push_gone` otherwise).
   - Sign-out removes this device's subscription on the server and in the browser, and a 401 or user switch unsubscribes locally.
   - Rotating the push keys therefore turns push off on every device until each user turns it on again.
   - Known gap: if the browser replaces a subscription without telling the worker about the old one, push stops on that device. Settings shows "off".
5. **Secrets stay out of logs**: request logs redact `/unsubscribe/:token` as well as invite tokens.
6. **The CLI binds credentials to their server origin**, and never sends a stored login to another `ROOSTER_SERVER`.
   - Each profile has exactly one credential store, chosen at login and recorded with the origin. Reads never merge or fall back. A first design that merged keychain and file by newest-wins kept producing races in later review rounds and was replaced (ADR 0039 §7).
   - Descriptions are edited as `description.md` in a fresh 0700 directory.
   - Everything printed is stripped of control and escape sequences.
   - The completion scripts never expand server-provided or typed text.
7. **Untrusted text must not cost superlinear time**: the comment parser trims URLs and matches emphasis in linear time, with 20,000-character worst cases under 50 ms in tests.
8. **Unauthenticated storage is bounded**: device-code scopes are limited to 512 bytes, known values and canonical order, and expired device codes are purged.
