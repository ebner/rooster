import { childrenOf, type ListState } from '@rooster/core/reducers';
import type { Task } from '@rooster/core/schemas';
import {
  type ReactElement,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useMyListSelect } from '../../data/list';
import { addSubtaskRowId, type Draft, ListStoreContext, useListUi } from '../../state/list-store';
import { useIsMobile } from '../../ui/use-media';
import {
  eventZone,
  type ShortcutHandler,
  type ShortcutHandlers,
  useKeymapHandlers,
} from '../../use-keymap';
import { AddSubtaskRowView } from '../list/add-row';
import type { ListController } from '../list/controller';
import { LazyRecurringDeletePopover, LazyRecurringDeleteSheet } from '../list/lazy';
import { ListContext, type ListContextValue } from '../list/list-context';
import type { Row, TaskRow as TaskRowModel } from '../list/model/rows';
import { activeTitle, draftPlaceholder, RowTagPicker } from '../list/my-list-view';
import { TaskRow } from '../list/task-row';
import { ListDnd } from '../list/use-list-dnd';

/** Rows of the pane's subtask list: the direct subtasks (completed too), drafts, "+ Add". */
export function paneSubtaskRows(
  parentId: string,
  subtasks: readonly Task[],
  drafts: readonly Draft[],
  groupId: string,
  draftTask: (draft: Draft) => Task,
): Row[] {
  const items: TaskRowModel[] = subtasks.map((task) => ({
    kind: 'task',
    id: task.id,
    task,
    groupId,
    draft: false,
    level: 3,
    parentId,
    expandable: false,
    expanded: false,
    breadcrumb: null,
  }));
  for (const draft of drafts) {
    if (draft.parentId !== parentId) continue;
    const at =
      draft.afterId === null
        ? 0
        : items.findIndex((r) => r.id === draft.afterId) + 1 || items.length;
    items.splice(at, 0, {
      kind: 'task',
      id: draft.id,
      task: draftTask(draft),
      groupId,
      draft: true,
      level: 3,
      parentId,
      expandable: false,
      expanded: false,
      breadcrumb: null,
    });
  }
  return [
    ...items,
    { kind: 'addSubtask', id: addSubtaskRowId(parentId), parentId, groupId, level: 3 },
  ];
}

export interface PaneSubtasksProps {
  orgId: string;
  userId: string;
  task: Task;
  /** Subtasks from the task detail, for a task that is not in My tasks. */
  fallback: readonly Task[];
  controller: ListController;
  context: Omit<ListContextValue, 'controller' | 'baseLevel'>;
  /** Written on every render: the controller's rows. */
  rowsRef: { current: readonly Row[] };
  /** Esc with nothing left to clear in the subtask list: back to the main list (02 §9.1). */
  onEscapeOut: () => void;
}

function inPaneList(handlers: ShortcutHandlers): ShortcutHandlers {
  const out: ShortcutHandlers = {};
  for (const [id, handler] of Object.entries(handlers) as [
    keyof ShortcutHandlers,
    ShortcutHandler,
  ][]) {
    out[id] = (event) => (eventZone(event) === 'paneList' ? handler(event) : false);
  }
  return out;
}

/**
 * 02 §9.2 Subtasks: the list's row component in compact mode, with the same keyboard model
 * (its own selection store), sibling drag and drop, and "+ Add subtask".
 */
