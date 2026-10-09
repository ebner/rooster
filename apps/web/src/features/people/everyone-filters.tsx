import { SlidersHorizontal } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { create } from 'zustand';
import type { OrgMember } from '../../data/types';
import { cn } from '../../lib/cn';
import { Button } from '../../ui/button';
import { Menu, MenuGroup, MenuItem, MenuPopover, MenuSeparator, MenuTrigger } from '../../ui/menu';
import { announce } from '../list/announcer';
import { type DueFilter, type EveryoneFilters, noEveryoneFilters } from './everyone-model';
import { sortMembers } from './members';

/** The due options of the filter menu (02 §11), in menu order. */
export const dueFilters: readonly DueFilter[] = ['any', 'overdue', 'week', 'nodate'];

/** The member filter's key for Unassigned (menu keys are strings). */
const unassignedKey = 'none';

/** Everyone's filters for the session (like the tag filter): due and the member multi-select. */
export const useEveryoneFilters = create<
  EveryoneFilters & { set: (patch: Partial<EveryoneFilters>) => void; reset: () => void }
>()((set) => ({
  ...noEveryoneFilters,
  set: (patch) => set(patch),
  reset: () => set(noEveryoneFilters),
}));

/** How many filters of the menu are on (the button's badge). */
export function activeFilterCount(filters: EveryoneFilters): number {
  return (filters.due === 'any' ? 0 : 1) + (filters.members.length > 0 ? 1 : 0);
}

/**
 * Everyone's header filter (02 §11): due (any, overdue, next 7 days, no date) and a member
 * multi-select with Unassigned. Tags use the list's tag filter next to it.
 */
export function EveryoneFilterButton({
  members,
  meId,
}: {
  members: readonly OrgMember[];
  meId: string;
}) {
  const { t } = useTranslation('people');
  const filters = useEveryoneFilters();
  const count = activeFilterCount(filters);
  const sorted = sortMembers(members, meId);
  const selectedMembers = filters.members.map((id) => id ?? unassignedKey);
  return (
    <MenuTrigger>
      <Button
        variant="ghost"
        size="sm"
        icon={SlidersHorizontal}
        data-testid="everyone-filter"
        aria-label={t('filter.label')}
        className={cn(count > 0 && 'bg-bg-muted text-text')}
      >
        <span className="max-tablet:sr-only">
          {count > 0 ? t('filter.active', { count }) : t('filter.button')}
        </span>
      </Button>
      <MenuPopover placement="bottom end" className="min-w-date-cell">
        <Menu
          aria-label={t('filter.due')}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[filters.due]}
          onSelectionChange={(keys) => {
            const due = (keys === 'all' ? 'any' : ([...keys][0] ?? 'any')) as DueFilter;
            filters.set({ due });
            announce(t('filter.dueAnnounce', { due: t(`filter.dueOption.${due}`) }));
          }}
        >
          <MenuGroup title={t('filter.due')}>
            {dueFilters.map((due) => (
              <MenuItem key={due} id={due}>
                {t(`filter.dueOption.${due}`)}
              </MenuItem>
            ))}
          </MenuGroup>
        </Menu>
        <MenuSeparator />
        <Menu
          aria-label={t('filter.members')}
          selectionMode="multiple"
          shouldCloseOnSelect={false}
          selectedKeys={selectedMembers}
          onSelectionChange={(keys) => {
            const ids =
              keys === 'all'
                ? [...sorted.map((m) => m.userId), null]
                : [...keys].map((k) => (k === unassignedKey ? null : String(k)));
            filters.set({ members: ids });
            announce(t('filter.membersAnnounce', { count: ids.length }));
          }}
        >
          <MenuGroup title={t('filter.members')}>
            {[
              ...sorted.map((member) => (
                <MenuItem key={member.userId} id={member.userId} textValue={member.name}>
                  <span className="truncate">
                    {member.name}
                    {member.userId === meId && (
                      <span className="ms-1 text-text-muted">{t('picker.you')}</span>
                    )}
                  </span>
                </MenuItem>
              )),
              <MenuItem key={unassignedKey} id={unassignedKey}>
                {t('unassigned')}
              </MenuItem>,
            ]}
          </MenuGroup>
        </Menu>
        {count > 0 && (
          <>
            <MenuSeparator />
            <Menu
              aria-label={t('filter.clear')}
              onAction={() => {
                filters.reset();
                announce(t('filter.cleared'));
              }}
            >
              <MenuItem id="clear">{t('filter.clear')}</MenuItem>
            </Menu>
          </>
        )}
      </MenuPopover>
    </MenuTrigger>
  );
}
