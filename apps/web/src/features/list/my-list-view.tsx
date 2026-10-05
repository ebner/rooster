import type { Task } from '@rooster/core/schemas';
import { Keyboard, X } from 'lucide-react';
import {
  memo,
  type ReactElement,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useTranslation } from 'react-i18next';
import { useListPipeline, useMyList, useMyListStatus } from '../../data/list';
import { useMe } from '../../data/me';
import { useTags } from '../../data/tags';
import { cn } from '../../lib/cn';
import { type Draft, persistShowCompleted, useListStore } from '../../state/list-store';
import { syncProblemAfter, useSyncStore } from '../../state/sync-store';
import { setTags, useTagsStore } from '../../state/tags-store';
import { iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { Kbd } from '../../ui/kbd';
import { SkeletonRows } from '../../ui/skeleton';
import { SyncPill } from '../../ui/sync-pill';
import { toast } from '../../ui/toast';
import {
  eventZone,
  type ShortcutHandler,
  type ShortcutHandlers,
  useKeymapHandlers,
} from '../../use-keymap';
import { useViewerDateContext } from '../dates';
import type { PaneControls } from '../pane/pane-controls';
import { toggleCheatSheet } from '../shell/cheat-sheet';
import { TagPicker } from '../tags/tag-picker';
import { AddGroupRowView, AddSubtaskRowView, AddTaskRow, FirstRunHint } from './add-row';
import { announce, ListLiveRegion } from './announcer';
import { BulkBar } from './bulk-bar';
import { completionHoldMs, ListController, type Translate } from './controller';
import { GroupHeader } from './group-header';
import { ListContext, type ListContextValue } from './list-context';
import { buildRows, type Row, type RowCache } from './model/rows';
import { MoveToPopover } from './move-to-popover';
import { TaskRow } from './task-row';
import { ListDnd } from './use-list-dnd';

/** Rows map straight to their memoised components (no wrapper per row). */
function rowElement(row: Row) {
  switch (row.kind) {
    case 'group':
      return <GroupHeader key={row.id} row={row} />;
    case 'task':
      return <TaskRow key={row.id} row={row} />;
    case 'add':
      return <AddTaskRow key={row.id} row={row} />;
    case 'hint':
      return <FirstRunHint key={row.id} row={row} />;
    case 'addGroup':
      return <AddGroupRowView key={row.id} row={row} />;
    case 'addSubtask':
      return <AddSubtaskRowView key={row.id} row={row} />;
  }
}

export function draftPlaceholder(orgId: string, userId: string, draft: Draft): Task {
  return {
    id: draft.id,
    orgId,
    seq: null,
    parentId: draft.parentId ?? null,
    subtaskPosition: null,
    title: '',
    assigneeId: userId,
    createdBy: userId,
    dueDate: null,
    dueTime: null,
    dueTz: null,
    startDate: null,
    tagIds: [],
    completedAt: null,
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: draft.parentId ? null : { groupId: draft.groupId, position: '' },
    createdAt: 0,
    updatedAt: 0,
  };
}

interface ListRowsProps {
  orgId: string;
  userId: string;
  rowsRef: RefObject<readonly Row[]>;
}

/**
 * The rows, subscribed to the list data and the UI store on their own: a keystroke re-renders
 * this component (and only the rows whose model changed), not the layers above (AC-2.12).
 */
const ListRows = memo(function ListRows({ orgId, userId, rowsRef }: ListRowsProps) {
  const list = useMyList(orgId);
  const drafts = useListStore((s) => s.drafts);
  const showCompleted = useListStore((s) => s.showCompleted);
  const hiding = useListStore((s) => s.hiding);
  const dragCollapsed = useListStore((s) => s.dragCollapsed);
  const hoverExpanded = useListStore((s) => s.hoverExpanded);
  const tagFilter = useListStore((s) => s.tagFilter);
  const rowCache = useRef<{ orgId: string; cache: RowCache }>({ orgId, cache: new Map() });
  if (rowCache.current.orgId !== orgId) rowCache.current = { orgId, cache: new Map() };
  const draftTasks = useRef(new Map<string, Task>());
  const rows = useMemo(() => {
    if (!list.data) return [];
    return buildRows(
      list.data,
      {
        drafts,
        showCompleted,
        hiding,
        dragCollapsed,
        hoverExpanded,
        tagFilter,
        draftTask: (draft) => {
          let task = draftTasks.current.get(draft.id);
          if (
            !task ||
            task.placement?.groupId !== (draft.parentId ? undefined : draft.groupId) ||
            task.parentId !== (draft.parentId ?? null)
          ) {
            task = draftPlaceholder(orgId, userId, draft);
            draftTasks.current.set(draft.id, task);
          }
          return task;
        },
      },
      rowCache.current.cache,
    );
  }, [
    list.data,
    drafts,
    showCompleted,
    hiding,
    dragCollapsed,
    hoverExpanded,
    tagFilter,
    orgId,
    userId,
  ]);
  rowsRef.current = rows;
  // Same row object → same element: React skips it without even a memo comparison.
  const elements = useRef(new WeakMap<Row, ReactElement>());
  return rows.map((row) => {
    let element = elements.current.get(row);
    if (!element) {
      element = rowElement(row);
      elements.current.set(row, element);
    }
    return element;
  });
});

/** The list's own text input has focus: commit it before a chord acts on the row. */
export function activeTitle(): { rowId: string; raw: string } | null {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement) || !el.matches('[data-list-input]')) return null;
  const rowId = el.closest<HTMLElement>('[data-row-id]')?.dataset.rowId;
  return rowId ? { rowId, raw: el.value } : null;
}

