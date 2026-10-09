import { selectEveryone } from '@rooster/core/everyone';
import {
  compareSubtasks,
  type ListState,
  orderedGroups,
  tasksInGroup,
} from '@rooster/core/reducers';
import type { Group, Task } from '@rooster/core/schemas';
import { type SmartView, selectView, type ViewCounts, viewCounts } from '@rooster/core/views';
import type { Member } from '../api.ts';
import { clean } from '../output/color.ts';
import { type DateContext, dayLabel } from '../output/format.ts';
import type { TuiTranslate } from './i18n.ts';

/**
 * The TUI's view model (07 §5): the lines of each view, built with the same pure selectors as
 * the web (`selectView`, `viewCounts`, `selectEveryone` over the my-list payload), plus the
 * ordering intents for keyboard moves. Nothing here computes a position: moves are
 * `{beforeId, afterId}` intents the server resolves (AGENTS hard rule 2).
 */

export const LIST_VIEWS = ['my', 'today', 'week', 'overdue', 'nodate', 'everyone'] as const;
export type ListView = (typeof LIST_VIEWS)[number];
export type ViewId = ListView | 'search';

export interface TaskLine {
  kind: 'task';
  key: string;
  task: Task;
  depth: number;
  /** The parent's title, for subtasks shown outside their parent (smart views). */
  breadcrumb: string | null;
  /** A muted chip: the group in smart views, the assignee nowhere (sections say it). */
  chip: string | null;
  /** The section the row belongs to (`group:<id>`, `section:<id>`). */
  section: string;
  /** Has subtasks, and whether they are shown below it (My tasks). */
  hasChildren: boolean;
  expanded: boolean;
}

export interface GroupLine {
  kind: 'group';
  key: string;
  group: Group;
  /** Open tasks placed in the group. */
  count: number;
  collapsed: boolean;
}

export interface SectionLine {
  kind: 'section';
  key: string;
  title: string;
  count: number;
  tone: 'danger' | null;
  /** The due date a task created in this section gets (smart views). */
  date: string | null;
  /** Everyone's tasks: the section's assignee (null: Unassigned). */
  assigneeId?: string | null;
}

export interface EmptyLine {
  kind: 'empty';
  key: string;
  text: string;
}

export type Line = TaskLine | GroupLine | SectionLine | EmptyLine;

export interface LinesInput {
  view: ViewId;
  list: ListState;
  viewerId: string;
  dates: DateContext;
  showCompleted: boolean;
  /** Completed tasks that stay visible for now (the web's hold after completing). */
  keep: ReadonlySet<string>;
  expanded: ReadonlySet<string>;
  collapsed: (group: Group) => boolean;
  members: readonly Member[] | null;
  everyone: readonly Task[] | null;
  search: { query: string; hits: readonly Task[] } | null;
  t: TuiTranslate;
}

const visibleIn = (input: Pick<LinesInput, 'showCompleted' | 'keep'>) => (task: Task) =>
  task.completedAt === null || input.showCompleted || input.keep.has(task.id);

/** The subtasks under each parent that has no placement of its own, in sibling order. */
function nestedChildren(tasks: Iterable<Task>): Map<string, Task[]> {
  const index = new Map<string, Task[]>();
  for (const task of tasks) {
    if (task.parentId === null || task.placement !== null) continue;
    const list = index.get(task.parentId);
    if (list) list.push(task);
    else index.set(task.parentId, [task]);
  }
  for (const list of index.values()) list.sort(compareSubtasks);
  return index;
}

/** Groups as My tasks shows them: the Inbox only while it has visible tasks (02 §4). */
export function displayedGroups(
  list: ListState,
  visible: (task: Task) => boolean,
): { group: Group; tasks: Task[] }[] {
  return orderedGroups(list).flatMap((group) => {
    const tasks = tasksInGroup(list, group.id).filter(visible);
    if (group.kind === 'inbox' && tasks.length === 0) return [];
    return [{ group, tasks }];
  });
}

