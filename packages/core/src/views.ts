import { addDays, type DueContext, diffDays, dueState, type IsoDate } from './dates/index.ts';
import { compareKeys } from './ordering.ts';
import { compareSubtasks, orderedGroups } from './reducers/state.ts';
import type { Group, Task } from './schemas/index.ts';

/**
 * Smart views (01 FR-VIEW-1, 02 §10, 04 §5.1). Pure selectors shared by the web client (over the
 * cached `ListState`, so views work offline) and the server's `GET /orgs/:id/tasks?view=`.
 *
 * Every smart view covers the open tasks **assigned to the viewer**, subtasks included, and
 * excludes deleted tasks. `ctx.showCompleted` also includes completed ones. Dates are evaluated
 * with the `dates` helpers in the viewer's timezone (floating dates stay strings).
 *
 * Ordering (ADR 0012): within a section, tasks follow the **My tasks order**: group order, then
 * position, with a subtask that has no placement of its own (its parent is mine too) directly
 * after its parent, in sibling order. The Overdue section sorts by due date first (untimed after
 * timed on the same date, timed by `dueTime`), with the My tasks order as the tiebreak. Tasks
 * the My tasks order cannot reach (no placement and no placed ancestor of mine, or a placement in
 * an unknown group) go last, by `createdAt`, then ID.
 *
 * Completed tasks (with `showCompleted`) are classified as if they were open, so a task completed
 * in a view stays in its section.
 */

export const SMART_VIEWS = ['today', 'week', 'overdue', 'nodate'] as const;
export type SmartView = (typeof SMART_VIEWS)[number];

/** Days covered by Next 7 days (today … today + 6). */
export const WEEK_DAYS = 7;

/** `ListState` satisfies this; the server builds one from its rows. */
export interface ViewSource {
  groups: Readonly<Record<string, Group>>;
  tasks: Readonly<Record<string, Task>>;
}

export interface ViewContext extends DueContext {
  viewerId: string;
  /** Include completed tasks (the header's "Show completed"). */
  showCompleted: boolean;
}

/**
 * - `overdue`: past due (Today's first section, and the whole Overdue view), due ascending.
 * - `today`: due today (Today's second section).
 * - `day`: one day of Next 7 days; `date` is that day (today … today + 6).
 * - `flat`: the single section of No date (group order, then position, mirroring My tasks).
 */
export type ViewSectionKind = 'overdue' | 'today' | 'day' | 'flat';

export interface ViewSection {
  /** Stable within a view: `overdue`, `today`, `flat`, or the ISO date of a `day`. */
  id: string;
  kind: ViewSectionKind;
  /**
   * The due date a task created inline in this section inherits (02 §3.4): today for `today`,
   * the day for `day`, null for `flat`. Null for `overdue` too: Overdue has no inline add.
   */
  date: IsoDate | null;
  /** Ordered task IDs (top-level tasks and subtasks alike; rows show breadcrumbs). */
  taskIds: readonly string[];
}

export interface ViewCounts {
  /** Open tasks in My tasks (placed tasks; the sidebar's My tasks badge). */
  my: number;
  /** Today's badge: open tasks due today or earlier. */
  today: number;
  week: number;
  /** Shown in the danger tone only when > 0. */
  overdue: number;
  nodate: number;
}

/** Where a task falls, evaluated as if it were open. */
interface Bucket {
  /** Overdue: past due date, or a timed due whose instant has passed (ADR 0001). */
  overdue: boolean;
  /** `dueDate - today` in days; null without a due date. */
  days: number | null;
}

function bucketOf(task: Pick<Task, 'dueDate' | 'dueTime' | 'dueTz'>, ctx: DueContext): Bucket {
  if (task.dueDate === null) return { overdue: false, days: null };
  const days = diffDays(task.dueDate, ctx.today);
  const overdue =
    days < 0 || (task.dueTime !== null && dueState(dueInput(task), ctx) === 'overdue');
  return { overdue, days };
}

/**
 * Whether the task's due date puts it in a smart view, ignoring assignee and completion (a
 * completed task is classified as if open). Shared with the search `due:` filter.
 */
export function inSmartView(
  task: Pick<Task, 'dueDate' | 'dueTime' | 'dueTz'>,
  view: SmartView,
  ctx: DueContext,
): boolean {
  const bucket = bucketOf(task, ctx);
  if (bucket.days === null) return view === 'nodate';
  switch (view) {
    case 'today':
      return bucket.overdue || bucket.days === 0;
    case 'week':
      return bucket.days >= 0 && bucket.days < WEEK_DAYS;
    case 'overdue':
      return bucket.overdue;
    case 'nodate':
      return false;
  }
}

function dueInput(task: Pick<Task, 'dueDate' | 'dueTime' | 'dueTz'>) {
  return { dueDate: task.dueDate, dueTime: task.dueTime, dueTz: task.dueTz, completed: false };
}

function isLive(task: Task): boolean {
  // Server rows may carry an explicit null.
  return task.deletedAt === undefined || (task.deletedAt as number | null) === null;
}

function isMine(task: Task, viewerId: string): boolean {
  return task.assigneeId === viewerId && isLive(task);
}

/**
 * The My tasks rank of every live task assigned to the viewer (lower first). One sort of the
 * placed tasks plus one pass over the subtask index: O(n log n).
 */