function inForeignInput(): boolean {
  const el = document.activeElement;
  return (
    (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) &&
    !el.matches('[data-list-input]')
  );
}

/** Queue length for tests and tooling (`data-pending`); renders nothing visible. */
function SyncMarker() {
  const pending = useSyncStore((s) => s.pending);
  return <span hidden data-testid="sync-state" data-pending={pending} />;
}

const shortcutHintKey = 'rooster.list.shortcutHintDismissed';

const ShortcutHint = memo(function ShortcutHint() {
  const { t } = useTranslation('list');
  const [dismissed, setDismissed] = useState(() => {
    try {
      return globalThis.localStorage?.getItem(shortcutHintKey) === '1';
    } catch {
      return false;
    }
  });
  if (dismissed) return null;
  return (
    <div className="fixed right-6 bottom-6 z-(--z-sticky) hidden items-center in-data-pane-open:hidden! gap-1 rounded-full border border-border bg-bg-elevated py-1 ps-3 pe-1 text-sm text-text-secondary shadow-sm desktop:flex">
      <button
        type="button"
        className="flex items-center gap-2"
        onClick={() => toggleCheatSheet(true)}
      >
        <Keyboard className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
        {t('cheatSheet.hint')}
        <Kbd shortcut="?" />
      </button>
      <IconButton
        icon={X}
        size="sm"
        aria-label={t('cheatSheet.dismissHint')}
        onPress={() => {
          setDismissed(true);
          try {
            globalThis.localStorage?.setItem(shortcutHintKey, '1');
          } catch {
            // Storage blocked: hidden for this session only.
          }
        }}
      />
    </div>
  );
});

export interface MyListViewProps {
  orgId: string;
  userId: string;
  /** Accessible name of the tree grid. */
  label: string;
  /** The detail pane this list drives (02 §9); absent in the kitchen sink. */
  pane?: PaneControls | undefined;
}

/** Keys pressed with focus in the pane are the pane's (02 §9.1). */
function listOnly(handlers: ShortcutHandlers): ShortcutHandlers {
  const out: ShortcutHandlers = {};
  // Undo and redo are app-wide (02 §3.7): the pane's edits are on the same stack.
  const anywhere = new Set<string>(['undo', 'redo']);
  for (const [id, handler] of Object.entries(handlers) as [
    keyof ShortcutHandlers,
    ShortcutHandler,
  ][]) {
    if (anywhere.has(id)) {
      out[id] = handler;
      continue;
    }
    out[id] = (event) => {
      const zone = eventZone(event);
      return zone === 'pane' || zone === 'paneList' ? false : handler(event);
    };
  }
  return out;
}

/**
 * My tasks (02 §3–§5): the flat row model rendered as a tree grid, with Navigate/Edit modes,
 * drafts, selection and the bulk bar, drag and drop, and every list key bound to the
 * controller. All writes go through the mutation pipeline.
 */