export function PaneSubtasks({
  orgId,
  userId,
  task,
  fallback,
  controller,
  context,
  rowsRef,
  onEscapeOut,
}: PaneSubtasksProps) {
  const { t } = useTranslation('pane');
  const store = controller.uiStore;
  const children = useMyListSelect(
    orgId,
    useCallback(
      (state: ListState) => (state.tasks[task.id] ? childrenOf(state, task.id) : null),
      [task.id],
    ),
  ).data;
  const root = useRef<HTMLDivElement>(null);
  const draftTasks = useRef(new Map<string, Task>());

  const value = useMemo<ListContextValue>(
    () => ({ ...context, controller, baseLevel: 3 }),
    [context, controller],
  );

  return (
    <ListStoreContext.Provider value={store}>
      <ListContext.Provider value={value}>
        <SubtaskRows
          parent={task}
          inList={children ?? null}
          fallback={fallback}
          rowsRef={rowsRef}
          draftTasks={draftTasks.current}
          orgId={orgId}
          userId={userId}
          rootRef={root}
          label={t('subtasks.label')}
        />
        <SubtaskKeys controller={controller} rootRef={root} onEscapeOut={onEscapeOut} />
        <SubtaskTagPicker controller={controller} rootRef={root} />
        <SubtaskRecurringDelete controller={controller} rootRef={root} />
      </ListContext.Provider>
    </ListStoreContext.Provider>
  );
}

function SubtaskRows({
  parent,
  inList,
  fallback,
  rowsRef,
  draftTasks,
  orgId,
  userId,
  rootRef,
  label,
}: {
  parent: Task;
  /** The subtasks from My tasks (null when the task is not in it). */
  inList: readonly Task[] | null;
  fallback: readonly Task[];
  rowsRef: { current: readonly Row[] };
  draftTasks: Map<string, Task>;
  orgId: string;
  userId: string;
  rootRef: { current: HTMLDivElement | null };
  label: string;
}) {
  const drafts = useListUi((s) => s.drafts);
  const subtasks = inList ?? fallback;
  const rows = useMemo(
    () =>
      paneSubtaskRows(parent.id, subtasks, drafts, parent.placement?.groupId ?? '', (draft) => {
        let task = draftTasks.get(draft.id);
        if (!task) {
          task = draftPlaceholder(orgId, userId, draft);
          draftTasks.set(draft.id, task);
        }
        return task;
      }),
    [parent.id, parent.placement?.groupId, subtasks, drafts, draftTasks, orgId, userId],
  );
  rowsRef.current = rows;
  const elements: ReactElement[] = rows.map((row) =>
    row.kind === 'task' ? (
      <TaskRow key={row.id} row={row} compact />
    ) : (
      <AddSubtaskRowView key={row.id} row={row as Extract<Row, { kind: 'addSubtask' }>} />
    ),
  );
  return (
    <ListDnd rowsRef={rowsRef} label={label} rootRef={rootRef} enabled compact>
      {elements}
    </ListDnd>
  );
}