function myLines(input: LinesInput): Line[] {
  const visible = visibleIn(input);
  const children = nestedChildren(Object.values(input.list.tasks));
  const lines: Line[] = [];
  for (const { group, tasks } of displayedGroups(input.list, visible)) {
    const collapsed = input.collapsed(group);
    const section = `group:${group.id}`;
    lines.push({
      kind: 'group',
      key: section,
      group,
      count: tasks.filter((task) => task.completedAt === null).length,
      collapsed,
    });
    if (collapsed) continue;
    const add = (task: Task, depth: number, seen: Set<string>) => {
      if (seen.has(task.id)) return;
      seen.add(task.id);
      const kids = (children.get(task.id) ?? []).filter(visible);
      const expanded = input.expanded.has(task.id) && kids.length > 0;
      lines.push({
        kind: 'task',
        key: task.id,
        task,
        depth,
        breadcrumb: null,
        chip: null,
        section,
        hasChildren: task.counts.subtasks > 0,
        expanded,
      });
      if (expanded) for (const kid of kids) add(kid, depth + 1, seen);
    };
    for (const task of tasks) add(task, 0, new Set());
  }
  return lines;
}

/** The group a task shows in: its own placement, else its nearest placed ancestor's. */
export function groupOf(list: ListState, task: Task): Group | undefined {
  const seen = new Set<string>();
  let current: Task | undefined = task;
  while (current !== undefined && !seen.has(current.id)) {
    seen.add(current.id);
    if (current.placement !== null) return list.groups[current.placement.groupId];
    current = current.parentId === null ? undefined : list.tasks[current.parentId];
  }
  return undefined;
}

/** "Friday, Oct 9": the Today section is labelled with the date, the tab says Today (02 §10). */
export function longDate(date: string, locale: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    month: 'short',
    day: 'numeric',
    timeZone: 'UTC',
  }).format(Date.UTC(y, m - 1, d));
}

function smartLines(input: LinesInput, view: SmartView): Line[] {
  const { list, dates, t } = input;
  const visible = visibleIn(input);
  const sections = selectView(list, view, {
    today: dates.today,
    nowMs: dates.nowMs,
    viewerTz: dates.timezone,
    viewerId: input.viewerId,
    showCompleted: true,
  });
  const lines: Line[] = [];
  for (const section of sections) {
    const tasks = section.taskIds
      .map((id) => list.tasks[id])
      .filter((task): task is Task => task !== undefined && visible(task));
    const key = `section:${section.id}`;
    if (section.kind !== 'flat') {
      const title =
        section.kind === 'overdue'
          ? t('section.overdue')
          : section.kind === 'today'
            ? longDate(section.date ?? dates.today, dates.locale)
            : dayLabel(section.date ?? dates.today, dates);
      lines.push({
        kind: 'section',
        key,
        title,
        count: tasks.filter((task) => task.completedAt === null).length,
        tone: section.kind === 'overdue' ? 'danger' : null,
        // Overdue has no inline add on the web; here a task added there is due today.
        date: section.kind === 'overdue' ? dates.today : section.date,
      });
    }
    for (const task of tasks) {
      const parent = task.parentId === null ? undefined : list.tasks[task.parentId];
      const group = groupOf(list, task);
      lines.push({
        kind: 'task',
        key: task.id,
        task,
        depth: 0,
        breadcrumb: parent === undefined ? null : clean(parent.title),
        chip: group === undefined || group.kind === 'inbox' ? null : clean(group.name),
        section: key,
        hasChildren: task.counts.subtasks > 0,
        expanded: false,
      });
    }
  }
  return lines;
}

function everyoneLines(input: LinesInput): Line[] {
  const { t } = input;
  const tasks = input.everyone ?? [];
  const members = input.members ?? [];
  const byId = new Map(tasks.map((task) => [task.id, task]));
  const sections = selectEveryone(tasks, {
    viewerId: input.viewerId,
    members: members.map((m) => ({ userId: m.userId, name: m.name })),
    locale: input.dates.locale,
    filters: { showCompleted: input.showCompleted },
    due: { today: input.dates.today, nowMs: input.dates.nowMs, viewerTz: input.dates.timezone },
  });
  const lines: Line[] = [];
  for (const section of sections) {
    const key = `section:${section.assigneeId ?? 'none'}`;
    const member = members.find((m) => m.userId === section.assigneeId);
    const title =
      section.assigneeId === null
        ? t('section.unassigned')
        : section.assigneeId === input.viewerId
          ? t('section.me', { name: clean(member?.name ?? '') })
          : clean(member?.name ?? section.assigneeId);
    const rows = section.taskIds
      .map((id) => byId.get(id))
      .filter((task): task is Task => task !== undefined);
    lines.push({
      kind: 'section',
      key,
      title,
      count: section.openCount,
      tone: null,
      date: null,
      assigneeId: section.assigneeId,
    });
    for (const task of rows) {
      const parent = task.parentId === null ? undefined : byId.get(task.parentId);
      lines.push({
        kind: 'task',
        key: task.id,
        task,
        depth: 0,
        breadcrumb: parent === undefined ? null : clean(parent.title),
        chip: null,
        section: key,
        hasChildren: task.counts.subtasks > 0,
        expanded: false,
      });
    }
  }
  return lines;
}

