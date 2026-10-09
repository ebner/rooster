# ADR 0029: Collaboration on the server (Phase 6)

- Status: accepted
- Date: 2026-10-09
- Amends: 05 §3 (the `comment` purge, `notification` retention), 06 §2.3–2.6 (error codes, the everyone rows, notification rules)
- Code: `apps/server/src/services/{activity,comment,follower,notification}-service.ts`, `routes/collab.ts`, `services/event-audience.ts`, `services/task-service.ts`, migration `0005_collab`

## Decisions
1. **Error codes.**
   - An invalid assignee gets `422 validation_failed` at path `assigneeId`. That covers a non-member, and anyone but the actor (including null) in a personal org.
   - `view=everyone` in a personal org gets `409 personal_org`; combined with `groupId` it gets `422`.
   - Following or unfollowing in a personal org gets `409 personal_org`.
   - Another member's comment gets `403 forbidden` for edit, delete and restore. A non-member gets `404`.
   - A write to a deleted comment, or any comment write on a deleted task, gets `410 conflict_deleted`.
   - Reusing a comment `id` with a different task or body gets `409 id_conflict`.
2. **Everyone's tasks rows.**
   - A task is a row iff `parent_id IS NULL OR parent.assignee_id IS NOT task.assignee_id`. This is the placement rule of 05 §4.1, with null treated as a value: an unassigned subtask of an unassigned parent shows only under its parent.
   - Sort: due date (no date last), then timed before untimed with times ascending, then created, then id. Core `everyone.ts` uses the same order.
   - `assignee` values are OR-combined, and the default is `any`. `hasDue` applies in every view.
3. **Assignee defaults.** A top-level task defaults to the actor. A subtask without `assigneeId` inherits its parent's assignee, as in P3. The `assigned` activity entry and notification on create are written only for an explicitly chosen assignee other than the actor.
4. **`@member` in `parse: true`** uses core `findAssigneeToken`, so the server and the web parse the same way. A whole name or email local part wins over a unique prefix, and case and accents are ignored. An ambiguous or unknown token stays in the title, and an explicit `assigneeId` wins over the token.
5. **Activity.**
   - `due_changed` is written only when the due date or time changes. A change to the start date alone is not logged.
   - Re-parenting writes `moved_parent` on the task and `subtask_added` on the new parent.
   - `restored` is written on the restored root only; deleting writes nothing.
   - A no-op patch writes nothing.
   - `via` comes from the `X-Rooster-Client` kind. Clients can claim only `web`, `pwa`, `cli`, `tui` and `mcp`, and anything else is `web`. `import` and `system` are server-only, and member removal writes `system` with a null actor.
6. **Notifications** are fanned out in the same transaction as the change. The rules:
   - The actor is never notified.
   - Recipients must be members of a live org.
   - A disabled in-app preference means no row.
   - A mention supersedes a comment notification for the same comment, and a mention reaches even a muted follower.
   - A new assignee gets no `due_changed` from the same patch.
   - Editing a comment notifies only members who are newly mentioned.
   - `invite_accepted` goes to the email invite's inviter, or to the link's creator.
   - The actor's name and the task title are snapshots.
   - After commit the recipient gets the SSE `notification` event, and marking read or unread sends a count-only event to all of the user's streams.
7. **Followers.** Auto-follow happens only in shared orgs, and a muted row blocks it. Follow order is rowid order, so a re-follow keeps its original place. Member removal deletes the member's follower rows and notifications in that org.
8. **Retention.** The trash purge hard-deletes comments deleted more than 30 days ago (until then, restore works) and read notifications older than 90 days.
9. **Search and export.** `task_fts.comments` holds the live comments, and every comment write reindexes its task (completing ADR 0013). The export lists the comments of the exported tasks with the author's name.
