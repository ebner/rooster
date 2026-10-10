import { CalendarX2, Trash2 } from 'lucide-react';
import { Popover as AriaPopover, Dialog } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { BottomSheet, SheetOption } from '../../ui/bottom-sheet';
import { Button } from '../../ui/button';
import { overlayOffsetPx, popoverMotion, popoverSurface } from '../../ui/popover';

/** "This" skips the occurrence (the series goes on); "following" deletes it and ends the series. */
export type RecurringDeleteChoice = 'this' | 'following';

export interface RecurringDeleteProps {
  /** The task's title, named in the question. */
  title: string;
  onChoose: (choice: RecurringDeleteChoice) => void;
  onCancel: () => void;
}

/**
 * The question itself (FR-REC-4, ADR 0049 §1.7): "Delete this task" or "Delete this and
 * following". The first choice has focus, so Enter deletes only this occurrence; Tab reaches
 * the second; Esc cancels.
 */
export function RecurringDeleteBody({
  title,
  onChoose,
  onCancel,
  autoFocus = true,
  'data-force': force,
}: RecurringDeleteProps & { autoFocus?: boolean; 'data-force'?: string | undefined }) {
  const { t } = useTranslation('list');
  return (
    <div className="flex flex-col gap-3" data-testid="recurring-delete">
      <div className="flex flex-col gap-1">
        <p className="text-sm font-semibold text-text">{t('recurringDelete.title')}</p>
        <p className="text-sm text-text-secondary">
          {t('recurringDelete.body', { title: title || t('row.untitled') })}
        </p>
      </div>
      <div className="flex flex-col gap-1.5">
        <Button
          size="sm"
          variant="secondary"
          autoFocus={autoFocus}
          onPress={() => onChoose('this')}
          data-testid="recurring-delete-this"
          {...(force ? { 'data-force': force } : {})}
        >
          {t('recurringDelete.this')}
        </Button>
        <Button
          size="sm"
          variant="danger"
          onPress={() => onChoose('following')}
          data-testid="recurring-delete-following"
        >
          {t('recurringDelete.following')}
        </Button>
        <Button size="sm" variant="ghost" onPress={onCancel}>
          {t('recurringDelete.cancel')}
        </Button>
      </div>
    </div>
  );
}

/** Anchored to the row (or the pane's menu button); no modal (02 §1). */
export function RecurringDeletePopover({
  anchor,
  ...props
}: RecurringDeleteProps & { anchor: Element }) {
  const { t } = useTranslation('list');
  return (
    <AriaPopover
      triggerRef={{ current: anchor }}
      isOpen
      onOpenChange={(open) => {
        if (!open) props.onCancel();
      }}
      placement="bottom end"
      offset={overlayOffsetPx}
      className={cn(popoverSurface, popoverMotion, 'w-date-popover bg-bg-elevated p-3')}
    >
      <Dialog aria-label={t('recurringDelete.title')} className="outline-none">
        <RecurringDeleteBody {...props} />
      </Dialog>
    </AriaPopover>
  );
}

/** The phone's version (02 §13): the same two choices as 48 px sheet rows. */
export function RecurringDeleteSheet({
  isOpen,
  title,
  onChoose,
  onCancel,
  isStatic = false,
}: RecurringDeleteProps & { isOpen: boolean; isStatic?: boolean }) {
  const { t } = useTranslation('list');
  return (
    <BottomSheet
      isOpen={isOpen}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={t('recurringDelete.title')}
      description={title || t('row.untitled')}
      isStatic={isStatic}
    >
      <div className="flex flex-col" data-testid="recurring-delete-sheet">
        <SheetOption
          icon={CalendarX2}
          label={t('recurringDelete.this')}
          onPress={() => onChoose('this')}
        />
        <SheetOption
          icon={Trash2}
          tone="danger"
          label={t('recurringDelete.following')}
          onPress={() => onChoose('following')}
        />
      </div>
    </BottomSheet>
  );
}
