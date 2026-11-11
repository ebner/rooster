import type { IsoDate } from '@rooster/core/dates';
import { compareKeys } from '@rooster/core/ordering';
import { childrenIndex, inboxOf, type ListState, normalGroups } from '@rooster/core/reducers';
import type { Group, Task } from '@rooster/core/schemas';
import { compareUpcoming, isUpcoming } from '@rooster/core/upcoming';
import type { SmartView, ViewSectionKind } from '@rooster/core/views';
import {
  addGroupRowId,
  addRowId,
  addSubtaskRowId,
  type Draft,
  groupRowId,
  upcomingRowId,
} from '../../../state/list-store';
import type { Person } from '../../people/members';

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
  /** The group the row renders in (a subtask: its top-level row's group). */
  groupId: string;
  draft: boolean;
  /** 02 §3.1 `aria-level`: 2 for tasks, 3 and deeper for subtasks shown under a parent. */
  level: number;
  /** Set for a subtask row shown under its parent (P3). */
  parentId: string | null;
  /** Has subtasks: shows the chevron. */
  expandable: boolean;
  expanded: boolean;
  /** FR-TASK-12: the parent's title, for an orphan subtask shown as its own row. */
  breadcrumb: string | null;
  /** Smart views (02 §10): the section the row is in. */
  sectionId?: string;
  /** Today (02 §10) and Upcoming (ADR 0068): the task's group name, shown as a muted chip. */
  groupChip?: string;
  /**
   * ADR 0068: the row is in the Upcoming section (an upcoming task, or a subtask under one).
   * It can't be dragged or moved, and no new rows are created next to it.
   */
  upcoming?: true;
}

/**
 * The Upcoming section's header (ADR 0068): after the groups, for recurring tasks whose day
 * hasn't come yet. A system section: no rename, menu, inline add or drop target.
 */
export interface UpcomingRow {
  kind: 'upcoming';
  id: string;
  /** Open tasks in the section. */
  count: number;
  collapsed: boolean;
}

/** "+ Add subtask" after an expanded parent's subtasks. */
export interface AddSubtaskRow {
  kind: 'addSubtask';
  id: string;
  parentId: string;
  groupId: string;
  level: number;
}

export interface AddRow {
  kind: 'add';
  id: string;
  groupId: string;
  /** Smart views: "+ Add task" at the end of this section (the task inherits its date). */
  sectionId?: string;
}

/** A smart-view section header (02 §10): like a group header, but derived and read-only. */
export interface SectionRow {
  kind: 'section';
  id: string;
  sectionId: string;
  sectionKind: ViewSectionKind;
  /** The day of a `day` section (its label), or the date a `today` section stands for. */
  date: string | null;
  /** Open tasks in the section. */
  count: number;
  first: boolean;
  /**
   * Everyone's tasks (02 §11): the assignee the section stands for (null: Unassigned). Its
   * header shows the avatar and name instead of a date.
   */
  assigneeId?: string | null;
  /** The member, when known (null: Unassigned, or someone no longer in the org). */
  person?: Person | null;
}