function myTasksRank(mine: readonly Task[], groups: ViewSource['groups']): Map<string, number> {
  const groupIndex = new Map<string, number>();
  for (const group of orderedGroups({ groups })) groupIndex.set(group.id, groupIndex.size);

  const placed: { task: Task; group: number; position: string }[] = [];
  const unplacedChildren = new Map<string, Task[]>();
  for (const task of mine) {
    const group = task.placement ? groupIndex.get(task.placement.groupId) : undefined;
    if (task.placement && group !== undefined) {
      placed.push({ task, group, position: task.placement.position });
    } else if (!task.placement && task.parentId !== null) {
      const siblings = unplacedChildren.get(task.parentId);
      if (siblings) siblings.push(task);
      else unplacedChildren.set(task.parentId, [task]);
    }
  }
  placed.sort(
    (a, b) =>
      a.group - b.group || compareKeys(a.position, b.position) || compareKeys(a.task.id, b.task.id),
  );
  for (const siblings of unplacedChildren.values()) siblings.sort(compareSubtasks);

  const rank = new Map<string, number>();
  const visit = (root: Task) => {
    const stack = [root];
    for (let task = stack.pop(); task !== undefined; task = stack.pop()) {
      if (rank.has(task.id)) continue;
      rank.set(task.id, rank.size);
      const children = unplacedChildren.get(task.id);
      // Reversed so the first sibling is popped (visited) first.
      if (children) for (let i = children.length - 1; i >= 0; i--) stack.push(children[i] as Task);
    }
  };
  for (const { task } of placed) visit(task);
  if (rank.size < mine.length) {
    const rest = mine
      .filter((t) => !rank.has(t.id))
      .sort((a, b) => a.createdAt - b.createdAt || compareKeys(a.id, b.id));
    for (const task of rest) visit(task);
  }
  return rank;
}

interface Collected {
  task: Task;
  bucket: Bucket;
}

/**
 * Sections for one smart view, in display order. Only an empty `overdue` section is omitted:
 * sections with an inline add (`today`, each of the seven `day`s, and `flat`) are always present,
 * so the Overdue view of a user with nothing overdue is `[]`.
 */
export function selectView(source: ViewSource, view: SmartView, ctx: ViewContext): ViewSection[] {
  const mine = Object.values(source.tasks).filter((t) => isMine(t, ctx.viewerId));
  const rank = myTasksRank(mine, source.groups);
  // Every task of `mine` has a rank.
  const byRank = (a: Collected, b: Collected) =>
    (rank.get(a.task.id) as number) - (rank.get(b.task.id) as number);
  const ids = (items: Collected[]) => items.map((item) => item.task.id);

  const overdue: Collected[] = [];
  const dueToday: Collected[] = [];
  const days: Collected[][] = Array.from({ length: WEEK_DAYS }, () => []);
  const noDate: Collected[] = [];
  for (const task of mine) {
    if (task.completedAt !== null && !ctx.showCompleted) continue;
    const bucket = bucketOf(task, ctx);
    const item = { task, bucket };
    if (bucket.days === null) noDate.push(item);
    else if (bucket.overdue) overdue.push(item);
    else if (bucket.days === 0) dueToday.push(item);
    if (bucket.days !== null && bucket.days >= 0 && bucket.days < WEEK_DAYS) {
      days[bucket.days]?.push(item);
    }
  }

  const overdueSection = (): ViewSection[] =>
    overdue.length === 0
      ? []
      : [
          {
            id: 'overdue',
            kind: 'overdue',
            date: null,
            taskIds: ids(overdue.sort((a, b) => compareDue(a.task, b.task) || byRank(a, b))),
          },
        ];

  switch (view) {
    case 'today':
      return [
        ...overdueSection(),
        { id: 'today', kind: 'today', date: ctx.today, taskIds: ids(dueToday.sort(byRank)) },
      ];
    case 'overdue':
      return overdueSection();
    case 'week':
      // Every day keeps its section, even when empty: each header has its own inline add
      // (02 §3.4 "Next 7 days → Wed").
      return days.map((items, offset) => {
        const date = addDays(ctx.today, offset);
        return { id: date, kind: 'day', date, taskIds: ids(items.sort(byRank)) };
      });
    case 'nodate':
      // Kept when empty, like `today`: the section carries the inline add.
      return [{ id: 'flat', kind: 'flat', date: null, taskIds: ids(noDate.sort(byRank)) }];
  }
}

/** Due ascending: by date, then timed before untimed on the same date, then by time. */
function compareDue(a: Task, b: Task): number {
  const byDate = compareKeys(a.dueDate ?? '', b.dueDate ?? '');
  if (byDate !== 0) return byDate;
  if (a.dueTime === b.dueTime) return 0;
  if (a.dueTime === null) return 1;
  if (b.dueTime === null) return -1;
  return compareKeys(a.dueTime, b.dueTime);
}

/** Sidebar badges for one org; counts ignore `showCompleted` (always open tasks only). */
export function viewCounts(
  source: ViewSource,
  ctx: Omit<ViewContext, 'showCompleted'>,
): ViewCounts {
  const counts: ViewCounts = { my: 0, today: 0, week: 0, overdue: 0, nodate: 0 };
  for (const task of Object.values(source.tasks)) {
    if (task.completedAt !== null || !isLive(task)) continue;
    // Rows of My tasks: placed in a group the source knows (the list renders per group).
    if (task.placement && source.groups[task.placement.groupId]) counts.my++;
    if (task.assigneeId !== ctx.viewerId) continue;
    const bucket = bucketOf(task, ctx);
    if (bucket.days === null) {
      counts.nodate++;
      continue;
    }
    if (bucket.overdue) counts.overdue++;
    if (bucket.overdue || bucket.days === 0) counts.today++;
    if (bucket.days >= 0 && bucket.days < WEEK_DAYS) counts.week++;
  }
  return counts;
}
