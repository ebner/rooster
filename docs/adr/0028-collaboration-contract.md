# ADR 0028: The Phase 6 collaboration contract

- Status: accepted
- Date: 2026-10-09
- Amends: 04 §6.2 (which ops go through the pipeline), 06 §2.6 (comment restore, payload shapes), 02 §9.2 (the composer)
- Code: `packages/core/src/schemas/collab.ts`, `packages/core/src/mentions.ts`, `packages/core/src/reducers/ops.ts`, `packages/core/src/schemas/events.ts` (`sseNotificationSchema`)

## Context
06 §2.6 names the collaboration routes but not their payloads, and the spec does not say whether comments work offline or what the comment composer is.

## Decisions
1. **Comments and follow/unfollow go through the mutation pipeline**. New op kinds are `comment.create`, `comment.patch`, `comment.delete`, `comment.restore` and `task.follow`. They carry an `Idempotency-Key`, are written to the outbox, and update the `['activity', taskId]` and `['task', taskId]` caches optimistically. A comment typed offline shows at once and syncs later. Marking notifications read or unread is online-only (plain TanStack mutations with an optimistic cache update).
2. **Undo of a comment delete** uses `POST /comments/:id/restore` (an addition to 06 §2.6), as tasks and groups do. Deleted comments are soft-deleted and drop out of the feed.
3. **The composer is a plain textarea**. Typing `@` opens a member autocomplete that inserts `@[Name](user:<id>)`. A posted comment is rendered by a small pure Markdown-light renderer (bold, italic, code, links, lists, mention chips) with no raw HTML. There is no new dependency, and the composer stays out of the lazy editor chunk.
4. **Activity entries are typed per `type`** (a discriminated union over `data`), and every entry has `via`. The feed (`GET /tasks/:id/activity`) pages back in time: items are oldest first within a page, and `nextCursor` continues with older items.
5. **Notifications are denormalised** for the cross-org `/inbox`: the actor's name and image, the task title and seq, and the org slug. The SSE `notification` event carries the unread count and a small preview. The other P6 caches are invalidated through the existing `invalidate` event with the keys `['everyone', orgId]`, `['activity', taskId]` and `['notifications']`.
6. **Assignment** is `assigneeId` on `PATCH /tasks/:id` (LWW key `assignee`), on create, and the bulk op `assign`. Everyone's tasks is `GET /orgs/:orgId/tasks?view=everyone` with `assignee` (repeatable: `me`, `none`, `any` or a user ID) and `hasDue`.
7. **The preference matrix** (`GET/PUT /me/notification-prefs`) holds only event × channel cells. Reminder and digest times stay in the `/me` prefs. P6 accepts only the `inapp` channel.