/** An empty smart view (02 §14): the illustration and the view's text. */
export interface EmptyRow {
  kind: 'empty';
  id: string;
  view: SmartView;
  /** The view takes inline adds (all but Overdue). */
  canAdd: boolean;
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

export type Row =
  | GroupRow
  | TaskRow
  | AddRow
  | HintRow
  | AddGroupRow
  | AddSubtaskRow
  | SectionRow
  | EmptyRow
  | UpcomingRow;

export interface RowOptions {
  drafts: readonly Draft[];
  showCompleted: boolean;
  hiding: Readonly<Record<string, unknown>>;
  dragCollapsed: boolean;
  hoverExpanded: Readonly<Record<string, true>>;
  /** The placeholder task a draft renders with (stable per draft id). */
  draftTask: (draft: Draft) => Task;
  /** FR-TAG-4: only top-level rows carrying one of these tags (empty: all). */
  tagFilter?: readonly string[];
  /**
   * ADR 0068: the viewer's today. With it, open top-level recurring tasks whose day is after
   * today leave their groups for the Upcoming section at the end.
   */
  today?: IsoDate | undefined;
  /** The Upcoming section is folded (the default; a group drag folds it as well). */
  upcomingCollapsed?: boolean | undefined;
  /**
   * The row whose date picker is open: it stays where it was (in its group or in Upcoming)
   * until the picker closes. The picker is anchored to it, and a repeat or a reminder saves a
   * new date while the picker stays open.
   */
  inPlace?: string | null | undefined;
}

export type RowCache = Map<string, Row>;

function shallowEqual(a: Row, b: Row): boolean {
  const ka = Object.keys(a) as (keyof Row)[];
  if (ka.length !== Object.keys(b).length) return false;
  return ka.every((k) => a[k] === b[k]);
}

/** Returns rows equal to their cached version as that cached object (stable identity). */
export function rowReuser(cache: RowCache | undefined): <T extends Row>(row: T) => T {
  return <T extends Row>(row: T): T => {
    const cached = cache?.get(row.id);
    const result = cached && shallowEqual(cached, row) ? (cached as T) : row;
    cache?.set(row.id, result);
    return result;
  };
}

/**
 * The flat row model (04 §5.4): group header, its visible tasks (with drafts spliced in),
 * its "+ Add task" row, and "+ Add group" at the end. With `today` (ADR 0068), recurring
 * tasks whose day hasn't come yet leave their groups for the Upcoming section after that.
 * Rows equal to the cached ones keep their identity, so memoised row components re-render
 * only when their row changed.
 */
export function buildRows(state: ListState, options: RowOptions, cache?: RowCache): Row[] {
  const rows: Row[] = [];
  const reuse = rowReuser(cache);
  const draftsByGroup = new Map<string, Draft[]>();
  const draftsByParent = new Map<string, Draft[]>();
  for (const draft of options.drafts) {
    const map = draft.parentId ? draftsByParent : draftsByGroup;
    const key = draft.parentId ?? draft.groupId;
    const list = map.get(key) ?? [];
    list.push(draft);
    map.set(key, list);
  }
  const visible = (task: Task) =>
    task.completedAt === null || options.showCompleted || task.id in options.hiding;
  const firstRun = Object.keys(state.tasks).length === 0 && options.drafts.length === 0;
  const filter = options.tagFilter ?? [];
  const passes = (task: Task) =>
    filter.length === 0 || task.tagIds.some((id) => filter.includes(id));
  const { today } = options;
  const pinned = options.inPlace ? cache?.get(options.inPlace) : undefined;
  const pinnedUpcoming = pinned?.kind === 'task' ? pinned.upcoming === true : undefined;
  /**
   * ADR 0068: waiting for its day, or completed there and still in its hold, or with its date
   * picker open there (both stay put).
   */
  const inUpcoming = (task: Task) =>
    today !== undefined &&
    (task.id === options.inPlace && pinnedUpcoming !== undefined
      ? pinnedUpcoming
      : isUpcoming(task, today) ||
        (task.completedAt !== null &&
          task.id in options.hiding &&
          isUpcoming({ ...task, completedAt: null }, today)));

  const inbox = inboxOf(state);
  const groups = normalGroups(state);
  const byGroup = bucketByGroup(state);
  const children = childrenIndex(Object.values(state.tasks));
  const expanded = new Set(state.expandedTaskIds);
  const upcoming: Task[] = [];
  /** Each group's own tasks: every upcoming one goes to `upcoming` instead, in one pass. */
  const kept = new Map<string, Task[]>();
  for (const group of inbox ? [inbox, ...groups] : groups) {
    const all = byGroup.get(group.id) ?? [];
    if (today === undefined) {
      kept.set(group.id, all);
      continue;
    }
    const own: Task[] = [];
    for (const task of all) (inUpcoming(task) ? upcoming : own).push(task);
    kept.set(group.id, own);
  }
  const inGroup = (groupId: string) => kept.get(groupId) ?? [];
  const inboxTasks = inbox ? inGroup(inbox.id) : [];
  const showInbox =
    inbox !== undefined &&
    (inboxTasks.some((t) => t.completedAt === null || t.id in options.hiding) ||
      draftsByGroup.has(inbox.id));
  const ordered = showInbox && inbox ? [inbox, ...groups] : groups;

  const draftRow = (draft: Draft, groupId: string, level: number, parentId: string | null) =>
    reuse<TaskRow>({
      kind: 'task',
      id: draft.id,
      task: options.draftTask(draft),
      groupId,
      draft: true,
      level,
      parentId,
      expandable: false,
      expanded: false,
      breadcrumb: null,
    });

  /**
   * Rows of a parent's expanded subtree: subtasks (drafts spliced in), then "+ Add subtask"
   * (none in Upcoming, where no rows are added).
   */
  const subtree = (
    parent: Task,
    groupId: string,
    level: number,
    out: Row[],
    guard: number,
    section: boolean,
  ) => {
    const items: (TaskRow | Task)[] = (children.get(parent.id) ?? []).filter(visible);
    for (const draft of draftsByParent.get(parent.id) ?? []) {
      const at =
        draft.afterId === null
          ? 0
          : items.findIndex((r) => r.id === draft.afterId) + 1 || items.length;
      items.splice(at, 0, draftRow(draft, groupId, level, parent.id));
    }
    for (const item of items) {
      if ('kind' in item) {
        out.push(item);
        continue;
      }
      taskRows(item, groupId, level, parent.id, out, guard + 1, section);
    }
    if (section) return;
    out.push(
      reuse({
        kind: 'addSubtask',
        id: addSubtaskRowId(parent.id),
        parentId: parent.id,
        groupId,
        level,
      }),
    );
  };

  const taskRows = (
    task: Task,
    groupId: string,
    level: number,
    parentId: string | null,
    out: Row[],
    guard = 0,
    /** In the Upcoming section (ADR 0068). */
    section = false,
  ) => {
    const hasChildren =
      task.counts.subtasks > 0 || children.has(task.id) || draftsByParent.has(task.id);
    const open = hasChildren && expanded.has(task.id) && guard < 8;
    const orphanParent =
      parentId === null && task.parentId !== null ? state.tasks[task.parentId] : undefined;
    // Upcoming names the group each task goes back to.
    const chip = section && parentId === null ? state.groups[groupId]?.name : undefined;
    out.push(
      reuse<TaskRow>({
        kind: 'task',
        id: task.id,
        task,
        groupId,
        draft: false,
        level,
        parentId,
        expandable: hasChildren,
        expanded: open,
        breadcrumb: orphanParent ? orphanParent.title : null,
        ...(chip === undefined ? {} : { groupChip: chip }),
        ...(section ? { upcoming: true as const } : {}),
      }),
    );
    if (open) subtree(task, groupId, level + 1, out, guard, section);
  };

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
    const items: (Task | TaskRow)[] = tasks.filter((t) => visible(t) && passes(t));
    const drafts = draftsByGroup.get(group.id);
    if (drafts) {
      const anchors = hiddenAnchors(byGroup.get(group.id) ?? [], items);
      for (const draft of drafts) {
        items.splice(
          draftIndex(items, draft.afterId, anchors),
          0,
          draftRow(draft, group.id, 2, null),
        );
      }
    }
    for (const item of items) {
      if ('kind' in item) rows.push(item);
      else taskRows(item, group.id, 2, null, rows);
    }
    if (firstRun && group === groups[0]) {
      rows.push(reuse({ kind: 'hint', id: `hint:${group.id}`, groupId: group.id }));
    }
    rows.push(reuse({ kind: 'add', id: addRowId(group.id), groupId: group.id }));
  });
  rows.push(reuse({ kind: 'addGroup', id: addGroupRowId }));
  if (upcoming.length > 0) {
    upcoming.sort(compareUpcoming);
    const collapsed = options.dragCollapsed || (options.upcomingCollapsed ?? true);
    rows.push(
      reuse({
        kind: 'upcoming',
        id: upcomingRowId,
        count: upcoming.filter((t) => t.completedAt === null).length,
        collapsed,
      }),
    );
    if (!collapsed) {
      for (const task of upcoming) {
        const groupId = task.placement?.groupId ?? '';
        if (passes(task)) taskRows(task, groupId, 2, null, rows, 0, true);
      }
    }
  }
  return rows;
}