export function MyListView({ orgId, userId, label, pane }: MyListViewProps) {
  const { t } = useTranslation('list');
  const status = useMyListStatus(orgId);
  const pipeline = useListPipeline();
  const dateCtx = useViewerDateContext();
  const selectedCount = useListStore((s) => Object.keys(s.selected).length);
  const popover = useListStore((s) => s.popover);
  const cursor = useListStore((s) => s.cursor);
  const focusSeq = useListStore((s) => s.focusSeq);
  const mode = useListStore((s) => s.mode);
  const failures = useSyncStore((s) => s.failures);
  const root = useRef<HTMLDivElement>(null);
  /** Written by `ListRows` on every render: the controller always sees the current rows. */
  const rowsRef = useRef<readonly Row[]>([]);
  const dateRef = useRef(dateCtx);
  dateRef.current = dateCtx;
  const prefs = useMe().data?.prefs;
  // Re-renders only when the org's tags (or queued tag creations) change.
  const tags = useTags(orgId).data;
  useEffect(() => setTags(tags ?? []), [tags]);
  const paneRef = useRef(pane);
  paneRef.current = pane;
  const prefsRef = useRef({
    parseTitles: prefs?.parseTitleDates ?? true,
    holdMs: prefs?.completeHideMs ?? completionHoldMs,
  });
  prefsRef.current = {
    parseTitles: prefs?.parseTitleDates ?? true,
    holdMs: prefs?.completeHideMs ?? completionHoldMs,
  };

  const controller = useMemo(
    () =>
      new ListController({
        orgId,
        userId,
        pipeline,
        t: t as unknown as Translate,
        rows: () => rowsRef.current,
        dateContext: () => dateRef.current,
        prefs: () => prefsRef.current,
        tags: () => Object.values(useTagsStore.getState().byId),
        pane: {
          isOpen: () => Boolean(paneRef.current?.taskId()),
          close: () => paneRef.current?.close(),
        },
      }),
    [orgId, userId, pipeline, t],
  );

  const context = useMemo<ListContextValue>(
    () => ({
      controller,
      dateCtx,
      parseTitles: prefsRef.current.parseTitles,
      dragEnabled: true,
      onOpenTask: (id, focus) => paneRef.current?.open(id, focus ? 'title' : null),
    }),
    [controller, dateCtx, prefs?.parseTitleDates],
  );

  // D-29: the open pane follows the selection; a multi-selection closes it (02 §3.3).
  useEffect(() => {
    const p = paneRef.current;
    if (!p?.taskId()) return;
    if (selectedCount > 1) {
      p.close();
      return;
    }
    if (cursor && controller.task(cursor) && !cursor.startsWith('group:')) {
      if (p.taskId() !== cursor) p.open(cursor, null);
    }
  }, [cursor, selectedCount, controller]);

  // A different org starts with a clean slate (drafts and selection are per list).
  useEffect(() => {
    useListStore.getState().set({
      drafts: [],
      selected: {},
      cursor: null,
      anchor: null,
      editing: null,
      mode: 'navigate',
      popover: null,
      hiding: {},
    });
  }, [orgId]);

  useEffect(
    () =>
      pipeline.onDropped((dropped) =>
        toast({ message: controller.describeDropped(dropped), tone: 'danger' }),
      ),
    [pipeline, controller],
  );

  // Navigate keeps DOM focus on the cursor row (its title or header name).
  useEffect(() => {
    if (mode !== 'navigate' || !cursor) return;
    const el = root.current?.querySelector<HTMLElement>(
      `[data-row-id="${cursor}"] [data-focus-target]`,
    );
    if (el && document.activeElement !== el && !useListStore.getState().popover) {
      el.focus({ preventScroll: true });
      el.scrollIntoView?.({ block: 'nearest' });
    }
  }, [cursor, focusSeq, mode]);

  const ready = status.ready;
  const withTitle = <T,>(fn: () => T): T => {
    const pending = activeTitle();
    if (pending) controller.commitTitle(pending.rowId, pending.raw);
    return fn();
  };
  const cursorTask = () => {
    const row = controller.cursorRow();
    return row?.kind === 'task' && !row.draft ? row : null;
  };

  const openPane = (focus: 'title' | 'description' | null) => {
    const row = cursorTask();
    if (!row || !pane) return false;
    pane.open(row.id, focus);
  };
  const openTagPicker = () => {
    const ids = controller.selectedTaskIds();
    if (ids.length === 0) return false;
    const store = useListStore.getState();
    store.set({ popover: { kind: 'tag', rowId: ids.length > 1 ? 'bulk' : (ids[0] as string) } });
  };

  useKeymapHandlers(
    listOnly({
      undo: () => (inForeignInput() ? false : controller.undo() || undefined),
      redo: () => (inForeignInput() ? false : controller.redo() || undefined),
      selectPrevious: () => controller.step(-1),
      selectNext: () => controller.step(1),
      extendUp: () => controller.extend(-1),
      extendDown: () => controller.extend(1),
      selectFirst: () => controller.selectEdge('first'),
      selectLast: () => controller.selectEdge('last'),
      selectAll: () => controller.selectAll(),
      toggleInSelection: () => {
        const id = useListStore.getState().cursor;
        if (!id) return false;
        controller.toggleInSelection(id);
      },
      collapse: () => controller.collapseCursor(true),
      expand: () => controller.collapseCursor(false),
      toggleCompleted: () => {
        const next = !useListStore.getState().showCompleted;
        useListStore.getState().set({ showCompleted: next });
        persistShowCompleted(next);
        announce(t(next ? 'header.completedShown' : 'header.completedHidden'));
      },
      editTitle: () => {
        const row = controller.cursorRow();
        if (row?.kind === 'task') useListStore.getState().edit(row.id, 'end');
        else if (row?.kind === 'group') controller.startRename(row.group.id);
        else return false;
      },
      newBelowNavigate: () => controller.newBelow(),
      newAboveNavigate: () => controller.newAbove(),
      quickAddNavigate: () => controller.quickAdd(),
      quickAdd: () => withTitle(() => controller.quickAdd()),
      dateNavigate: () => {
        const row = cursorTask();
        if (!row) return false;
        useListStore.getState().set({ popover: { kind: 'date', rowId: row.id } });
      },
      datePicker: () =>
        withTitle(() => {
          const row = cursorTask() ?? controller.cursorRow();
          if (row?.kind !== 'task') return false;
          useListStore.getState().set({ popover: { kind: 'date', rowId: row.id } });
        }),
      moveToNavigate: () => {
        if (controller.selectedTaskIds().length === 0) return false;
        useListStore
          .getState()
          .set({ popover: { kind: 'moveTo', rowId: useListStore.getState().cursor ?? '' } });
      },
      moveTo: () =>
        withTitle(() => {
          if (controller.selectedTaskIds().length === 0) return false;
          useListStore
            .getState()
            .set({ popover: { kind: 'moveTo', rowId: useListStore.getState().cursor ?? '' } });
        }),
      deleteNavigate: () => controller.deleteTasks(),
      deleteTask: () => {
        const store = useListStore.getState();
        const editing = store.editing?.rowId;
        if (editing && store.drafts.some((d) => d.id === editing)) {
          controller.backspaceEmpty(editing, false);
          return;
        }
        controller.deleteTasks();
      },
      complete: () => withTitle(() => controller.toggleComplete()),
      moveUp: () => withTitle(() => controller.keyboardMove('up')),
      moveDown: () => withTitle(() => controller.keyboardMove('down')),
      moveToPreviousGroup: () => withTitle(() => controller.keyboardMove('previousGroupEnd')),
      moveToNextGroup: () => withTitle(() => controller.keyboardMove('nextGroupStart')),
      moveToGroupTop: () => withTitle(() => controller.keyboardMove('groupTop')),
      moveToGroupBottom: () => withTitle(() => controller.keyboardMove('groupBottom')),
      newGroup: () => {
        const pending = activeTitle();
        controller.newGroupAtCursor(pending ? { ...pending, ignored: [] } : undefined);
      },
      escape: () => controller.escape(),
      addSubtaskNavigate: () => controller.addSubtask() || undefined,
      addSubtask: () => withTitle(() => controller.addSubtask() || undefined),
      tagPickerNavigate: () => openTagPicker(),
      tagPicker: () => withTitle(() => openTagPicker()),
      duplicate: () => withTitle(() => (controller.duplicate().length > 0 ? undefined : false)),
      openPane: () => openPane('title'),
      openPaneFocus: () => withTitle(() => openPane('title')),
      focusDescription: () => withTitle(() => openPane('description')),
      peekPane: () => {
        if (!pane) return false;
        if (pane.taskId()) pane.close();
        else return openPane(null);
      },
      paneFullScreen: () =>
        withTitle(() => {
          if (!pane) return false;
          if (!pane.taskId() && openPane(null) === false) return false;
          pane.toggleFullScreen();
        }),
    }),
    ready,
  );

  // Stable: data changes re-render only `ListRows`, never the DnD and context layers above it.
  const rowsElement = useMemo(
    () => <ListRows orgId={orgId} userId={userId} rowsRef={rowsRef} />,
    [orgId, userId],
  );
  const ids = selectedCount > 1 ? controller.selectedTaskIds() : [];
  const moveAnchor =
    popover?.kind === 'moveTo' && popover.rowId !== 'bulk'
      ? root.current?.querySelector(`[data-row-id="${popover.rowId}"]`)
      : null;
  const tagAnchor =
    popover?.kind === 'tag'
      ? popover.rowId === 'bulk'
        ? document.querySelector('[data-bulk-tag]')
        : root.current?.querySelector(
            `[data-row-id="${popover.rowId}"] [data-focus-target], [data-row-id="${popover.rowId}"] input`,
          )
      : null;
  const tagIds = popover?.kind === 'tag' ? controller.selectedTaskIds() : [];

  if (status.error && !status.ready) {
    return (
      <div
        role="alert"
        className="flex flex-col items-start gap-2 py-8 text-sm text-text-secondary"
      >
        {t('state.loadFailed')}
      </div>
    );
  }

  if (!status.ready) {
    return (
      <div className="flex flex-col" aria-busy="true">
        {[0, 1, 2].map((group) => (
          <div key={group} className={cn('flex flex-col', group > 0 && 'mt-6')}>
            <div className="flex h-group items-center ps-8">
              <span className="block h-3 w-24 rounded-xs skeleton-shimmer" />
            </div>
            <SkeletonRows count={3} />
          </div>
        ))}
      </div>
    );
  }

  return (
    <ListContext.Provider value={context}>
      {failures >= syncProblemAfter && (
        <div className="flex justify-end pb-2">
          <SyncPill state="error" onRetry={() => pipeline.retryNow()} />
        </div>
      )}
      <ListDnd rowsRef={rowsRef} label={label} rootRef={root} enabled={context.dragEnabled}>
        {rowsElement}
      </ListDnd>
      {ids.length > 1 && <BulkBar ids={ids} />}
      {moveAnchor && <MoveToPopover anchor={moveAnchor} ids={controller.selectedTaskIds()} />}
      {tagAnchor && tagIds.length > 0 && (
        <RowTagPicker anchor={tagAnchor} ids={tagIds} controller={controller} />
      )}
      <ListLiveRegion />
      <SyncMarker />
      <ShortcutHint />
    </ListContext.Provider>
  );
}

