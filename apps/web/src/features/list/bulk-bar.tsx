import { Calendar, CheckCircle2, FolderInput, Hash, Trash2, X } from 'lucide-react';
import { Suspense, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { primaryKeys } from '../../keymap';
import { cn } from '../../lib/cn';
import { useListUi } from '../../state/list-store';
import { Button } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { type DueValue, noDue, sameDue } from '../dates';
import { LazyDatePopover } from '../dates/lazy';
import { LazyMoveToPopover } from './lazy';
import { useListContext } from './list-context';

/**
 * 03 §3.11 / 02 §3.3: with ≥ 2 tasks selected, a floating bar at the bottom centre:
 * "3 selected · Complete · Date · Move to · Delete · ✕". Tag and Assign arrive with P3/P6.
 */
export function BulkBar({
  ids,
  className,
}: {
  ids: readonly string[];
  /** Kitchen sink: render in the flow instead of floating. */
  className?: string | undefined;
}) {
  const { t } = useTranslation('list');
  const { controller, dateCtx } = useListContext();
  const dateRef = useRef<HTMLButtonElement>(null);
  const moveRef = useRef<HTMLButtonElement>(null);
  const [dateOpen, setDateOpen] = useState(false);
  const moveOpen = useListUi((s) => s.popover?.kind === 'moveTo' && s.popover.rowId === 'bulk');

  const state = controller.state();
  const values = ids.map((id) => {
    const task = state?.tasks[id];
    return task
      ? {
          dueDate: task.dueDate,
          dueTime: task.dueTime,
          dueTz: task.dueTz,
          startDate: task.startDate,
        }
      : noDue;
  });
  const first = values[0] ?? noDue;
  const common: DueValue = values.every((v) => sameDue(v, first)) ? first : noDue;

  return (
    <div
      role="toolbar"
      aria-label={t('bulk.label', { count: ids.length })}
      data-overlay
      data-bulk-bar
      className={cn(
        'fixed bottom-6 left-1/2 z-(--z-bulk-bar) flex h-12 -translate-x-1/2 items-center gap-0.5 rounded-lg bg-bg-inverse ps-4 pe-1.5 text-sm text-text-inverse shadow-lg',
        'animate-popover-in motion-reduce:animate-fade-in max-tablet:bottom-3 max-tablet:max-w-[calc(100vw-var(--space-6))]',
        className,
      )}
    >
      <span className="me-2 whitespace-nowrap font-medium tabular-nums">
        {t('bulk.selected', { count: ids.length })}
      </span>
      <Button
        variant="ghost-inverse"
        size="sm"
        icon={CheckCircle2}
        onPress={() => controller.toggleComplete(ids)}
      >
        <span className="max-tablet:sr-only">{t('bulk.complete')}</span>
      </Button>
      <Button
        ref={dateRef}
        variant="ghost-inverse"
        size="sm"
        icon={Calendar}
        onPress={() => setDateOpen(true)}
      >
        <span className="max-tablet:sr-only">{t('bulk.date')}</span>
      </Button>
      <Button
        ref={moveRef}
        variant="ghost-inverse"
        size="sm"
        icon={FolderInput}
        onPress={() => controller.ui().set({ popover: { kind: 'moveTo', rowId: 'bulk' } })}
      >
        <span className="max-tablet:sr-only">{t('bulk.moveTo')}</span>
      </Button>
      <Button
        data-bulk-tag
        variant="ghost-inverse"
        size="sm"
        icon={Hash}
        onPress={() => controller.ui().set({ popover: { kind: 'tag', rowId: 'bulk' } })}
      >
        <span className="max-tablet:sr-only">{t('bulk.tag')}</span>
      </Button>
      <Button
        variant="ghost-inverse"
        size="sm"
        icon={Trash2}
        onPress={() => controller.deleteTasks(ids)}
      >
        <span className="max-tablet:sr-only">{t('bulk.delete')}</span>
      </Button>
      <IconButton
        icon={X}
        variant="ghost-inverse"
        size="sm"
        aria-label={t('bulk.clear')}
        shortcut={primaryKeys('escape')}
        onPress={() => {
          const store = controller.ui();
          store.set({ selected: store.cursor ? { [store.cursor]: true } : {} });
        }}
      />
      <Suspense fallback={null}>
        {dateOpen && (
          <LazyDatePopover
            triggerRef={dateRef}
            isOpen={dateOpen}
            onOpenChange={setDateOpen}
            value={common}
            onChange={(next) => controller.setDue(ids, next)}
            ctx={dateCtx}
            placement="top"
          />
        )}
        {moveOpen && moveRef.current && <LazyMoveToPopover anchor={moveRef.current} ids={ids} />}
      </Suspense>
    </div>
  );
}
