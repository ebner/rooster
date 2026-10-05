import { Filter } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useTags } from '../../data/tags';
import { cn } from '../../lib/cn';
import { useListStore } from '../../state/list-store';
import { Button } from '../../ui/button';
import { Menu, MenuItem, MenuPopover, MenuSeparator, MenuTrigger } from '../../ui/menu';
import { announce } from '../list/announcer';
import { TagDot } from './tag-dot';

/**
 * FR-TAG-4: the tag filter in the My tasks header. Rows show when they carry any of the
 * chosen tags; group headers stay (02 §2). The filter lasts for the session.
 */
export function TagFilterButton({ orgId }: { orgId: string }) {
  const { t } = useTranslation('tags');
  const tags = useTags(orgId).data ?? [];
  const filter = useListStore((s) => s.tagFilter);
  const active = filter.filter((id) => tags.some((tag) => tag.id === id));
  const set = (ids: string[]) => {
    useListStore.getState().set({ tagFilter: ids });
    const names = tags.filter((tag) => ids.includes(tag.id)).map((tag) => tag.name);
    announce(
      ids.length > 0 ? t('filter.announce', { names: names.join(', ') }) : t('filter.cleared'),
    );
  };
  return (
    <MenuTrigger>
      <Button
        variant="ghost"
        size="sm"
        icon={Filter}
        data-testid="tag-filter"
        aria-label={t('filter.label')}
        className={cn(active.length > 0 && 'bg-bg-muted text-text')}
      >
        <span className="max-tablet:sr-only">
          {active.length > 0 ? t('filter.active', { count: active.length }) : t('filter.button')}
        </span>
      </Button>
      <MenuPopover placement="bottom end" className="min-w-date-cell">
        <Menu
          aria-label={t('filter.label')}
          selectionMode="multiple"
          shouldCloseOnSelect={false}
          selectedKeys={active}
          onSelectionChange={(keys) =>
            set(keys === 'all' ? tags.map((tag) => tag.id) : [...keys].map(String))
          }
          renderEmptyState={() => (
            <p className="px-2 py-1.5 text-sm text-text-muted">{t('filter.empty')}</p>
          )}
        >
          {tags.map((tag) => (
            <MenuItem key={tag.id} id={tag.id} textValue={tag.name}>
              <span className="flex items-center gap-2">
                <TagDot color={tag.color} />
                <span className="truncate">{tag.name}</span>
              </span>
            </MenuItem>
          ))}
        </Menu>
        {active.length > 0 && (
          <>
            <MenuSeparator />
            <Menu aria-label={t('filter.clear')} onAction={() => set([])}>
              <MenuItem id="clear">{t('filter.clear')}</MenuItem>
            </Menu>
          </>
        )}
      </MenuPopover>
    </MenuTrigger>
  );
}