/**
 * For each task of a group that is not shown (completed, filtered out, or in Upcoming): the
 * shown task directly above it, or null at the top. A new row placed after a task that has
 * just left the group (Enter on a title that sent it to Upcoming) stays where it was.
 */
function hiddenAnchors(
  all: readonly Task[],
  shown: readonly (Task | TaskRow)[],
): Map<string, string | null> {
  const anchors = new Map<string, string | null>();
  const isShown = new Set(shown.map((item) => item.id));
  let above: string | null = null;
  for (const task of all) {
    if (isShown.has(task.id)) above = task.id;
    else anchors.set(task.id, above);
  }
  return anchors;
}

/** Where a draft goes in `items`: after `afterId` (or its shown stand-in), else at the end. */
function draftIndex(
  items: readonly (Task | TaskRow)[],
  afterId: string | null,
  anchors: ReadonlyMap<string, string | null>,
): number {
  if (afterId === null) return 0;
  const at = items.findIndex((r) => r.id === afterId);
  if (at >= 0) return at + 1;
  const anchor = anchors.get(afterId);
  if (anchor === undefined) return items.length;
  return anchor === null ? 0 : items.findIndex((r) => r.id === anchor) + 1;
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

/** Rows that ↑/↓ and the selection move through: group headers, Upcoming's header and tasks. */
export function isNavigable(row: Row): row is GroupRow | TaskRow | UpcomingRow {
  return row.kind === 'group' || row.kind === 'task' || row.kind === 'upcoming';
}

/** ADR 0068: the Upcoming header, or a row in its section. */
export function isUpcomingRow(row: Row): boolean {
  return row.kind === 'upcoming' || (row.kind === 'task' && row.upcoming === true);
}

/** Persisted tasks only (no drafts). */
export function isTaskRow(row: Row): row is TaskRow {
  return row.kind === 'task' && !row.draft;
}

/** A persisted top-level row of its group (not a subtask shown under its parent). */
export function isTopTaskRow(row: Row): row is TaskRow {
  return isTaskRow(row) && row.parentId === null;
}

export interface GroupOrder {
  id: string;
  collapsed: boolean;
  /** Visible persisted tasks in order. */
  taskIds: string[];
}

/** The visible order the keyboard moves and drops work in (no drafts, nothing in Upcoming). */
export function visibleOrder(rows: readonly Row[]): GroupOrder[] {
  const groups: GroupOrder[] = [];
  for (const row of rows) {
    // Upcoming comes last, and nothing moves into it or within it (ADR 0068).
    if (row.kind === 'upcoming') break;
    if (row.kind === 'group') {
      groups.push({ id: row.group.id, collapsed: row.collapsed, taskIds: [] });
    } else if (isTopTaskRow(row)) {
      groups.at(-1)?.taskIds.push(row.id);
    }
  }
  return groups;
}
