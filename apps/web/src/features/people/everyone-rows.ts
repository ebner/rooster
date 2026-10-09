import type { Task } from '@rooster/core/schemas';
import { addSectionRowId, type Draft, sectionRowId } from '../../state/list-store';
import { type Row, type RowCache, rowReuser, type TaskRow } from '../list/model/rows';
import type { EveryoneSection } from './everyone-model';

export interface EveryoneRowOptions {
  /** Every task the view knows, by ID (the Everyone cache, plus my list for breadcrumbs). */
  tasks: Readonly<Record<string, Task>>;
  drafts: readonly Draft[];
  draftTask: (draft: Draft) => Task;
  /** The Inbox a task created for me lands in (02 §11). */
  inboxId: string;
}

/**
 * The row model of Everyone's tasks (02 §11): a member header per section (avatar, name, open
 * count), flat task rows with breadcrumbs for subtasks, the drafts spliced in, and "+ Add task"
 * under every section.
 */
export function buildEveryoneRows(
  sections: readonly EveryoneSection[],
  options: EveryoneRowOptions,
  cache?: RowCache,
): Row[] {
  const reuse = rowReuser(cache);
  const { tasks } = options;
  const draftsBySection = new Map<string, Draft[]>();
  for (const draft of options.drafts) {
    if (!draft.sectionId) continue;
    const list = draftsBySection.get(draft.sectionId) ?? [];
    list.push(draft);
    draftsBySection.set(draft.sectionId, list);
  }
  const breadcrumbOf = (parentId: string | null | undefined) =>
    parentId ? (tasks[parentId]?.title ?? null) : null;
  const rows: Row[] = [];
  sections.forEach((section, index) => {
    const shown = section.taskIds.flatMap((id) => (tasks[id] ? [tasks[id] as Task] : []));
    rows.push(
      reuse({
        kind: 'section',
        id: sectionRowId(section.id),
        sectionId: section.id,
        sectionKind: 'flat',
        date: null,
        count: shown.filter((t) => t.completedAt === null).length,
        first: index === 0,
        assigneeId: section.assigneeId,
        person: section.member,
      }),
    );
    const items: (Task | TaskRow)[] = [...shown];
    for (const draft of draftsBySection.get(section.id) ?? []) {
      const at =
        draft.afterId === null
          ? 0
          : items.findIndex((r) => r.id === draft.afterId) + 1 || items.length;
      items.splice(
        at,
        0,
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
          sectionId: section.id,
        }),
      );
    }
    for (const item of items) {
      rows.push(
        'kind' in item
          ? item
          : reuse<TaskRow>({
              kind: 'task',
              id: item.id,
              task: item,
              groupId: options.inboxId,
              draft: false,
              level: 2,
              parentId: null,
              expandable: false,
              expanded: false,
              breadcrumb: breadcrumbOf(item.parentId),
              sectionId: section.id,
            }),
      );
    }
    rows.push(
      reuse({
        kind: 'add',
        id: addSectionRowId(section.id),
        groupId: options.inboxId,
        sectionId: section.id,
      }),
    );
  });
  return rows;
}
