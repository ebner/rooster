import { orderedGroups } from '@rooster/core/reducers';
import { Check, Inbox } from 'lucide-react';
import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import { Popover as AriaPopover, Dialog } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { Kbd } from '../../ui/kbd';
import { overlayOffsetPx, popoverMotion, popoverSurface } from '../../ui/popover';
import { useListContext } from './list-context';

/**
 * M / Tab+M (02 §5): a filterable group list anchored to the row (or the bulk bar), with
 * digit shortcuts 1–9 while the filter is empty. The tasks go to the top of the group.
 */
export function MoveToPopover({ anchor, ids }: { anchor: Element; ids: readonly string[] }) {
  const { t } = useTranslation('list');
  const { controller } = useListContext();
  const triggerRef = useRef<Element>(anchor);
  triggerRef.current = anchor;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const state = controller.state();
  const currentGroup =
    ids.length === 1 ? state?.tasks[ids[0] as string]?.placement?.groupId : undefined;
  const groups = useMemo(() => {
    const all = state ? orderedGroups(state) : [];
    const q = query.trim().toLocaleLowerCase();
    return q === '' ? all : all.filter((g) => g.name.toLocaleLowerCase().includes(q));
  }, [state, query]);
  const close = () => controller.ui().set({ popover: null });
  const choose = (groupId: string | undefined) => {
    if (!groupId) return;
    controller.moveToGroup(groupId, ids);
    close();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActive((i) => (groups.length === 0 ? 0 : (i + step + groups.length) % groups.length));
    } else if (event.key === 'Enter') {
      event.preventDefault();
      choose(groups[active]?.id);
    } else if (query === '' && /^[1-9]$/.test(event.key) && !event.ctrlKey && !event.metaKey) {
      event.preventDefault();
      choose(groups[Number(event.key) - 1]?.id);
    }
  };

  return (
    <AriaPopover
      triggerRef={triggerRef}
      isOpen
      onOpenChange={(open) => {
        if (!open) close();
      }}
      placement="bottom start"
      offset={overlayOffsetPx}
      className={cn(popoverSurface, popoverMotion, 'w-date-popover bg-bg-elevated')}
    >
      <Dialog
        aria-label={t('moveTo.title', { count: ids.length })}
        className="flex flex-col outline-none"
      >
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="move-to-list"
          aria-activedescendant={groups[active] ? `move-to-${groups[active].id}` : undefined}
          aria-label={t('moveTo.filter')}
          placeholder={t('moveTo.placeholder')}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-control rounded-sm bg-bg-subtle px-2 text-sm text-text outline-none placeholder:text-text-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-focus"
        />
        <div
          id="move-to-list"
          role="listbox"
          aria-label={t('moveTo.groups')}
          className="mt-1 flex max-h-80 flex-col overflow-y-auto"
        >
          {groups.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-text-muted">{t('moveTo.empty')}</p>
          )}
          {groups.map((group, index) => (
            <div
              key={group.id}
              id={`move-to-${group.id}`}
              role="option"
              tabIndex={-1}
              aria-selected={index === active}
              onPointerMove={() => setActive(index)}
              onClick={() => choose(group.id)}
              onKeyDown={() => undefined}
              className={cn(
                'flex h-control cursor-default items-center gap-2 rounded-sm px-2 text-sm text-text',
                index === active && 'bg-bg-muted',
              )}
            >
              {group.kind === 'inbox' ? (
                <Inbox
                  className="size-4 shrink-0 text-text-secondary"
                  strokeWidth={iconStrokeWidth}
                  aria-hidden
                />
              ) : (
                <span className="size-4 shrink-0" aria-hidden />
              )}
              <span className="min-w-0 flex-1 truncate">{group.name}</span>
              {group.id === currentGroup && (
                <Check
                  className="size-4 shrink-0 text-text-secondary"
                  strokeWidth={iconStrokeWidth}
                  aria-label={t('moveTo.current')}
                />
              )}
              {query === '' && index < 9 && <Kbd shortcut={String(index + 1)} />}
            </div>
          ))}
        </div>
      </Dialog>
    </AriaPopover>
  );
}
