import type { Tag } from '@rooster/core/schemas';
import { Plus } from 'lucide-react';
import { type ReactNode, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BottomSheet, SheetOption } from '../../ui/bottom-sheet';
import { TextField } from '../../ui/input';
import { TagDot } from './tag-dot';
import { tagOptions } from './tag-options';

export interface TagSheetProps {
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  tags: readonly Tag[];
  /** Tags every target task has (checked). */
  applied: readonly string[];
  onToggle: (tagId: string) => void;
  onCreate: (name: string) => void;
  subject?: ReactNode;
  isStatic?: boolean;
}

/**
 * The phone's tag picker (02 §13.4): the same choices as the desktop picker as 48 px rows,
 * a filter field that also creates ("Create …"), and checks on applied tags. Toggling keeps
 * the sheet open for more.
 */
export function TagSheet({
  isOpen,
  onOpenChange,
  tags,
  applied,
  onToggle,
  onCreate,
  subject,
  isStatic = false,
}: TagSheetProps) {
  const { t } = useTranslation('tags');
  const [query, setQuery] = useState('');
  useEffect(() => {
    if (!isOpen) setQuery('');
  }, [isOpen]);
  const options = useMemo(() => tagOptions(tags, query), [tags, query]);

  return (
    <BottomSheet
      isOpen={isOpen}
      onOpenChange={onOpenChange}
      title={t('picker.list')}
      description={subject}
      isStatic={isStatic}
    >
      <div className="px-2 pb-2">
        <TextField
          label={t('picker.filter')}
          hideLabel
          placeholder={t('picker.filter')}
          value={query}
          onChange={setQuery}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return;
            const first = options[0];
            if (!first) return;
            if (first.kind === 'create') onCreate(first.name);
            else onToggle(first.id);
            setQuery('');
          }}
        />
      </div>
      <div className="flex flex-col" data-testid="tag-sheet">
        {options.length === 0 && (
          <p className="px-3 py-3 text-sm text-text-muted">{t('picker.empty')}</p>
        )}
        {options.map((option) =>
          option.kind === 'create' ? (
            <SheetOption
              key={option.id}
              icon={Plus}
              label={t('picker.create', { name: option.name })}
              onPress={() => {
                onCreate(option.name);
                setQuery('');
              }}
            />
          ) : (
            <SheetOption
              key={option.id}
              leading={
                option.tag ? (
                  <span className="flex size-5 items-center justify-center">
                    <TagDot color={option.tag.color} />
                  </span>
                ) : undefined
              }
              label={option.name}
              checked={applied.includes(option.id)}
              aria-pressed={applied.includes(option.id)}
              onPress={() => onToggle(option.id)}
            />
          ),
        )}
      </div>
    </BottomSheet>
  );
}