/** The list keymap for the pane's subtasks, active only with focus inside them. */
function SubtaskKeys({
  controller,
  rootRef,
  onEscapeOut,
}: {
  controller: ListController;
  rootRef: { current: HTMLDivElement | null };
  onEscapeOut: () => void;
}) {
  const context = useContext(ListContext);
  const cursor = useListUi((s) => s.cursor);
  const focusSeq = useListUi((s) => s.focusSeq);
  const mode = useListUi((s) => s.mode);

  // Navigate keeps DOM focus on the cursor row, as long as focus is in this list.
  useEffect(() => {
    if (mode !== 'navigate' || !cursor) return;
    const rootEl = rootRef.current;
    if (!rootEl?.contains(document.activeElement)) return;
    const el = rootEl.querySelector<HTMLElement>(`[data-row-id="${cursor}"] [data-focus-target]`);
    if (el && document.activeElement !== el && !controller.ui().popover) {
      el.focus({ preventScroll: true });
      el.scrollIntoView?.({ block: 'nearest' });
    }
  }, [cursor, focusSeq, mode, controller, rootRef]);

  const withTitle = <T,>(fn: () => T): T => {
    const pending = activeTitle();
    if (pending) controller.commitTitle(pending.rowId, pending.raw);
    return fn();
  };
  const cursorTask = () => {
    const row = controller.cursorRow();
    return row?.kind === 'task' && !row.draft ? row : null;
  };
  const openTags = () => {
    const row = cursorTask();
    if (!row) return false;
    controller.ui().set({ popover: { kind: 'tag', rowId: row.id } });
  };
  const openDate = () => {
    const row = cursorTask();
    if (!row) return false;
    controller.ui().set({ popover: { kind: 'date', rowId: row.id } });
  };

  useKeymapHandlers(
    inPaneList({
      selectPrevious: () => controller.step(-1),
      selectNext: () => controller.step(1),
      extendUp: () => controller.extend(-1),
      extendDown: () => controller.extend(1),
      selectFirst: () => controller.selectEdge('first'),
      selectLast: () => controller.selectEdge('last'),
      toggleInSelection: () => {
        const id = controller.ui().cursor;
        if (!id) return false;
        controller.toggleInSelection(id);
      },
      editTitle: () => {
        const row = cursorTask();
        if (!row) return false;
        controller.ui().edit(row.id, 'end');
      },
      newBelowNavigate: () => controller.newBelow(),
      newAboveNavigate: () => controller.newAbove(),
      quickAddNavigate: () => controller.quickAdd(),
      quickAdd: () => withTitle(() => controller.quickAdd()),
      addSubtaskNavigate: () => controller.quickAdd(),
      addSubtask: () => withTitle(() => controller.quickAdd()),
      dateNavigate: openDate,
      datePicker: () => withTitle(openDate),
      tagPickerNavigate: openTags,
      tagPicker: () => withTitle(openTags),
      deleteNavigate: () => controller.deleteTasks(),
      deleteTask: () => {
        const store = controller.ui();
        const editing = store.editing?.rowId;
        if (editing && store.drafts.some((d) => d.id === editing)) {
          controller.backspaceEmpty(editing, false);
          return;
        }
        controller.deleteTasks();
      },
      complete: () => withTitle(() => controller.toggleComplete()),
      duplicate: () => withTitle(() => (controller.duplicate().length > 0 ? undefined : false)),
      moveUp: () => withTitle(() => controller.keyboardMove('up')),
      moveDown: () => withTitle(() => controller.keyboardMove('down')),
      openPane: () => {
        const row = cursorTask();
        if (!row) return false;
        context?.onOpenTask?.(row.id, true);
      },
      escape: () => {
        if (controller.escape()) return;
        onEscapeOut();
      },
    }),
  );
  return null;
}

function SubtaskTagPicker({
  controller,
  rootRef,
}: {
  controller: ListController;
  rootRef: { current: HTMLDivElement | null };
}) {
  const popover = useListUi((s) => s.popover);
  if (popover?.kind !== 'tag') return null;
  const anchor = rootRef.current?.querySelector(
    `[data-row-id="${popover.rowId}"] [data-focus-target], [data-row-id="${popover.rowId}"] input`,
  );
  if (!anchor) return null;
  return <RowTagPicker anchor={anchor} ids={[popover.rowId]} controller={controller} />;
}

/**
 * FR-REC-4 for a recurring subtask: Delete / Tab+Delete in the pane asks "this task / this and
 * following" here, anchored to the subtask's row (a sheet on phones).
 */
function SubtaskRecurringDelete({
  controller,
  rootRef,
}: {
  controller: ListController;
  rootRef: { current: HTMLDivElement | null };
}) {
  const popover = useListUi((s) => s.popover);
  const mobile = useIsMobile();
  if (popover?.kind !== 'recurringDelete') return null;
  const { rowId } = popover;
  const props = {
    title: controller.task(rowId)?.title ?? '',
    onChoose: (choice: 'this' | 'following') => controller.deleteRecurring(rowId, choice),
    onCancel: () => controller.ui().set({ popover: null, focusSeq: controller.ui().focusSeq + 1 }),
  };
  if (mobile) {
    return (
      <Suspense fallback={null}>
        <LazyRecurringDeleteSheet isOpen {...props} />
      </Suspense>
    );
  }
  const anchor = rootRef.current?.querySelector(
    `[data-row-id="${rowId}"] [data-focus-target], [data-row-id="${rowId}"] input, [data-row-id="${rowId}"]`,
  );
  if (!anchor) return null;
  return (
    <Suspense fallback={null}>
      <LazyRecurringDeletePopover anchor={anchor} {...props} />
    </Suspense>
  );
}