function searchLines(input: LinesInput): Line[] {
  const hits = input.search?.hits ?? [];
  return hits.map((task) => {
    const parent = task.parentId === null ? undefined : input.list.tasks[task.parentId];
    return {
      kind: 'task',
      key: task.id,
      task,
      depth: 0,
      breadcrumb: parent === undefined ? null : clean(parent.title),
      chip: null,
      section: 'section:search',
      hasChildren: task.counts.subtasks > 0,
      expanded: false,
    };
  });
}

/** Every line of the view, in display order; an `empty` line when there is nothing to show. */
export function buildLines(input: LinesInput): Line[] {
  let lines: Line[];
  switch (input.view) {
    case 'my':
      lines = myLines(input);
      break;
    case 'everyone':
      lines = everyoneLines(input);
      break;
    case 'search':
      lines = searchLines(input);
      break;
    default:
      lines = smartLines(input, input.view);
  }
  if (!lines.some((line) => line.kind === 'task')) {
    const text =
      input.view === 'search'
        ? input.t('empty.search', { query: input.search?.query ?? '' })
        : input.t(`empty.${input.view}`);
    // Section headers stay (they carry the inline add); the hint goes below them.
    lines = [...lines, { kind: 'empty', key: 'empty', text }];
  }
  return lines;
}

/** The tab badges: Today and Overdue (02 §2, like the web's sidebar). */
export function counts(list: ListState, viewerId: string, dates: DateContext): ViewCounts {
  return viewCounts(list, {
    viewerId,
    today: dates.today,
    nowMs: dates.nowMs,
    viewerTz: dates.timezone,
  });
}

export const isSelectable = (line: Line): boolean => line.kind !== 'empty';

export function indexOfKey(lines: readonly Line[], key: string | null): number {
  return key === null ? -1 : lines.findIndex((line) => line.key === key);
}

/**
 * The key `delta` selectable lines away from `key` (clamped), or the first selectable line
 * when `key` is not shown.
 */
export function stepSelection(
  lines: readonly Line[],
  key: string | null,
  delta: number,
): string | null {
  const selectable = lines.filter(isSelectable);
  if (selectable.length === 0) return null;
  const at = selectable.findIndex((line) => line.key === key);
  if (at === -1) return selectable[0]?.key ?? null;
  const next = Math.max(0, Math.min(selectable.length - 1, at + delta));
  return selectable[next]?.key ?? null;
}

/**
 * Keeps the selection on the same task after a refresh; when it is gone, the line now at its
 * old index (or the last one) is selected, so the cursor stays where the user was looking.
 */
export function keepSelection(
  lines: readonly Line[],
  key: string | null,
  previousIndex: number,
): string | null {
  if (key !== null && lines.some((line) => line.key === key && isSelectable(line))) return key;
  const selectable = lines.filter(isSelectable);
  if (selectable.length === 0) return null;
  const index = Math.max(0, Math.min(previousIndex, lines.length - 1));
  for (let i = index; i < lines.length; i++) {
    const line = lines[i];
    if (line !== undefined && isSelectable(line)) return line.key;
  }
  return selectable[selectable.length - 1]?.key ?? null;
}

export type MoveDirection = 'up' | 'down' | 'nextGroup' | 'prevGroup';

/** A `POST /tasks/:id/move` or `POST /tasks/:id/reorder` (subtasks) body. */
export type MovePlan =
  | { kind: 'move'; body: { groupId: string; afterId?: string | null; beforeId?: string | null } }
  | { kind: 'reorder'; body: { afterId?: string | null; beforeId?: string | null } };

