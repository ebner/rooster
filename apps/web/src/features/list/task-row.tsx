import { GripVertical } from 'lucide-react';
import { type MouseEvent, memo, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { type ListUiState, useListStore } from '../../state/list-store';
import { iconStrokeWidth } from '../../ui/button';
import { TaskCheckbox } from '../../ui/task-checkbox';
import { DateCell, type DueValue } from '../dates';
import { DropLine } from './drop-line';
import { GridCell, GridRow } from './grid';
import { useListContext } from './list-context';
import type { TaskRow as TaskRowModel } from './model/rows';
import { TitleInput } from './title-input';
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

const flag = { selected: 1, source: 2, dateOpen: 4, hold: 8, collapsing: 16 } as const;

function rowFlags(s: ListUiState, id: string): number {
  let bits = 0;
  if (s.selected[id]) bits |= flag.selected;
  if (s.dragging?.includes(id) || s.keyboardDrag?.ids.includes(id)) bits |= flag.source;
  if (s.popover?.kind === 'date' && s.popover.rowId === id) bits |= flag.dateOpen;
  const hiding = s.hiding[id];
  if (hiding === 'hold') bits |= flag.hold;
  if (hiding === 'collapsing') bits |= flag.collapsing;
  return bits;
}

export interface TaskRowProps {
  row: TaskRowModel;
}

/**
 * 03 §3.1: drag handle · round checkbox · title · date cell, 40 px (52 px on phones).
 * Navigate shows the title as text (ellipsis); Edit swaps in an input with the same metrics.
 */
export const TaskRow = memo(function TaskRow({ row }: TaskRowProps) {
  const { t } = useTranslation('list');
  const { controller, dateCtx, dragEnabled } = useListContext();
  const { id, task, draft } = row;
  // One packed subscription per row: 500 rows × several selectors per store update add up.
  const flags = useListStore((s) => rowFlags(s, id));
  const selected = (flags & flag.selected) !== 0;
  const isSource = (flags & flag.source) !== 0;
  const dateOpen = (flags & flag.dateOpen) !== 0;
  const hiding = flags & flag.collapsing ? 'collapsing' : flags & flag.hold ? 'hold' : undefined;
  const editing = useListStore((s) => (s.editing?.rowId === id ? s.editing : null));
  const done = task.completedAt !== null;

  const handleKeys = useKeyboardDragHandle(id);

  const onRowClick = useCallback(
    (event: MouseEvent<HTMLDivElement>) => {
      const target = event.target as Element;
      if (target.closest(interactiveSelector)) return;
      const title = target.closest('[data-focus-target]');
      // A click on the title text edits with the caret where clicked (02 §3.3).
      if (title && !event.metaKey && !event.ctrlKey && !event.shiftKey) {
        useListStore.getState().edit(id, caretOffsetAt(event, title));
        return;
      }
      const store = useListStore.getState();
      if (event.metaKey || event.ctrlKey) controller.toggleInSelection(id);
      else if (event.shiftKey && store.anchor) controller.selectRange(store.anchor, id);
      else store.select(id);
    },
    [controller, id],
  );

  const onDueChange = (next: DueValue | null) => controller.setDue([id], next);

  const label = task.title || t('row.untitled');
  return (
    <GridRow
      aria-level={2}
      aria-selected={selected}
      data-row-id={id}
      data-testid="task-row"
      data-done={done || undefined}
      data-draft={draft || undefined}
      onClick={onRowClick}
      onFocus={(event) => {
        // Tabbing onto the title (or name) selects the row in Navigate.
        if (!(event.target as Element).matches('[data-focus-target]')) return;
        const store = useListStore.getState();
        if (store.cursor !== id && store.mode === 'navigate') store.select(id);
      }}
      className={cn(
        'group/row relative flex h-row shrink-0 items-center rounded-sm pe-1 max-tablet:h-row-mobile',
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
      <GridCell className="flex w-4 shrink-0 justify-center ms-1 pointer-coarse:hidden">
        {!draft && dragEnabled && (
          <button
            type="button"
            data-drag-handle
            aria-label={t('row.dragHandle', { title: label })}
            aria-roledescription={t('dnd.handleRole')}
            {...handleKeys}
            className={cn(
              'flex h-6 w-4 cursor-grab items-center justify-center rounded-xs text-text-disabled',
              'opacity-0 transition-opacity duration-(--dur-fast) group-hover/row:opacity-100 focus-visible:opacity-100',
              isSource && 'opacity-100',
            )}
            onClick={(e) => {
              // A click on the handle selects the row (it does not edit).
              e.stopPropagation();
              const store = useListStore.getState();
              if (!store.selected[id]) store.select(id);
            }}
          >
            <GripVertical className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
          </button>
        )}
      </GridCell>
      <GridCell className="flex shrink-0 items-center">
        <TaskCheckbox
          aria-label={t(done ? 'row.uncomplete' : 'row.complete', { title: label })}
          isSelected={done}
          isDisabled={draft}
          onChange={() => controller.toggleComplete([id])}
        />
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
          <span
            // biome-ignore lint/a11y/noNoninteractiveTabindex: the title is a tab stop (02 §6).
            tabIndex={0}
            data-focus-target
            className="min-w-0 cursor-text truncate outline-none"
          >
            {task.title}
          </span>
        )}
      </GridCell>
      <GridCell data-no-row-press className="shrink-0">
        {draft ? (
          <span className="block w-date-cell" />
        ) : (
          <DateCell
            value={{ dueDate: task.dueDate, dueTime: task.dueTime, dueTz: task.dueTz }}
            onChange={onDueChange}
            ctx={dateCtx}
            completed={done}
            isOpen={dateOpen}
            onOpenChange={(open) =>
              useListStore.getState().set({ popover: open ? { kind: 'date', rowId: id } : null })
            }
          />
        )}
      </GridCell>
    </GridRow>
  );
});
