import { CornerDownLeft, Plus } from 'lucide-react';
import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { DropLine } from './drop-line';
import { GridCell, GridRow } from './grid';
import { useListContext } from './list-context';
import type { AddGroupRow, AddRow, AddSubtaskRow, HintRow } from './model/rows';

const addClass = cn(
  'flex w-full cursor-default items-center rounded-sm text-start text-base text-text-muted max-tablet:text-md',
  'transition-colors duration-(--dur-fast) hover:text-text-secondary',
  'focus-visible:-outline-offset-2',
);

/** The drag-handle column of a task row, so icons and text line up with checkbox and title. */
function HandleSpacer() {
  return <span aria-hidden className="ms-1 w-4 shrink-0 pointer-coarse:hidden" />;
}

/** 03 §3.3: "+ Add task" at the end of each group. */
export const AddTaskRow = memo(function AddTaskRow({ row }: { row: AddRow }) {
  const { t } = useTranslation('list');
  const { controller } = useListContext();
  return (
    <GridRow
      aria-level={2}
      data-row-id={row.id}
      className="relative flex h-row shrink-0 max-tablet:h-row-mobile"
    >
      <DropLine rowId={row.id} />
      <GridCell className="flex flex-1">
        <button type="button" className={addClass} onClick={() => controller.addAtEnd(row.groupId)}>
          <HandleSpacer />
          <span className="flex size-hit shrink-0 items-center justify-center">
            <Plus className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
          </span>
          <span className="ps-1">{t('row.addTask')}</span>
        </button>
      </GridCell>
    </GridRow>
  );
});

/** 02 §14 first run: a ghost row in the first group. */
export const FirstRunHint = memo(function FirstRunHint({ row }: { row: HintRow }) {
  const { t } = useTranslation('list');
  const { controller } = useListContext();
  return (
    <GridRow
      aria-level={2}
      data-row-id={row.id}
      className="flex h-row shrink-0 max-tablet:h-row-mobile"
    >
      <GridCell className="flex flex-1">
        <button type="button" className={addClass} onClick={() => controller.addAtEnd(row.groupId)}>
          <HandleSpacer />
          <span className="flex size-hit shrink-0 items-center justify-center">
            <span className="size-checkbox rounded-full border-(length:--border-check) border-dashed border-border-strong" />
          </span>
          <span className="ps-1">{t('row.firstRunHint')}</span>
          <CornerDownLeft className="ms-1.5 size-4" strokeWidth={iconStrokeWidth} aria-hidden />
        </button>
      </GridCell>
    </GridRow>
  );
});

/** "+ Add group" at the end of the list. */
export const AddGroupRowView = memo(function AddGroupRowView({ row }: { row: AddGroupRow }) {
  const { t } = useTranslation('list');
  const { controller } = useListContext();
  return (
    <GridRow aria-level={1} data-row-id={row.id} className="mt-6 flex h-group shrink-0">
      <GridCell className="flex flex-1">
        <button
          type="button"
          className={cn(addClass, 'gap-1 ps-1')}
          onClick={() => controller.addGroupAtEnd()}
        >
          <span className="flex size-6 shrink-0 items-center justify-center">
            <Plus className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
          </span>
          <span className="text-base">{t('group.add')}</span>
        </button>
      </GridCell>
    </GridRow>
  );
});

/** 03 §3.3: "+ Add subtask" after an expanded parent's subtasks (and in the pane). */
export const AddSubtaskRowView = memo(function AddSubtaskRowView({ row }: { row: AddSubtaskRow }) {
  const { t } = useTranslation('list');
  const { controller, baseLevel = 2 } = useListContext();
  const indent = row.level - baseLevel;
  return (
    <GridRow
      aria-level={row.level}
      data-row-id={row.id}
      style={indent > 0 ? { paddingInlineStart: `calc(var(--space-6) * ${indent})` } : undefined}
      className={cn('relative flex shrink-0 max-tablet:h-row-mobile', 'h-row-subtask')}
    >
      <DropLine rowId={row.id} />
      <GridCell className="flex flex-1">
        <button
          type="button"
          data-testid="add-subtask"
          className={addClass}
          onClick={() => controller.addSubtask(row.parentId)}
        >
          <HandleSpacer />
          <span className="flex size-hit shrink-0 items-center justify-center">
            <Plus className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
          </span>
          <span className="ps-1 text-sm">{t('subtasks.add')}</span>
        </button>
      </GridCell>
    </GridRow>
  );
});
