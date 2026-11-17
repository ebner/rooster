import { useTranslation } from 'react-i18next';
import type { Org } from '../../data/types';
import { cn } from '../../lib/cn';
import { Avatar } from '../../ui/avatar';

/**
 * The `^org` suggestions under a new row's title (ADR 0073 A4), like `#tag` and `@name`: the
 * title keeps focus and its combobox points here (`aria-activedescendant`).
 */
export function OrgSuggestList({
  id,
  orgs,
  active,
  onPick,
  className,
}: {
  id: string;
  orgs: readonly Pick<Org, 'id' | 'name' | 'avatarEmoji' | 'color'>[];
  active: number;
  onPick: (index: number) => void;
  className?: string;
}) {
  const { t } = useTranslation('list');
  return (
    <div
      id={id}
      role="listbox"
      aria-label={t('all.orgSuggestions')}
      data-overlay
      data-testid="org-suggest"
      className={cn(
        'z-(--z-popover) flex w-date-popover flex-col rounded-md border border-border bg-bg-elevated p-1 shadow-md',
        className,
      )}
    >
      {orgs.map((org, index) => (
        <div
          key={org.id}
          id={`${id}-${index}`}
          role="option"
          tabIndex={-1}
          aria-selected={index === active}
          onPointerDown={(e) => {
            // Keep focus (and the edit) in the title.
            e.preventDefault();
            onPick(index);
          }}
          onKeyDown={() => undefined}
          className={cn(
            'flex h-control cursor-default items-center gap-2 rounded-sm px-2 text-sm text-text',
            index === active && 'bg-bg-muted',
          )}
        >
          <Avatar
            id={org.id}
            name={org.name}
            emoji={org.avatarEmoji}
            color={org.color}
            shape="square"
            size={20}
            decorative
          />
          <span className="min-w-0 flex-1 truncate">{org.name}</span>
        </div>
      ))}
    </div>
  );
}
