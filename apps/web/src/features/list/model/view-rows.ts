import { inboxOf, type ListState } from '@rooster/core/reducers';
import type { Task } from '@rooster/core/schemas';
import type { SmartView, ViewSection } from '@rooster/core/views';
import { addSectionRowId, type Draft, sectionRowId } from '../../../state/list-store';
import { type Row, type RowCache, rowReuser, type TaskRow } from './rows';

export interface ViewRowOptions {
  view: SmartView;
  drafts: readonly Draft[];
  showCompleted: boolean;
  /** Completed rows still in their hold (02 §3.6) stay where they were. */
  hiding: Readonly<Record<string, unknown>>;
  draftTask: (draft: Draft) => Task;
  /** FR-TAG-4: only rows carrying one of these tags (empty: all). */
  tagFilter?: readonly string[];
}

/** Inline add goes into every section but Overdue (02 §3.4, §10). */
export function sectionTakesAdds(section: Pick<ViewSection, 'kind'>): boolean {
  return section.kind !== 'overdue';
}

/** Today (Overdue / Today) and Next 7 days (one per day) show section headers. */
export function viewHasHeaders(view: SmartView): boolean {
  return view === 'today' || view === 'week';
}

/** The group a task's row belongs to: its own placement, or its top-level ancestor's. */
export function groupOfTask(state: ListState, task: Task): string | undefined {
  let current: Task | undefined = task;
  for (let guard = 0; current && guard < 10; guard++) {
    if (current.placement) return current.placement.groupId;
    current = current.parentId ? state.tasks[current.parentId] : undefined;
  }
  return undefined;
}

/**
 * The row model of a smart view (02 §10): section headers (Today, Next 7 days), flat task rows
 * (subtasks with breadcrumbs, no nesting; Today adds the group chip), the drafts spliced in, and
 * "+ Add task" per section that takes adds. With nothing to show, one empty-state row.
 */
export function buildViewRows(
  state: ListState,
  sections: readonly ViewSection[],
  options: ViewRowOptions,
  cache?: RowCache,
): Row[] {
  const reuse = rowReuser(cache);
  const { view } = options;
  const inboxId = inboxOf(state)?.id ?? '';
  const filter = options.tagFilter ?? [];
  const visible = (task: Task) =>
    (task.completedAt === null || options.showCompleted || task.id in options.hiding) &&
    (filter.length === 0 || task.tagIds.some((id) => filter.includes(id)));
  const draftsBySection = new Map<string, Draft[]>();
  for (const draft of options.drafts) {
    if (!draft.sectionId) continue;
    const list = draftsBySection.get(draft.sectionId) ?? [];
    list.push(draft);
    draftsBySection.set(draft.sectionId, list);
  }
  const shown = sections.map((section) => ({
    section,
    tasks: section.taskIds.flatMap((id) => {
      const task = state.tasks[id];
      return task && visible(task) ? [task] : [];
    }),
  }));

  const rows: Row[] = [];
  if (shown.every((s) => s.tasks.length === 0 && !draftsBySection.has(s.section.id))) {
    const empty = reuse({ kind: 'empty', id: `empty:${view}`, view, canAdd: view !== 'overdue' });
    // Next 7 days keeps its empty days below, so a task can still be added to "Wed".
    if (view !== 'week') return [empty];
    rows.push(empty);
  }

  const breadcrumbOf = (parentId: string | null | undefined) =>
    parentId ? (state.tasks[parentId]?.title ?? null) : null;
  const chipOf = (groupId: string | undefined) => {
    const name = view === 'today' && groupId ? state.groups[groupId]?.name : undefined;
    return name === undefined ? {} : { groupChip: name };
  };
  const taskRow = (task: Task, sectionId: string): TaskRow => {
    const groupId = groupOfTask(state, task) ?? inboxId;
    return reuse<TaskRow>({
      kind: 'task',
      id: task.id,
      task,
      groupId,
      draft: false,
      level: 2,
      parentId: null,
      expandable: false,
      expanded: false,
      breadcrumb: breadcrumbOf(task.parentId),
      sectionId,
      ...chipOf(groupId),
    });
  };
  const draftRow = (draft: Draft, sectionId: string): TaskRow =>
    reuse<TaskRow>({
      kind: 'task',
      id: draft.id,
      task: options.draftTask(draft),
      groupId: draft.groupId,
      draft: true,
      level: 2,
      parentId: null,
      expandable: false,
      expanded: false,
      breadcrumb: breadcrumbOf(draft.parentId),
      sectionId,
    });

  const headers = viewHasHeaders(view);
  shown.forEach(({ section, tasks }, index) => {
    if (headers) {
      rows.push(
        reuse({
          kind: 'section',
          id: sectionRowId(section.id),
          sectionId: section.id,
          sectionKind: section.kind,
          date: section.date,
          count: tasks.filter((t) => t.completedAt === null).length,
          first: index === 0,
        }),
      );
    }
    const items: (Task | TaskRow)[] = [...tasks];
    for (const draft of draftsBySection.get(section.id) ?? []) {
      const at =
        draft.afterId === null
          ? 0
          : items.findIndex((r) => r.id === draft.afterId) + 1 || items.length;
      items.splice(at, 0, draftRow(draft, section.id));
    }
    for (const item of items) rows.push('kind' in item ? item : taskRow(item, section.id));
    if (sectionTakesAdds(section)) {
      rows.push(
        reuse({
          kind: 'add',
          id: addSectionRowId(section.id),
          groupId: inboxId,
          sectionId: section.id,
        }),
      );
    }
  });
  return rows;
}
