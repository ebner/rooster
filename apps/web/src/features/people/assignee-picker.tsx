import { Check, UserX } from 'lucide-react';
import { type KeyboardEvent, useId, useMemo, useRef, useState } from 'react';
import { Popover as AriaPopover, Dialog } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { Avatar } from '../../ui/avatar';
import { iconStrokeWidth } from '../../ui/button';
import { overlayOffsetPx, popoverMotion, popoverSurface } from '../../ui/popover';
import { type MemberOption, memberOptions, type Person } from './members';

export interface AssigneePickerProps {
  anchor: Element;
  members: readonly Person[];
  meId: string;
  /** The assignee every target task has (null: unassigned); undefined when they differ. */
  current: string | null | undefined;
  onPick: (userId: string | null) => void;
  onClose: () => void;
  /** Accessible name, e.g. "Assign Book dentist". */
  label: string;
  placement?: 'bottom start' | 'top';
}

/** One option's avatar (or the Unassigned icon), name and the check on the current one. */
export function OptionBody({
  option,
  meId,
  current,
}: {
  option: MemberOption;
  meId: string;
  current: string | null | undefined;
}) {
  const { t } = useTranslation('people');
  const checked = current !== undefined && option.userId === current;
  return (
    <>
      {option.member ? (
        <Avatar
          id={option.member.userId}
          name={option.member.name}
          src={option.member.image ?? undefined}
          size={20}
          decorative
        />
      ) : (
        <UserX
          className="size-5 shrink-0 text-text-secondary"
          strokeWidth={iconStrokeWidth}
          aria-hidden
        />
      )}
      <span className="min-w-0 flex-1 truncate">
        {option.member ? option.member.name : t('unassigned')}
        {option.userId === meId && <span className="ms-1 text-text-muted">{t('picker.you')}</span>}
      </span>
      {checked && (
        <Check
          className="size-4 shrink-0 text-text-secondary"
          strokeWidth={iconStrokeWidth}
          aria-label={t('picker.current')}
        />
      )}
    </>
  );
}

export interface AssigneeListProps
  extends Pick<AssigneePickerProps, 'members' | 'meId' | 'current' | 'onPick' | 'onClose'> {
  /** Focus the filter on mount (the popover); off in static previews. */
  autoFocus?: boolean;
}

/**
 * The picker's filter field and member list. ↑/↓ move, Enter picks (and closes); the active
 * option starts on the current assignee, so Enter right away changes nothing.
 */
export function AssigneeList({
  members,
  meId,
  current,
  onPick,
  onClose,
  autoFocus = true,
}: AssigneeListProps) {
  const { t } = useTranslation('people');
  const id = useId();
  const [query, setQuery] = useState('');
  const options = useMemo(
    () => memberOptions(members, meId, query, t('unassigned')),
    [members, meId, query, t],
  );
  const [active, setActive] = useState(() =>
    Math.max(
      0,
      options.findIndex((o) => o.userId === current),
    ),
  );
  const choose = (option: MemberOption | undefined) => {
    if (!option) return;
    onPick(option.userId);
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (options.length === 0 ? 0 : (i + step + options.length) % options.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(options[active]);
    }
  };

  const optionId = (option: MemberOption) => `${id}-${option.userId ?? 'none'}`;
  return (
    <>
      <input
        // biome-ignore lint/a11y/noAutofocus: the picker opens for typing (02 §6 Tab+A).
        autoFocus={autoFocus}
        role="combobox"
        aria-expanded
        aria-controls={`${id}-list`}
        aria-activedescendant={options[active] ? optionId(options[active]) : undefined}
        aria-label={t('picker.filter')}
        placeholder={t('picker.placeholder')}
        value={query}
        onChange={(e) => {
          setQuery(e.target.value);
          setActive(0);
        }}
        onKeyDown={onKeyDown}
        className="h-control rounded-sm bg-bg-subtle px-2 text-sm text-text outline-none placeholder:text-text-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-focus"
      />
      <div
        id={`${id}-list`}
        role="listbox"
        aria-label={t('picker.list')}
        className="mt-1 flex max-h-80 flex-col overflow-y-auto"
      >
        {options.length === 0 && (
          <p className="px-2 py-1.5 text-sm text-text-muted">{t('picker.empty')}</p>
        )}
        {options.map((option, index) => (
          <div
            key={option.userId ?? 'none'}
            id={optionId(option)}
            role="option"
            tabIndex={-1}
            aria-selected={index === active}
            data-active={index === active || undefined}
            data-user-id={option.userId ?? 'none'}
            onPointerMove={() => setActive(index)}
            onClick={() => choose(option)}
            onKeyDown={() => undefined}
            className={cn(
              'flex h-control cursor-default items-center gap-2 rounded-sm px-2 text-sm text-text',
              index === active && 'bg-bg-muted',
            )}
          >
            <OptionBody option={option} meId={meId} current={current} />
          </div>
        ))}
      </div>
    </>
  );
}

/**
 * Tab+A / A, the pane's Assignee property and the bulk bar's Assign (02 §6, FR-COL-1): a
 * filterable member list anchored to the row, with Unassigned first. Esc closes.
 */
export function AssigneePicker({
  anchor,
  onClose,
  label,
  placement = 'bottom start',
  ...list
}: AssigneePickerProps) {
  const triggerRef = useRef<Element>(anchor);
  triggerRef.current = anchor;
  return (
    <AriaPopover
      triggerRef={triggerRef}
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      placement={placement}
      offset={overlayOffsetPx}
      className={cn(popoverSurface, popoverMotion, 'w-date-popover bg-bg-elevated')}
    >
      <Dialog
        aria-label={label}
        className="flex flex-col outline-none"
        data-testid="assignee-picker"
      >
        <AssigneeList {...list} onClose={onClose} />
      </Dialog>
    </AriaPopover>
  );
}
