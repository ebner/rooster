import { compareKeys } from '@rooster/core/ordering';
import { inboxOf, type ListState, normalGroups } from '@rooster/core/reducers';
import type { Group, Task } from '@rooster/core/schemas';
import { addGroupRowId, addRowId, type Draft, groupRowId } from '../../../state/list-store';

export interface GroupRow {
  kind: 'group';
  id: string;
  group: Group;
  /** Open tasks (02 §4 header count). */
  count: number;
  /** Effective state: stored, or forced by a group drag, or opened by a drag hover. */
  collapsed: boolean;
  first: boolean;
}

export interface TaskRow {
  kind: 'task';
  id: string;
  task: Task;
  groupId: string;
  draft: boolean;
}

export interface AddRow {
  kind: 'add';
  id: string;
  groupId: string;
}

/** First run (02 §14): "Type a task and press Enter ↵". */
export interface HintRow {
  kind: 'hint';
  id: string;
  groupId: string;
}

export interface AddGroupRow {
  kind: 'addGroup';
  id: string;
}

export type Row = GroupRow | TaskRow | AddRow | HintRow | AddGroupRow;

export interface RowOptions {
  drafts: readonly Draft[];
  showCompleted: boolean;
  hiding: Readonly<Record<string, unknown>>;
  dragCollapsed: boolean;
  hoverExpanded: Readonly<Record<string, true>>;
  /** The placeholder task a draft renders with (stable per draft id). */
  draftTask: (draft: Draft) => Task;
}

export type RowCache = Map<string, Row>;

function shallowEqual(a: Row, b: Row): boolean {
  const ka = Object.keys(a) as (keyof Row)[];
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/**
 * The flat row model (04 §5.4): group header, its visible tasks (with drafts spliced in),
 * its "+ Add task" row, and "+ Add group" at the end. Rows equal to the cached ones keep
 * their identity, so memoised row components re-render only when their row changed.
 */
export function buildRows(state: ListState, options: RowOptions, cache?: RowCache): Row[] {
  const rows: Row[] = [];
  const reuse = <T extends Row>(row: T): T => {
    const cached = cache?.get(row.id);
    const result = cached && shallowEqual(cached, row) ? (cached as T) : row;
    cache?.set(row.id, result);
    return result;
  };
  const draftsByGroup = new Map<string, Draft[]>();
  for (const draft of options.drafts) {
    const list = draftsByGroup.get(draft.groupId) ?? [];
    list.push(draft);
    draftsByGroup.set(draft.groupId, list);
  }
  const visible = (task: Task) =>
    task.completedAt === null || options.showCompleted || task.id in options.hiding;
  const firstRun = Object.keys(state.tasks).length === 0 && options.drafts.length === 0;

  const inbox = inboxOf(state);
  const groups = normalGroups(state);
  const byGroup = bucketByGroup(state);
  const inGroup = (groupId: string) => byGroup.get(groupId) ?? [];
  const inboxTasks = inbox ? inGroup(inbox.id) : [];
  const showInbox =
    inbox !== undefined &&
    (inboxTasks.some((t) => t.completedAt === null || t.id in options.hiding) ||
      draftsByGroup.has(inbox.id));
  const ordered = showInbox && inbox ? [inbox, ...groups] : groups;

  ordered.forEach((group, index) => {
    const tasks = group === inbox ? inboxTasks : inGroup(group.id);
    const collapsed =
      options.dragCollapsed || (group.collapsed && !options.hoverExpanded[group.id]);
    rows.push(
      reuse({
        kind: 'group',
        id: groupRowId(group.id),
        group,
        count: tasks.filter((t) => t.completedAt === null).length,
        collapsed,
        first: index === 0,
      }),
    );
    if (collapsed) return;
    const items: TaskRow[] = tasks
      .filter(visible)
      .map((task) => reuse({ kind: 'task', id: task.id, task, groupId: group.id, draft: false }));
    for (const draft of draftsByGroup.get(group.id) ?? []) {
      const at =
        draft.afterId === null
          ? 0
          : items.findIndex((r) => r.id === draft.afterId) + 1 || items.length;
      items.splice(
        at,
        0,
        reuse({
          kind: 'task',
          id: draft.id,
          task: options.draftTask(draft),
          groupId: group.id,
          draft: true,
        }),
      );
    }
    rows.push(...items);
    if (firstRun && group === groups[0]) {
      rows.push(reuse({ kind: 'hint', id: `hint:${group.id}`, groupId: group.id }));
    }
    rows.push(reuse({ kind: 'add', id: addRowId(group.id), groupId: group.id }));
  });
  rows.push(reuse({ kind: 'addGroup', id: addGroupRowId }));
  return rows;
}

/** Placed tasks per group in list order, in one pass (`tasksInGroup` per group is O(groups × n)). */
function bucketByGroup(state: ListState): Map<string, Task[]> {
  const buckets = new Map<string, Task[]>();
  for (const task of Object.values(state.tasks)) {
    const groupId = task.placement?.groupId;
    if (!groupId) continue;
    const bucket = buckets.get(groupId);
    if (bucket) bucket.push(task);
    else buckets.set(groupId, [task]);
  }
  for (const bucket of buckets.values()) {
    bucket.sort(
      (a, b) =>
        compareKeys(a.placement?.position ?? '', b.placement?.position ?? '') ||
        compareKeys(a.id, b.id),
    );
  }
  return buckets;
}

/** Rows that ↑/↓ and the selection move through: group headers and tasks. */
export function isNavigable(row: Row): row is GroupRow | TaskRow {
  return row.kind === 'group' || row.kind === 'task';
}

/** Persisted tasks only (no drafts). */
export function isTaskRow(row: Row): row is TaskRow {
  return row.kind === 'task' && !row.draft;
}

export interface GroupOrder {
  id: string;
  collapsed: boolean;
  /** Visible persisted tasks in order. */
  taskIds: string[];
}

/** The visible order the keyboard moves and drops work in (no drafts). */
export function visibleOrder(rows: readonly Row[]): GroupOrder[] {
  const groups: GroupOrder[] = [];
  for (const row of rows) {
    if (row.kind === 'group') {
      groups.push({ id: row.group.id, collapsed: row.collapsed, taskIds: [] });
    } else if (isTaskRow(row)) {
      groups.at(-1)?.taskIds.push(row.id);
    }
  }
  return groups;
}
