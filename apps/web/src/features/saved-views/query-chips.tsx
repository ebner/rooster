import type { SavedViewQuery, Tag } from '@rooster/core/schemas';
import { CalendarDays, CircleCheck, Hash, Lock, UserRound, Users } from 'lucide-react';
import { type ReactNode, Suspense, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import type { OrgMember } from '../../data/types';
import { cn } from '../../lib/cn';
import { Button } from '../../ui/button';
import { Menu, MenuItem, MenuPopover, MenuSeparator, MenuTrigger } from '../../ui/menu';
import { announce } from '../list/announcer';
import { LazyTagPicker } from '../list/lazy';
import {
  assigneeKind,
  type ViewDue,
  type ViewStatus,
  viewDueFilters,
  viewStatusFilters,
  viewTagsMax,
} from './query';

export interface QueryChipsProps {
  query: SavedViewQuery;
  shared: boolean;
  /** A personal org: no people to filter by, nothing to share. */
  isPersonal: boolean;
  /** The org's tags. */
  tags: readonly Tag[];
  /** The org's members, me first. */
  members: readonly OrgMember[];
  meId: string;
  onQuery: (next: SavedViewQuery) => void;
  onShared: (shared: boolean) => void;
  /** False: the view is shared and someone else's, so "Private" isn't offered (B8). */
  canUnshare?: boolean;
  onCreateTag: (name: string) => void;
  /** Kitchen sink: a static state. */
  'data-force'?: string;
}

/** A chip's look: a small secondary button; filters left at their default read muted. */
function chipClass(set: boolean) {
  return cn('max-w-64 rounded-full', !set && 'text-text-muted');
}

/** The tag names of a query, in its order, as `#name`. */
export function queryTagNames(query: SavedViewQuery, tags: readonly Tag[]): string[] {
  return query.tags.flatMap((id) => {
    const tag = tags.find((t) => t.id === id);
    return tag ? [`#${tag.name}`] : [];
  });
}

/** Labels of the person filter, shared by the chips and the phone sheet. */
export function useAssigneeLabel(members: readonly OrgMember[]) {
  const { t } = useTranslation('views');
  const { t: tPeople } = useTranslation('people');
  return (assignee: SavedViewQuery['assignee']) => {
    switch (assigneeKind({ assignee })) {
      case 'anyone':
        return t('saved.assignee.anyone');
      case 'me':
        return t('saved.assignee.me');
      case 'unassigned':
        return tPeople('unassigned');
      case 'member':
        return members.find((m) => m.userId === assignee)?.name ?? tPeople('unknownMember');
    }
  };
}

/**
 * A view's query as chips (ADR 0073 B7, 02 §10.2): tags (any or all of them), the person, the
 * due date and the status, then Private/Shared. Each opens its picker; a pick saves at once.
 * Every chip is a button in the tab order, its picker a menu or the tag picker (keyboard
 * parity without registry keys of its own).
 */
export function QueryChips({
  query,
  shared,
  isPersonal,
  tags,
  members,
  meId,
  onQuery,
  onShared,
  canUnshare = true,
  onCreateTag,
  'data-force': force,
}: QueryChipsProps) {
  const { t } = useTranslation('views');
  const { t: tPeople } = useTranslation('people');
  const tagButton = useRef<HTMLButtonElement>(null);
  const [tagsOpen, setTagsOpen] = useState(false);
  const assigneeLabel = useAssigneeLabel(members);
  const names = queryTagNames(query, tags);
  const set = (patch: Partial<SavedViewQuery>, message?: string) => {
    onQuery({ ...query, ...patch });
    if (message) announce(message);
  };
  const toggleTag = (id: string) => {
    const has = query.tags.includes(id);
    if (!has && query.tags.length >= viewTagsMax) return;
    set({ tags: has ? query.tags.filter((t) => t !== id) : [...query.tags, id] });
  };

  return (
    // biome-ignore lint/a11y/useSemanticElements: buttons that open pickers, no form to submit.
    <div
      role="group"
      aria-label={t('saved.chips.label')}
      data-testid="view-chips"
      className="flex flex-wrap items-center gap-1.5"
    >
      <Button
        ref={tagButton}
        variant="secondary"
        size="sm"
        icon={Hash}
        data-testid="view-chip-tags"
        aria-label={t('saved.chips.tags', {
          value: names.length > 0 ? names.join(', ') : t('saved.chips.noTags'),
        })}
        className={chipClass(names.length > 0)}
        onPress={() => setTagsOpen(true)}
        {...(force ? { 'data-force': force } : {})}
      >
        <span className="truncate">
          {names.length > 0 ? names.map((n) => n.slice(1)).join(', ') : t('saved.chips.noTags')}
        </span>
      </Button>
      {tagsOpen && tagButton.current && (
        <Suspense fallback={null}>
          <LazyTagPicker
            anchor={tagButton.current}
            tags={tags}
            applied={query.tags}
            label={t('saved.chips.tagsPicker')}
            onToggle={toggleTag}
            onCreate={onCreateTag}
            onClose={() => {
              setTagsOpen(false);
              tagButton.current?.focus();
            }}
          />
        </Suspense>
      )}
      {query.tags.length > 1 && (
        <Button
          variant="secondary"
          size="sm"
          data-testid="view-chip-tag-mode"
          aria-label={t('saved.chips.tagModeLabel', {
            value: t(`saved.tagMode.${query.tagMode}`),
          })}
          className={chipClass(true)}
          onPress={() => {
            const tagMode = query.tagMode === 'any' ? 'all' : 'any';
            set({ tagMode }, t(`saved.tagMode.${tagMode}`));
          }}
        >
          {t(`saved.tagMode.${query.tagMode}`)}
        </Button>
      )}
      {!isPersonal && (
        <ChipMenu
          testId="view-chip-assignee"
          icon={UserRound}
          isSet={query.assignee !== 'anyone'}
          value={assigneeLabel(query.assignee)}
          label={t('saved.chips.assignee', { value: assigneeLabel(query.assignee) })}
          menuLabel={t('saved.chips.assigneeMenu')}
          selected={query.assignee}
          onSelect={(assignee) => set({ assignee }, assigneeLabel(assignee))}
          items={[
            { id: 'anyone', label: t('saved.assignee.anyone') },
            { id: 'me', label: t('saved.assignee.me') },
            { id: 'unassigned', label: tPeople('unassigned') },
            'separator',
            ...members.map((m) => ({
              id: m.userId,
              label: m.name,
              ...(m.userId === meId ? { detail: tPeople('picker.you') } : {}),
            })),
          ]}
        />
      )}
      <ChipMenu
        testId="view-chip-due"
        icon={CalendarDays}
        isSet={query.due !== 'any'}
        value={t(`saved.due.${query.due}`)}
        label={t('saved.chips.due', { value: t(`saved.due.${query.due}`) })}
        menuLabel={t('saved.chips.dueMenu')}
        selected={query.due}
        onSelect={(due) => set({ due: due as ViewDue }, t(`saved.due.${due as ViewDue}`))}
        items={viewDueFilters.map((due) => ({ id: due, label: t(`saved.due.${due}`) }))}
      />
      <ChipMenu
        testId="view-chip-status"
        icon={CircleCheck}
        isSet={query.status !== 'open'}
        value={t(`saved.status.${query.status}`)}
        label={t('saved.chips.status', { value: t(`saved.status.${query.status}`) })}
        menuLabel={t('saved.chips.statusMenu')}
        selected={query.status}
        onSelect={(status) =>
          set({ status: status as ViewStatus }, t(`saved.status.${status as ViewStatus}`))
        }
        items={viewStatusFilters.map((status) => ({
          id: status,
          label: t(`saved.status.${status}`),
        }))}
      />
      {!isPersonal && (
        <>
          <span aria-hidden className="mx-0.5 h-4 w-px bg-border" />
          <ChipMenu
            testId="view-chip-shared"
            icon={shared ? Users : Lock}
            isSet
            value={t(shared ? 'saved.sharing.shared' : 'saved.sharing.private')}
            label={t('saved.chips.sharing', {
              value: t(shared ? 'saved.sharing.shared' : 'saved.sharing.private'),
            })}
            menuLabel={t('saved.chips.sharingMenu')}
            selected={shared ? 'shared' : 'private'}
            onSelect={(id) => {
              onShared(id === 'shared');
              announce(t(id === 'shared' ? 'saved.sharing.shared' : 'saved.sharing.private'));
            }}
            items={[
              {
                id: 'private',
                label: t('saved.sharing.private'),
                icon: Lock,
                ...(shared && !canUnshare
                  ? { disabled: true, detail: t('saved.sharing.creatorOnly') }
                  : {}),
              },
              { id: 'shared', label: t('saved.sharing.shared'), icon: Users },
            ]}
          />
        </>
      )}
    </div>
  );
}

type ChipItem =
  | { id: string; label: string; detail?: string; icon?: typeof Lock; disabled?: boolean }
  | 'separator';

function ChipMenu({
  testId,
  icon,
  isSet,
  value,
  label,
  menuLabel,
  selected,
  onSelect,
  items,
}: {
  testId: string;
  icon: typeof Lock;
  isSet: boolean;
  value: ReactNode;
  label: string;
  menuLabel: string;
  selected: string;
  onSelect: (id: string) => void;
  items: readonly ChipItem[];
}) {
  // Separators split the list into sections of the one single-choice menu.
  const groups: Exclude<ChipItem, 'separator'>[][] = [[]];
  for (const item of items) {
    if (item === 'separator') groups.push([]);
    else groups.at(-1)?.push(item);
  }
  const option = (item: Exclude<ChipItem, 'separator'>) => (
    <MenuItem
      key={item.id}
      id={item.id}
      textValue={item.label}
      {...(item.icon ? { icon: item.icon } : {})}
    >
      <span className="truncate">
        {item.label}
        {item.detail && <span className="ms-1 text-text-muted">{item.detail}</span>}
      </span>
    </MenuItem>
  );
  return (
    <MenuTrigger>
      <Button
        variant="secondary"
        size="sm"
        icon={icon}
        data-testid={testId}
        aria-label={label}
        className={chipClass(isSet)}
      >
        <span className="truncate">{value}</span>
      </Button>
      <MenuPopover placement="bottom start" className="min-w-date-cell">
        <Menu
          aria-label={menuLabel}
          disabledKeys={groups.flat().flatMap((item) => (item.disabled ? [item.id] : []))}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={[selected]}
          onSelectionChange={(keys) => {
            const id = keys === 'all' ? undefined : [...keys][0];
            if (id !== undefined && String(id) !== selected) onSelect(String(id));
          }}
        >
          {groups
            .filter((group) => group.length > 0)
            .flatMap((group, index) => [
              ...(index > 0 ? [<MenuSeparator key={`sep-${index}`} />] : []),
              ...group.map(option),
            ])}
        </Menu>
      </MenuPopover>
    </MenuTrigger>
  );
}