/** The tag picker for the selected rows (Tab+T / T / #, a click on the chips). */
export function RowTagPicker({
  anchor,
  ids,
  controller,
}: {
  anchor: Element;
  ids: string[];
  controller: ListController;
}) {
  const { t } = useTranslation('tags');
  const byId = useTagsStore((s) => s.byId);
  const tags = useMemo(() => Object.values(byId), [byId]);
  // Re-render on list changes so the checks follow the toggles.
  useMyList(controller.orgId);
  const tasks = ids.map((id) => controller.task(id)).filter((x): x is Task => x !== undefined);
  const applied = tags
    .filter((tag) => tasks.length > 0 && tasks.every((task) => task.tagIds.includes(tag.id)))
    .map((tag) => tag.id);
  const close = () => {
    controller.ui().set({ popover: null, focusSeq: controller.ui().focusSeq + 1 });
  };
  return (
    <TagPicker
      anchor={anchor}
      tags={tags}
      applied={applied}
      label={
        tasks.length === 1
          ? t('picker.label', { title: tasks[0]?.title ?? '' })
          : t('picker.labelMany', { count: tasks.length })
      }
      onToggle={(tagId) => controller.toggleTag(ids, tagId)}
      onCreate={(name) => controller.createTagFor(ids, name)}
      onClose={close}
    />
  );
}
