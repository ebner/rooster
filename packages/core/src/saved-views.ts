import type { DueContext } from './dates/index.ts';
import { compareRows, type EveryoneMember } from './everyone.ts';
import { compareKeys } from './ordering.ts';
import type { Task } from './schemas/list.ts';
import type { SavedViewQuery } from './schemas/views.ts';
import { inSmartView } from './views.ts';

/**
 * Phase 13 (ADR 0073 B): views, saved queries in one org. Pure, so the web (over its caches,
 * offline too), the server (`GET /views/:id/tasks`, the sidebar counts), the CLI and MCP agree
 * on which tasks a view holds and how they are grouped.
 *
 * A task is a row when it matches itself (B5): a matching subtask is a row of its own (it shows
 * a breadcrumb), and a matching parent does not pull in its subtasks.
 */

export interface SavedViewContext {
  viewerId: string;
  /** For the `due` filter (the viewer's today and timezone). */
  due: DueContext;
}

/** The tag, assignee and due filters: what a view is about, whatever the completion. */
export function matchesViewFilters(task: Task, query: SavedViewQuery, ctx: SavedViewContext) {
  if (task.deletedAt !== undefined && (task.deletedAt as number | null) !== null) return false;
  if (query.tags.length > 0) {
    const has = (id: string) => task.tagIds.includes(id);
    if (query.tagMode === 'all' ? !query.tags.every(has) : !query.tags.some(has)) return false;
  }
  switch (query.assignee) {
    case 'anyone':
      break;
    case 'me':
      if (task.assigneeId !== ctx.viewerId) return false;
      break;
    case 'unassigned':
      if (task.assigneeId !== null) return false;
      break;
    default:
      if (task.assigneeId !== query.assignee) return false;
  }
  switch (query.due) {
    case 'any':
      return true;
    case 'none':
      return task.dueDate === null;
    case 'today':
    case 'week':
    case 'overdue':
      // Classified as if open, like the smart views: a completed task keeps its place.
      return inSmartView(task, query.due, ctx.due);
  }
}

/**
 * Whether the view lists the task: its filters, and its status (`open` hides completed tasks
 * unless `showCompleted`, the header's toggle; `done` lists only completed ones).
 */
export function matchesSavedView(
  task: Task,
  query: SavedViewQuery,
  ctx: SavedViewContext & { showCompleted?: boolean },
): boolean {
  if (!matchesViewFilters(task, query, ctx)) return false;
  const done = task.completedAt !== null;
  switch (query.status) {
    case 'open':
      return !done || ctx.showCompleted === true;
    case 'done':
      return done;
    case 'any':
      return true;
  }
}

/** "7 open · 12 done" (B3): matches of the filters by completion, ignoring the status filter. */
export function savedViewCounts(
  tasks: Iterable<Task>,
  query: SavedViewQuery,
  ctx: SavedViewContext,
): { open: number; done: number } {
  const counts = { open: 0, done: 0 };
  for (const task of tasks) {
    if (!matchesViewFilters(task, query, ctx)) continue;
    if (task.completedAt === null) counts.open++;
    else counts.done++;
  }
  return counts;
}

/** A view with exactly one tag is a project view (B3). */
export function isProjectView(query: Pick<SavedViewQuery, 'tags'>): boolean {
  return query.tags.length === 1;
}

export interface SavedViewSelectContext extends SavedViewContext {
  /** The org's members (names for the alphabetical order). */
  members: readonly EveryoneMember[];
  /** The UI locale, for the name collation. */
  locale: string;
  /** A personal org has no person sections: one section, the viewer's. */
  isPersonal: boolean;
  showCompleted?: boolean;
}

export interface SavedViewSection {
  /** Null: Unassigned. */
  assigneeId: string | null;
  /** Rows in display order: by due date (no date last; timed first on a day), then created. */
  taskIds: readonly string[];
  /** Open rows in the section (the header count). */
  openCount: number;
}

/**
 * The sections of a view (B4), as Everyone's tasks: me, the other members alphabetically, then
 * assignees who are no longer members (by ID), then Unassigned. Each section of a member (and
 * Unassigned) is present even when empty, since its header has an inline add, unless the view's
 * assignee filter names one person (or Unassigned): then only that section. A personal org has a
 * single section, the viewer's.
 */
export function selectSavedView(
  tasks: Iterable<Task>,
  query: SavedViewQuery,
  ctx: SavedViewSelectContext,
): SavedViewSection[] {
  const rows = new Map<string | null, Task[]>();
  for (const task of tasks) {
    if (!matchesSavedView(task, query, ctx)) continue;
    const key = ctx.isPersonal ? ctx.viewerId : task.assigneeId;
    const list = rows.get(key);
    if (list) list.push(task);
    else rows.set(key, [task]);
  }
  const section = (assigneeId: string | null): SavedViewSection => {
    const list = (rows.get(assigneeId) ?? []).sort(compareRows);
    return {
      assigneeId,
      taskIds: list.map((t) => t.id),
      openCount: list.filter((t) => t.completedAt === null).length,
    };
  };
  if (ctx.isPersonal) return [section(ctx.viewerId)];
  switch (query.assignee) {
    case 'me':
      return [section(ctx.viewerId)];
    case 'unassigned':
      return [section(null)];
    case 'anyone':
      break;
    default:
      return [section(query.assignee)];
  }
  const collator = new Intl.Collator(ctx.locale, { sensitivity: 'base' });
  const others = ctx.members
    .filter((m) => m.userId !== ctx.viewerId)
    .sort((a, b) => collator.compare(a.name, b.name) || compareKeys(a.userId, b.userId))
    .map((m) => m.userId);
  const known = new Set([ctx.viewerId, ...others]);
  const strangers = [...rows.keys()]
    .filter((id): id is string => id !== null && !known.has(id))
    .sort(compareKeys);
  return [ctx.viewerId, ...others, ...strangers, null].map(section);
}

/**
 * A query after tag changes (B11): `deleted` tags are removed; `merged` maps a tag to the one it
 * was merged into (deduplicated). Returns the same object when nothing changed.
 */
export function remapViewQuery(
  query: SavedViewQuery,
  change: { deleted?: readonly string[]; merged?: Readonly<Record<string, string>> },
): SavedViewQuery {
  const deleted = new Set(change.deleted ?? []);
  const merged = change.merged ?? {};
  const tags: string[] = [];
  for (const id of query.tags) {
    if (deleted.has(id)) continue;
    const to = merged[id] ?? id;
    if (!tags.includes(to)) tags.push(to);
  }
  const same = tags.length === query.tags.length && tags.every((id, i) => id === query.tags[i]);
  return same ? query : { ...query, tags };
}
