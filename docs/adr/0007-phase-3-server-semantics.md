# ADR 0007: Phase 3 server semantics (subtasks, detail, tags)

- Status: accepted
- Date: 2026-10-05
- Refines: 05 §4.1, §4.3 and §4.4; 06 §2.3–2.5; contract `packages/core/src/schemas/{list,tags}.ts`

## Subtasks
1. **Depth** counts ancestors: a top-level task has depth 0, and a task may have at most 5 ancestors (`SUBTASK_DEPTH_MAX`).
   - A move checks the height of the whole subtree being moved, including deleted descendants.
   - Errors: `422 subtask_cycle`, `422 subtask_depth`.
2. **Bad parent:** a missing, invisible or other-org parent gets `422 invalid_parent` (existence is not leaked). A deleted parent gets `410`.
3. **Assignee and placement:**
   - A subtask's assignee defaults to the parent's assignee, which may be null.
   - Without an intent, a subtask goes to the end of its siblings, and `groupId` is ignored.
   - Deleted siblings keep their keys.
4. **Re-parent with `parentId: null`:** an existing placement for the same user is kept. Otherwise the task goes to the top of the assignee's Inbox.
5. **Restoring a subtask whose parent is still in Trash** brings it back as a top-level task.
6. **Due unit:** if any of `dueDate`, `dueTime`, `dueTz` or `startDate` is present, the whole unit is replaced, matching the core reducer's `touchesDue`. The service also validates the merged unit itself, because bulk, `parse` and the CLI bypass the route schema.
7. **my-list:**
   - Subtasks of placed tasks are included at any depth, open or completed, and regardless of the completed-since window.
   - Order: placed tasks first, then the extras by parent and position.
8. **Duplicate:**
   - The top copy is reopened, and each copy is assigned like a create.
   - Subtasks keep their keys under the new parent.
   - A repeated client `id` returns the existing copy.
   - The response carries only the top task, so clients refetch my-list to see the copied subtasks.

## Tags
9. **Names** are unique per org, ignoring case (including non-ASCII names such as "Ärende").
10. **Colours** go round-robin by the org's current tag count.
11. **No LWW clocks.** Tag membership uses set semantics. `task_tag.added_at` plus insertion order sets the chip order, and a merge keeps the merged tag's slot.
12. **Cross-org tags:** a tag from another org gets 404 on the tag routes and 422 in a create's `tagIds`.
13. **Filter:** `?tag=` accepts an ID or a name, and an unknown value matches nothing.

## Expansion
14. Expanding a deleted task gets 410, and collapsing always succeeds. A member's expansions in an org are deleted when they are removed from it.

## Follow-ups
- **P4:** two offline devices creating the same tag name. The second gets `409 tag_name_taken`, and the outbox must map it to the existing tag.
- **P8:** server-side `parse: true` should also read `#tag` tokens.