/**
 * The intent for a keyboard move in My tasks (02 §5): one step up or down among the visible
 * rows, crossing into the neighbouring group at the edges; or to the start of the next / end
 * of the previous group. Subtasks move among their siblings only. Null when there is nowhere
 * to go.
 */
export function planMove(
  list: ListState,
  taskId: string,
  direction: MoveDirection,
  visible: (task: Task) => boolean,
): MovePlan | null {
  const task = list.tasks[taskId];
  if (task === undefined) return null;
  if (task.placement === null) {
    if (task.parentId === null || direction === 'nextGroup' || direction === 'prevGroup') {
      return null;
    }
    const siblings = Object.values(list.tasks)
      .filter((t) => t.parentId === task.parentId && t.placement === null && visible(t))
      .sort(compareSubtasks);
    const at = siblings.findIndex((t) => t.id === taskId);
    const neighbour = siblings[direction === 'down' ? at + 1 : at - 1];
    if (neighbour === undefined) return null;
    return {
      kind: 'reorder',
      body: direction === 'down' ? { afterId: neighbour.id } : { beforeId: neighbour.id },
    };
  }
  const groups = displayedGroups(list, (t) => visible(t) || t.id === taskId);
  const g = groups.findIndex((entry) => entry.group.id === task.placement?.groupId);
  const current = groups[g];
  if (current === undefined) return null;
  const rows = current.tasks.filter((t) => t.id !== taskId);
  const at = current.tasks.findIndex((t) => t.id === taskId);
  const startOf = (entry: { group: Group; tasks: Task[] } | undefined): MovePlan | null => {
    if (entry === undefined) return null;
    const first = entry.tasks[0];
    return {
      kind: 'move',
      body:
        first === undefined
          ? { groupId: entry.group.id }
          : { groupId: entry.group.id, afterId: null, beforeId: first.id },
    };
  };
  const endOf = (entry: { group: Group; tasks: Task[] } | undefined): MovePlan | null => {
    if (entry === undefined) return null;
    const last = entry.tasks[entry.tasks.length - 1];
    return {
      kind: 'move',
      body:
        last === undefined
          ? { groupId: entry.group.id }
          : { groupId: entry.group.id, afterId: last.id },
    };
  };
  switch (direction) {
    case 'down': {
      const below = rows[at];
      if (below !== undefined) {
        return { kind: 'move', body: { groupId: current.group.id, afterId: below.id } };
      }
      return startOf(groups[g + 1]);
    }
    case 'up': {
      const above = rows[at - 1];
      if (above !== undefined) {
        return { kind: 'move', body: { groupId: current.group.id, beforeId: above.id } };
      }
      return endOf(groups[g - 1]);
    }
    case 'nextGroup':
      return startOf(groups[g + 1]);
    case 'prevGroup':
      return endOf(groups[g - 1]);
  }
}

/**
 * The intent that puts the task back where it is now (for undo), from its full sibling order
 * (completed rows included): directly below its predecessor, else above its successor.
 */
export function restorePlan(list: ListState, taskId: string): MovePlan | null {
  const task = list.tasks[taskId];
  if (task === undefined) return null;
  if (task.placement === null) {
    if (task.parentId === null) return null;
    const siblings = Object.values(list.tasks)
      .filter((t) => t.parentId === task.parentId && t.placement === null)
      .sort(compareSubtasks);
    const at = siblings.findIndex((t) => t.id === taskId);
    const before = siblings[at - 1];
    const after = siblings[at + 1];
    if (before !== undefined) return { kind: 'reorder', body: { afterId: before.id } };
    if (after !== undefined)
      return { kind: 'reorder', body: { afterId: null, beforeId: after.id } };
    return null;
  }
  const groupId = task.placement.groupId;
  const order = tasksInGroup(list, groupId);
  const at = order.findIndex((t) => t.id === taskId);
  const before = order[at - 1];
  const after = order[at + 1];
  if (before !== undefined) return { kind: 'move', body: { groupId, afterId: before.id } };
  if (after !== undefined) {
    return { kind: 'move', body: { groupId, afterId: null, beforeId: after.id } };
  }
  return { kind: 'move', body: { groupId } };
}

