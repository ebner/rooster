# ADR 0025: A description indicator on list rows

- Status: accepted
- Date: 2026-10-09
- Amends: 03 §3.1 (row meta), §2.9 (icons); 05 §5 (TaskDTO)
- Code: `packages/core/src/schemas/list.ts`, `packages/core/src/reducers/apply.ts`, `apps/server/src/services/list-access.ts` (`toTaskDto`), `apps/web/src/features/list/task-meta.tsx` (`DescriptionIndicator`), `controller.ts` (`hasContent`)

## Context
Rows gave no sign that a task had a description, because list payloads omit `description` to stay small.

## Decisions
1. **`hasDescription: boolean`** is a derived, required TaskDTO field in every payload (list, detail, mutations, Trash, search, export): `description.trim() !== ''`, so whitespace counts as none. It is never stored or patched on its own.
2. **Optimistic mirror.** The core reducers recompute it from any description a create or patch carries; duplicate copies it; `mergeResponse` takes the server's value. Undo needs no change: the inverse patch restores the description, which recomputes the flag.
3. **Row.** A muted 12 px `align-left` icon (the Trello/Jira convention) sits in the row meta just before the subtask counter. It is icon-only and not interactive, with the same "Has description" text as its tooltip and screen-reader label.
4. **Backspace guard.** `hasContent` uses `hasDescription` for list tasks (02 §3: Backspace in an empty title deletes a task without a description). For a cache persisted before the field existed, it falls back to the old rule: only tasks created in this session are known to have none.

## Consequences
A cache persisted before this change shows no indicators until the next refetch replaces the tasks; the cache key is not bumped.
