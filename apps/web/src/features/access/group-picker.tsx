import { Inbox } from 'lucide-react';
import { ListBox, ListBoxItem } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { CheckSquare } from './controls';
import type { GrantGroupOption } from './grant-model';

export interface GroupPickerProps {
  /** Accessible name, e.g. "Groups it may read in Acme". */
  label: string;
  /** Undefined while the org's groups load. */
  groups: readonly GrantGroupOption[] | undefined;
  selected: readonly string[];
  onChange: (groups: string[]) => void;
  /** Groups that can't be picked (narrow-only editing). */
  disabledIds?: readonly string[] | undefined;
  'data-testid'?: string;
}

/**
 * A multi-select of the user's groups in one org (Inbox first, labelled): one Tab stop,
 * arrows move, Space toggles, typing jumps to a group. Rows are 44 px on touch.
 */
export function GroupPicker({
  label,
  groups,
  selected,
  onChange,
  disabledIds,
  'data-testid': testId,
}: GroupPickerProps) {
  const { t } = useTranslation('settings');
  if (!groups) {
    return <p className="text-sm text-text-muted">{t('access.groupsLoading')}</p>;
  }
  return (
    <ListBox
      aria-label={label}
      selectionMode="multiple"
      selectionBehavior="toggle"
      selectedKeys={new Set(selected)}
      disabledKeys={disabledIds ?? []}
      onSelectionChange={(keys) => {
        if (keys === 'all') {
          onChange(groups.map((g) => g.id));
          return;
        }
        // Keep the groups' own order, so the payload is stable. Ids of deleted groups are
        // never kept selected (they are reconciled away before a save).
        const picked = new Set([...keys].map(String));
        onChange(groups.filter((g) => picked.has(g.id)).map((g) => g.id));
      }}
      {...(testId ? { 'data-testid': testId } : {})}
      className="flex flex-col rounded-sm border border-border bg-bg-app p-1 outline-none focus-ring:border-border-focus"
      renderEmptyState={() => (
        <p className="px-2 py-1.5 text-sm text-text-muted">{t('access.noGroups')}</p>
      )}
    >
      {groups.map((group) => {
        const name = group.isInbox ? t('access.inbox') : group.name;
        return (
          <ListBoxItem
            key={group.id}
            id={group.id}
            textValue={name}
            className={cn(
              'flex h-control cursor-default items-center gap-2 rounded-xs px-2 text-sm text-text outline-none',
              'pointer-coarse:h-hit-touch',
              'data-focused:bg-bg-muted data-pressed:bg-bg-muted',
              'data-focus-visible:outline-2 data-focus-visible:-outline-offset-2 data-focus-visible:outline-border-focus',
              'data-disabled:cursor-not-allowed data-disabled:text-text-disabled',
            )}
          >
            {({ isSelected, isDisabled }) => (
              <>
                <CheckSquare checked={isSelected} disabled={isDisabled} />
                {group.isInbox && (
                  <Inbox
                    className="size-4 shrink-0 text-text-secondary"
                    strokeWidth={iconStrokeWidth}
                    aria-hidden
                  />
                )}
                <span className="min-w-0 flex-1 truncate">{name}</span>
              </>
            )}
          </ListBoxItem>
        );
      })}
    </ListBox>
  );
}
