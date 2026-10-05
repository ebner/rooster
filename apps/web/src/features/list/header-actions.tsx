import { ListChecks } from 'lucide-react';
import { ToggleButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { primaryKeys } from '../../keymap';
import { cn } from '../../lib/cn';
import { persistShowCompleted, useListStore } from '../../state/list-store';
import { buttonVariants, iconStrokeWidth } from '../../ui/button';
import { MenuItem } from '../../ui/menu';
import { Tooltip } from '../../ui/tooltip';

/** The header's "Show completed" toggle (02 §3.6; also Shift+H). */
export function ShowCompletedToggle() {
  const { t } = useTranslation('list');
  const showCompleted = useListStore((s) => s.showCompleted);
  return (
    <Tooltip content={t('header.showCompleted')} shortcut={primaryKeys('toggleCompleted')}>
      <ToggleButton
        isSelected={showCompleted}
        onChange={(next) => {
          useListStore.getState().set({ showCompleted: next });
          persistShowCompleted(next);
        }}
        className={cn(
          buttonVariants({ variant: 'ghost', size: 'sm' }),
          'data-selected:bg-bg-muted data-selected:text-text',
        )}
      >
        <ListChecks className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
        <span className="max-tablet:sr-only">{t('header.showCompleted')}</span>
      </ToggleButton>
    </Tooltip>
  );
}

/** The phone header's ⋯ entry for the same toggle (02 §13.1). */
export function ShowCompletedMenuItem() {
  const { t } = useTranslation('list');
  const { t: tm } = useTranslation('mobile');
  const showCompleted = useListStore((s) => s.showCompleted);
  return (
    <MenuItem
      icon={ListChecks}
      onAction={() => {
        const next = !useListStore.getState().showCompleted;
        useListStore.getState().set({ showCompleted: next });
        persistShowCompleted(next);
      }}
    >
      {showCompleted ? tm('header.hideCompleted') : t('header.showCompleted')}
    </MenuItem>
  );
}
