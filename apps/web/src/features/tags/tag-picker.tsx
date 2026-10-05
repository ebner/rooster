import type { Tag } from '@rooster/core/schemas';
import { Check, Plus } from 'lucide-react';
import { type KeyboardEvent, useMemo, useRef, useState } from 'react';
import { Popover as AriaPopover, Dialog } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import { cn } from '../../lib/cn';
import { iconStrokeWidth } from '../../ui/button';
import { overlayOffsetPx, popoverMotion, popoverSurface } from '../../ui/popover';
import { TagDot } from './tag-dot';

export interface TagOption {
  kind: 'tag' | 'create';
  id: string;
  name: string;
  tag?: Tag;
}

/** Tags matching `query` (prefix matches first), plus "Create …" when no tag has that name. */
export function tagOptions(tags: readonly Tag[], query: string, allowCreate = true): TagOption[] {
  const q = query.trim().toLocaleLowerCase();
  const matches = tags
    .filter((t) => t.name.toLocaleLowerCase().includes(q))
    .sort((a, b) => {
      const pa = a.name.toLocaleLowerCase().startsWith(q) ? 0 : 1;
      const pb = b.name.toLocaleLowerCase().startsWith(q) ? 0 : 1;
      return pa - pb || a.name.localeCompare(b.name);
    })
    .map((tag): TagOption => ({ kind: 'tag', id: tag.id, name: tag.name, tag }));
  const exact = tags.some((t) => t.name.toLocaleLowerCase() === q);
  if (allowCreate && q !== '' && !exact) {
    matches.push({ kind: 'create', id: '__create', name: query.trim().slice(0, 40) });
  }
  return matches;
}

export interface TagPickerProps {
  anchor: Element;
  tags: readonly Tag[];
  /** Tags every target task has (checked). */
  applied: readonly string[];
  onToggle: (tagId: string) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
  /** Accessible name, e.g. "Tags for Book dentist". */
  label: string;
}

/**
 * Tab+T / T / # (02 §6, FR-TAG-2): a filterable tag list anchored to the row or the pane's
 * tags, with colour dots, a check on applied tags and "Create …". ↑/↓ move, Enter toggles
 * (the picker stays open for more), Esc closes.
 */
export function TagPicker({
  anchor,
  tags,
  applied,
  onToggle,
  onCreate,
  onClose,
  label,
}: TagPickerProps) {
  const { t } = useTranslation('tags');
  const triggerRef = useRef<Element>(anchor);
  triggerRef.current = anchor;
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(0);
  const options = useMemo(() => tagOptions(tags, query), [tags, query]);

  const choose = (option: TagOption | undefined) => {
    if (!option) return;
    if (option.kind === 'create') {
      onCreate(option.name);
      setQuery('');
    } else onToggle(option.id);
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

  return (
    <AriaPopover
      triggerRef={triggerRef}
      isOpen
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      placement="bottom start"
      offset={overlayOffsetPx}
      className={cn(popoverSurface, popoverMotion, 'w-date-popover bg-bg-elevated')}
    >
      <Dialog aria-label={label} className="flex flex-col outline-none">
        <input
          autoFocus
          role="combobox"
          aria-expanded
          aria-controls="tag-picker-list"
          aria-activedescendant={options[active] ? `tag-option-${options[active].id}` : undefined}
          aria-label={t('picker.filter')}
          placeholder={t('picker.placeholder')}
          value={query}
          maxLength={40}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          onKeyDown={onKeyDown}
          className="h-control rounded-sm bg-bg-subtle px-2 text-sm text-text outline-none placeholder:text-text-muted focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-border-focus pointer-coarse:text-md"
        />
        <div
          id="tag-picker-list"
          role="listbox"
          aria-label={t('picker.list')}
          aria-multiselectable
          className="mt-1 flex max-h-80 flex-col overflow-y-auto"
        >
          {options.length === 0 && (
            <p className="px-2 py-1.5 text-sm text-text-muted">{t('picker.empty')}</p>
          )}
          {options.map((option, index) => {
            const checked = option.kind === 'tag' && applied.includes(option.id);
            return (
              <div
                key={option.id}
                id={`tag-option-${option.id}`}
                role="option"
                tabIndex={-1}
                aria-selected={checked}
                data-active={index === active || undefined}
                onPointerMove={() => setActive(index)}
                onClick={() => choose(option)}
                onKeyDown={() => undefined}
                className={cn(
                  'flex h-control cursor-default items-center gap-2 rounded-sm px-2 text-sm text-text',
                  index === active && 'bg-bg-muted',
                )}
              >
                {option.kind === 'create' ? (
                  <>
                    <Plus
                      className="size-4 shrink-0 text-text-secondary"
                      strokeWidth={iconStrokeWidth}
                      aria-hidden
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {t('picker.create', { name: option.name })}
                    </span>
                  </>
                ) : (
                  <>
                    <span className="flex size-4 shrink-0 items-center justify-center">
                      {option.tag && <TagDot color={option.tag.color} />}
                    </span>
                    <span className="min-w-0 flex-1 truncate">{option.name}</span>
                    {checked && (
                      <Check
                        className="size-4 shrink-0 text-text-secondary"
                        strokeWidth={iconStrokeWidth}
                        aria-hidden
                      />
                    )}
                  </>
                )}
              </div>
            );
          })}
        </div>
      </Dialog>
    </AriaPopover>
  );
}
