import { Check, ChevronRight, GripVertical } from 'lucide-react';
import { type MouseEvent, memo, Suspense, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { type ListUiState, useRowUi } from '../../state/list-store';
import { iconStrokeWidth } from '../../ui/button';
import { TaskCheckbox } from '../../ui/task-checkbox';
import { DateCell, type DueValue } from '../dates';
import type { ReminderSlotProps } from '../dates/date-popover';
import { RowAssignee } from '../people/assignee-avatar';
import { DropLine } from './drop-line';
import { GridCell, GridRow } from './grid';
import { LazyTaskReminders } from './lazy';
import { useListContext } from './list-context';
import type { TaskRow as TaskRowModel } from './model/rows';
import { useTaskRowName } from './row-name';
import {
  AttachmentCount,
  DescriptionIndicator,
  GroupChip,
  ReminderIndicator,
  RepeatIndicator,
  RowTagChips,
  SubtaskCounter,
} from './task-meta';
import { TitleInput, titleInputHandle } from './title-input';
import { useKeyboardDragHandle } from './use-list-dnd';

/** Clicks and drags on these never select the row or start a drag. */
export const interactiveSelector = '[data-no-row-press],input,button,[role="checkbox"]';

type CaretDocument = Document & {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
};

/** The character offset under the pointer, so a click on the title puts the caret there. */
function caretOffsetAt(event: MouseEvent, within: Element): number | 'end' {
  const doc = document as CaretDocument;
  const position = doc.caretPositionFromPoint?.(event.clientX, event.clientY);
  if (position && within.contains(position.offsetNode)) return position.offset;
  const range = document.caretRangeFromPoint?.(event.clientX, event.clientY);
  if (range && within.contains(range.startContainer)) return range.startOffset;
  return 'end';
}

const flag = {
  selected: 1,
  source: 2,
  dateOpen: 4,
  hold: 8,
  collapsing: 16,
  tagOpen: 32,
  selectionMode: 64,
} as const;

function rowFlags(s: ListUiState, id: string): number {
  let bits = 0;
  if (s.selected[id]) bits |= flag.selected;
  if (s.dragging?.includes(id) || s.keyboardDrag?.ids.includes(id)) bits |= flag.source;
  if (s.popover?.kind === 'date' && s.popover.rowId === id) bits |= flag.dateOpen;
  if (s.popover?.kind === 'tag' && s.popover.rowId === id) bits |= flag.tagOpen;
  const hiding = s.hiding[id];
  if (hiding === 'hold') bits |= flag.hold;
  if (hiding === 'collapsing') bits |= flag.collapsing;
  if (s.selectionMode) bits |= flag.selectionMode;
  return bits;
}

function editingOf(s: ListUiState, id: string): ListUiState['editing'] {
  return s.editing?.rowId === id ? s.editing : null;
}

/**
 * Selection mode's stand-in for the checkbox (02 §13.2): a circle that fills with the accent
 * when the row is selected. The row's `aria-selected` carries the state.
 */
function SelectionCircle({ selected }: { selected: boolean }) {
  return (
    <span aria-hidden className="flex size-hit-touch shrink-0 items-center justify-center">
      <span
        data-selection-circle
        className={cn(
          'inline-flex size-5 items-center justify-center rounded-full border-(length:--border-check)',
          'transition-colors duration-(--dur-fast) ease-standard',
          selected
            ? 'border-selection-bar bg-selection-bar text-text-on-accent'
            : 'border-border-strong bg-bg-app text-transparent',
        )}
      >
        <Check className="size-3" strokeWidth={3} />
      </span>
    </span>
  );
}

export interface TaskRowProps {
  row: TaskRowModel;
  /** The pane's subtask list: 36 px rows without indentation. */
  compact?: boolean;
}

/**
 * 03 §3.1: drag handle · round checkbox · title · date cell, 40 px (52 px on phones).
 * Navigate shows the title as text (ellipsis); Edit swaps in an input with the same metrics.
 */
export const TaskRow = memo(function TaskRow({ row, compact = false }: TaskRowProps) {
  const { t } = useTranslation('list');
  const {
    controller,
    dateCtx,
    dragEnabled,
    onOpenTask,
    baseLevel = 2,
    mobile = false,
    shared,
    everyone = false,
  } = useListContext();
  const { id, task, draft, level, expandable, expanded, breadcrumb } = row;
  const subtaskRow = compact || level > 2;
  const indent = level - baseLevel;
  // One packed subscription per row: 500 rows × several selectors per store update add up.
  const flags = useRowUi(id, rowFlags);
  const selected = (flags & flag.selected) !== 0;
  const isSource = (flags & flag.source) !== 0;
  const dateOpen = (flags & flag.dateOpen) !== 0;
  const selectionMode = (flags & flag.selectionMode) !== 0;
  const hiding = flags & flag.collapsing ? 'collapsing' : flags & flag.hold ? 'hold' : undefined;
  const editing = useRowUi(id, editingOf);
  const done = task.completedAt !== null;
  // FR-TASK-10: in Everyone's tasks, and on subtasks someone else does.
  const assignee =
    shared !== false &&
    task.assigneeId !== null &&
    (everyone || (task.parentId !== null && task.assigneeId !== controller.deps.userId))
      ? task.assigneeId
      : null;

  const handleKeys = useKeyboardDragHandle(id);

  const onRowClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as Element;
      if (mobile && !draft) {
        // 02 §13.2: a tap opens the detail sheet (titles are edited there); in selection
        // mode it toggles the row.
        if (selectionMode) {
          if (!target.closest('[data-no-row-press]')) controller.toggleSelectionMode(id);
          return;
        }
        if (target.closest(interactiveSelector)) return;
        controller.ui().select(id);
        onOpenTask?.(id, false);
        return;
      }
      if (target.closest(interactiveSelector)) return;
      if (target.closest('[data-tag-chips]') && !draft) {
        controller.ui().select(id);
        controller.ui().set({ popover: { kind: 'tag', rowId: id } });
        return;
      }
      const title = target.closest('[data-focus-target]');
      // A click on the title text edits with the caret where clicked (02 §3.3).
      if (title && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        controller.ui().edit(id, caretOffsetAt(event, title));
        return;
      }
      const store = controller.ui();
      if (event.metaKey || event.ctrlKey) controller.toggleInSelection(id);
      else if (event.shiftKey && store.anchor) controller.selectRange(store.anchor, id);
      else {
        // 02 §3.3: a click on the row body selects it and opens the pane (focus stays here).
        store.select(id);
        if (!draft) onOpenTask?.(id, false);
      }
    },
    [controller, id, draft, onOpenTask, mobile, selectionMode],
  );

  const onDueChange = (next: DueValue | null) => controller.setDue([id], next);
  // A draft's date applies when it is created. Its title stays in edit while the picker is
  // open: the press, and then the picker, take focus, and a blur would commit the draft.
  const resumeDraftEdit = (frames = 0) => {
    // After the picker has closed and handed focus back (its exit can take a few frames).
    requestAnimationFrame(() => {
      if (controller.ui().suspendedEdit !== id) return;
      const active = document.activeElement;
      if (active?.closest('[role="dialog"]') && frames < 30) {
        resumeDraftEdit(frames + 1);
        return;
      }
      controller.ui().set({ suspendedEdit: null });
      const title = titleInputHandle(id);
      const row = document.querySelector(`[data-row-id="${CSS.escape(id)}"]`);
      if (!active || active === document.body || row?.contains(active)) title?.focus();
      // A click elsewhere closed it: that ends the edit like any blur.
      else title?.blur();
    });
  };
  const holdDraftEdit = () => {
    if (controller.ui().editing?.rowId !== id) return;
    controller.ui().set({ suspendedEdit: id });
    // A press that opens nothing (dragged off the cell) hands the caret back.
    const done = new AbortController();
    const settle = () => {
      done.abort();
      setTimeout(() => {
        if (controller.ui().popover?.rowId !== id) resumeDraftEdit();
      });
    };
    window.addEventListener('pointerup', settle, { capture: true, signal: done.signal });
    window.addEventListener('pointercancel', settle, { capture: true, signal: done.signal });
  };
  const onDraftDateOpen = (open: boolean) => {
    if (open) controller.ui().set({ popover: { kind: 'date', rowId: id } });
    else {
      controller.ui().set({ popover: null });
      resumeDraftEdit();
    }
  };
  // P10: the picker's reminder section; it loads (and fetches the reminders) when shown.
  const renderReminders = useCallback(
    (slot: ReminderSlotProps) => (
      <Suspense fallback={null}>
        <LazyTaskReminders taskId={id} controller={controller} ctx={dateCtx} slot={slot} />
      </Suspense>
    ),
    [id, controller, dateCtx],
  );

  const label = task.title || t('row.untitled');
  // 10 §5: the row reads "Book dentist, due tomorrow, not completed, 2 of 5 subtasks". Focus
  // sits on the title, so it carries the rest as its description: an attribute, not a node,
  // so the row's text stays its title.
  const rowName = useTaskRowName(task, label, dateCtx);
  return (
    <GridRow
      aria-level={level}
      aria-label={draft ? undefined : rowName.name}
      aria-selected={selected}
      {...(expandable ? { 'aria-expanded': expanded } : {})}
      data-row-id={id}
      data-testid="task-row"
      data-done={done || undefined}
      data-draft={draft || undefined}
      onClick={onRowClick}
      onFocus={(event) => {
        // Tabbing onto the title (or name) selects the row in Navigate.
        if (!(event.target as Element).matches('[data-focus-target]')) return;
        const store = controller.ui();
        if (store.cursor !== id && store.mode === 'navigate') store.select(id);
      }}
      data-level={level}
      style={indent > 0 ? { paddingInlineStart: `calc(var(--space-6) * ${indent})` } : undefined}
      className={cn(
        'group/row relative flex shrink-0 items-center rounded-sm pe-1 max-tablet:h-row-mobile',
        // Phones: vertical pans scroll, horizontal ones are swipes; a long-press lifts the row
        // without the system's text callout.
        'pointer-coarse:touch-pan-y pointer-coarse:select-none pointer-coarse:touch-callout-none',
        'max-tablet:scroll-m-list',
        subtaskRow ? 'h-row-subtask' : 'h-row',
        'transition-[height,opacity] duration-(--dur-slow) ease-standard',
        selected ? 'bg-bg-selected' : 'hover:bg-bg-subtle',
        'has-[[data-focus-target]:focus-visible]:outline-2 has-[[data-focus-target]:focus-visible]:-outline-offset-2 has-[[data-focus-target]:focus-visible]:outline-border-focus',
        isSource && 'opacity-40',
        hiding === 'collapsing' && 'h-0 overflow-hidden opacity-0 max-tablet:h-0',
      )}
    >
      {selected && (
        <span
          aria-hidden
          className="absolute inset-y-1 start-0 w-0.5 rounded-full bg-selection-bar"
        />
      )}
      <DropLine rowId={id} />
      <GridCell
        className={cn(
          'relative flex w-4 shrink-0 justify-center ms-1',
          !expandable && 'pointer-coarse:hidden',
        )}
      >
        {expandable && (
          <button
            type="button"
            tabIndex={-1}
            data-chevron
            aria-label={t(expanded ? 'subtasks.collapse' : 'subtasks.expand', { title: label })}
            onClick={(e) => {
              e.stopPropagation();
              controller.toggleExpanded(id);
            }}
            className={cn(
              'absolute inset-y-0 start-0 z-10 flex w-4 items-center justify-center rounded-xs text-text-muted hover:text-text',
              'group-has-[[data-drag-handle]:focus-visible]/row:invisible',
            )}
          >
            <ChevronRight
              className={cn(
                'size-4 transition-transform duration-(--dur-fast)',
                expanded && 'rotate-90',
              )}
              strokeWidth={iconStrokeWidth}
              aria-hidden
            />
          </button>
        )}
        {!draft && dragEnabled && (
          <button
            type="button"
            data-drag-handle
            aria-label={t('row.dragHandle', { title: label })}
            aria-roledescription={t('dnd.handleRole')}
            {...handleKeys}
            className={cn(
              'flex h-6 w-4 cursor-grab items-center justify-center rounded-xs text-text-disabled',
              'opacity-0 transition-opacity duration-(--dur-fast) focus-visible:opacity-100',
              // A parent's chevron owns this column; its rows still drag from the body.
              !expandable && 'group-hover/row:opacity-100',
              isSource && 'opacity-100',
            )}
            onClick={(e) => {
              // A click on the handle selects the row (it does not edit).
              e.stopPropagation();
              const store = controller.ui();
              if (!store.selected[id]) store.select(id);
            }}
          >
            <GripVertical className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
          </button>
        )}
      </GridCell>
      <GridCell className="flex shrink-0 items-center">
        {selectionMode && !draft ? (
          <SelectionCircle selected={selected} />
        ) : (
          <TaskCheckbox
            aria-label={t(done ? 'row.uncomplete' : 'row.complete', { title: label })}
            isSelected={done}
            isDisabled={draft}
            onChange={() => controller.toggleComplete([id])}
            className="max-tablet:size-hit-touch"
          />
        )}
      </GridCell>
      <GridCell
        className={cn(
          'flex min-w-0 flex-1 items-center ps-1 pe-2 text-base max-tablet:text-md',
          done ? 'text-text-muted line-through' : 'text-text',
          'decoration-text-muted transition-colors duration-(--dur-fast)',
        )}
      >
        {editing ? (
          <TitleInput
            rowId={id}
            initialValue={task.title}
            caret={editing.caret}
            caretSeq={editing.seq}
            label={t('row.titleLabel')}
          />
        ) : (
          <>
            {breadcrumb !== null && (
              <span
                data-testid="row-breadcrumb"
                className="max-w-[30%] shrink-0 truncate pe-1 text-sm text-text-muted no-underline"
              >
                {t('row.breadcrumb', { title: breadcrumb })}
              </span>
            )}
            <span
              // biome-ignore lint/a11y/noNoninteractiveTabindex: the title is a tab stop (02 §6).
              tabIndex={0}
              data-focus-target
              aria-description={draft ? undefined : rowName.description}
              className="min-w-0 cursor-text truncate outline-none"
            >
              {task.title}
            </span>
          </>
        )}
        {!draft && (
          <span
            // Never more than half the cell, so a row full of meta (phones, Everyone's tasks)
            // keeps a readable title; the meta's tags truncate and the rest clips first.
            data-row-meta
            className="flex min-w-0 max-w-[50%] shrink-0 items-center gap-2 overflow-hidden ps-2 no-underline empty:hidden"
          >
            {row.groupChip !== undefined && <GroupChip name={row.groupChip} />}
            <RowTagChips task={task} />
            <DescriptionIndicator task={task} />
            <ReminderIndicator task={task} ctx={dateCtx} />
            <SubtaskCounter task={task} />
            <AttachmentCount task={task} />
            {task.recurrence && (
              <RepeatIndicator rule={task.recurrence} basis={task.recurrenceBasis} ctx={dateCtx} />
            )}
            {assignee !== null && <RowAssignee orgId={controller.orgId} assigneeId={assignee} />}
          </span>
        )}
      </GridCell>
      <GridCell
        data-no-row-press
        className="shrink-0"
        {...(draft && !mobile ? { onPointerDownCapture: holdDraftEdit } : {})}
      >
        {draft && mobile ? (
          // Phones pick a draft's date from the accessory bar (02 §13.3).
          <span className="block w-date-cell" />
        ) : draft ? (
          <DateCell
            value={{
              dueDate: task.dueDate,
              dueTime: task.dueTime,
              dueTz: task.dueTz,
              startDate: task.startDate,
            }}
            startDate={task.startDate}
            onChange={(next) => controller.setDraftDue(id, next)}
            ctx={dateCtx}
            isOpen={dateOpen}
            onOpenChange={onDraftDateOpen}
          />
        ) : (
          <DateCell
            value={{
              dueDate: task.dueDate,
              dueTime: task.dueTime,
              dueTz: task.dueTz,
              startDate: task.startDate,
              recurrence: task.recurrence ?? null,
              recurrenceBasis: task.recurrenceBasis ?? null,
            }}
            startDate={task.startDate}
            onChange={onDueChange}
            ctx={dateCtx}
            repeatable
            renderReminders={renderReminders}
            showReminders={task.nextReminderAt != null}
            // Phones give the title the room of the fixed date column (labels stay right-aligned).
            className="max-tablet:w-auto"
            completed={done}
            // Phones pick dates in a bottom sheet (the list renders it).
            isOpen={dateOpen && !mobile}
            onOpenChange={(open) =>
              controller.ui().set({ popover: open ? { kind: 'date', rowId: id } : null })
            }
          />
        )}
      </GridCell>
    </GridRow>
  );
});