/** Where a new task goes and how it is created (02 §3.4 context inheritance). */
export interface CreateTarget {
  /** The draft row shows after (or before) this line; null: at the top of the list. */
  anchorKey: string | null;
  placement: 'after' | 'before';
  depth: number;
  body: {
    groupId?: string;
    parentId?: string;
    afterId?: string | null;
    beforeId?: string | null;
    dueDate?: string;
    assigneeId?: string | null;
  };
  /** A group to expand (My tasks) or a parent to expand so the new row is visible. */
  expandGroup?: string;
  expandTask?: string;
}

/** The last line of the subtree of the line at `index` (itself without shown subtasks). */
function subtreeEnd(lines: readonly Line[], index: number): number {
  const line = lines[index];
  if (line?.kind !== 'task') return index;
  let end = index;
  for (let i = index + 1; i < lines.length; i++) {
    const next = lines[i];
    if (next?.kind !== 'task' || next.depth <= line.depth || next.section !== line.section) break;
    end = i;
  }
  return end;
}

/**
 * The target of `n` (below), `N` (above) or `s` (subtask) from the selected line. Null where
 * creating is not possible (search results).
 */
export function createTarget(
  view: ViewId,
  lines: readonly Line[],
  list: ListState,
  selectedKey: string | null,
  where: 'below' | 'above' | 'subtask',
): CreateTarget | null {
  if (view === 'search') return null;
  const index = indexOfKey(lines, selectedKey);
  const line = lines[index];
  if (where === 'subtask') {
    if (line?.kind !== 'task') return null;
    const end = lines[subtreeEnd(lines, index)];
    return {
      anchorKey: end?.key ?? line.key,
      placement: 'after',
      depth: line.depth + 1,
      body: { parentId: line.task.id },
      ...(view === 'my' ? { expandTask: line.task.id } : {}),
    };
  }
  const anchor = (key: string, depth: number) =>
    where === 'below'
      ? {
          anchorKey: lines[subtreeEnd(lines, indexOfKey(lines, key))]?.key ?? key,
          placement: 'after' as const,
          depth,
        }
      : { anchorKey: key, placement: 'before' as const, depth };
  if (view === 'my') {
    if (line === undefined || line.kind === 'empty') {
      return { anchorKey: null, placement: 'after', depth: 0, body: {} };
    }
    if (line.kind === 'group' || line.kind === 'section') {
      const groupId = line.kind === 'group' ? line.group.id : undefined;
      if (groupId === undefined) return null;
      const first = tasksInGroup(list, groupId).find((t) => t.completedAt === null);
      return {
        anchorKey: line.key,
        placement: 'after',
        depth: 0,
        body: first === undefined ? { groupId } : { groupId, afterId: null, beforeId: first.id },
        expandGroup: groupId,
      };
    }
    const task = line.task;
    if (task.placement === null && task.parentId !== null) {
      return {
        ...anchor(line.key, line.depth),
        body:
          where === 'below'
            ? { parentId: task.parentId, afterId: task.id }
            : { parentId: task.parentId, afterId: null, beforeId: task.id },
      };
    }
    const groupId = task.placement?.groupId;
    if (groupId === undefined) return null;
    return {
      ...anchor(line.key, 0),
      body:
        where === 'below'
          ? { groupId, afterId: task.id }
          : { groupId, afterId: null, beforeId: task.id },
    };
  }
  // Smart views and Everyone's tasks: the section decides the date or the assignee; the task
  // lands in the Inbox, where the server puts it.
  const sectionKey =
    line?.kind === 'task' ? line.section : line?.kind === 'section' ? line.key : null;
  const section = lines.find((l): l is SectionLine => l.kind === 'section' && l.key === sectionKey);
  const body: CreateTarget['body'] = {};
  if (view === 'everyone') {
    if (section !== undefined) body.assigneeId = section.assigneeId ?? null;
  } else if (section?.date) body.dueDate = section.date;
  if (line === undefined || line.kind === 'empty') {
    return { anchorKey: null, placement: 'after', depth: 0, body };
  }
  if (line.kind === 'section') return { anchorKey: line.key, placement: 'after', depth: 0, body };
  return { ...anchor(line.key, 0), body };
}
