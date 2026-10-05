import {
  type Announcements,
  closestCenter,
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  type Modifier,
  PointerSensor,
  type ScreenReaderInstructions,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from '@dnd-kit/sortable';
import type { Locale } from '@rooster/i18n';
import type { TagColor } from '@rooster/tokens';
import { PanelLeftClose, PanelLeftOpen, Plus, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Popover as AriaPopover, Dialog, DialogTrigger } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { CreateOrgInput, CurrentUser, Org, OrgReorderIntent } from '../../data/types';
import { keymap } from '../../keymap';
import { cn } from '../../lib/cn';
import { IconButton } from '../../ui/icon-button';
import { LogoMark, Wordmark } from '../../ui/logo';
import { overlayOffsetPx, popoverMotion, popoverSurface } from '../../ui/popover';
import { CreateOrgForm } from './create-org-form';
import type { OrgViewId } from './paths';
import { reorderIntent } from './reorder';
import { SidebarItem } from './sidebar-item';
import { type OrgCounts, SidebarOrgSection } from './sidebar-org-section';
import { UserMenu } from './user-menu';

export interface SidebarActive {
  orgId: string;
  view: OrgViewId;
}

export interface SidebarProps {
  user: Pick<CurrentUser, 'id' | 'name' | 'email' | 'image' | 'isAdmin'>;
  /** In the user's sidebar order. */
  orgs: readonly Org[];
  active?: SidebarActive | null | undefined;
  counts?: Partial<Record<string, OrgCounts>> | undefined;
  locale: Locale;
  collapsed: boolean;
  onToggleCollapsed?: (() => void) | undefined;
  onReorder: (intent: OrgReorderIntent) => void;
  onToggleOrgCollapsed: (orgId: string, collapsed: boolean) => void;
  /** Resolve to close the popover; throw to show the error inside it. */
  onCreateOrg: (input: CreateOrgInput) => Promise<void> | void;
  onLocaleChange: (locale: Locale) => void;
  onSignOut: () => void;
  /** Rendered inside the mobile drawer: always expanded, no rail toggle. */
  inDrawer?: boolean;
  className?: string | undefined;
}

/** Drags only move vertically (no @dnd-kit/modifiers dependency for one line). */
const verticalOnly: Modifier = ({ transform }) => ({ ...transform, x: 0 });

/**
 * 02 §2 / 03 §3.10: logo, Search, one section per org (drag to reorder), the
 * "New organisation" entry and the user menu. 248 px wide, or a 56 px icon rail.
 */
export function Sidebar({
  user,
  orgs,
  active,
  counts,
  locale,
  collapsed,
  onToggleCollapsed,
  onReorder,
  onToggleOrgCollapsed,
  onCreateOrg,
  onLocaleChange,
  onSignOut,
  inDrawer = false,
  className,
}: SidebarProps) {
  const { t } = useTranslation('shell');
  const rail = collapsed && !inDrawer;
  const ids = useMemo(() => orgs.map((o) => o.id), [orgs]);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const nameOf = (id: string | number) => orgs.find((o) => o.id === id)?.name ?? '';
  const positionOf = (id: string | number) => ids.indexOf(String(id)) + 1;
  const total = orgs.length;
  // dnd-kit reports "over itself" right after pick-up; only announce real target changes.
  const lastOver = useRef<string | number | null>(null);
  const announcements: Announcements = {
    onDragStart: ({ active: a }) => {
      lastOver.current = a.id;
      return t('dnd.pickedUp', { name: nameOf(a.id), position: positionOf(a.id), total });
    },
    onDragOver: ({ active: a, over }) => {
      if (!over || over.id === lastOver.current) return undefined;
      lastOver.current = over.id;
      return t('dnd.over', { name: nameOf(a.id), position: positionOf(over.id), total });
    },
    onDragEnd: ({ active: a, over }) =>
      over
        ? t('dnd.dropped', { name: nameOf(a.id), position: positionOf(over.id), total })
        : t('dnd.cancelled', { name: nameOf(a.id) }),
    onDragCancel: ({ active: a }) => t('dnd.cancelled', { name: nameOf(a.id) }),
  };
  const instructions: ScreenReaderInstructions = { draggable: t('dnd.instructions') };

  const move = (orgId: string, to: number) => {
    const intent = reorderIntent(ids, ids.indexOf(orgId), to);
    if (intent) onReorder(intent);
  };

  const onDragEnd = ({ active: a, over }: DragEndEvent) => {
    if (!over || a.id === over.id) return;
    move(String(a.id), ids.indexOf(String(over.id)));
  };

  return (
    <nav
      aria-label={t('sidebar.label')}
      className={cn(
        'flex h-full flex-col bg-bg-sidebar',
        rail ? 'w-rail' : 'w-sidebar',
        inDrawer && 'w-full',
        className,
      )}
    >
      <div
        className={cn(
          'flex h-sheet-header shrink-0 items-center',
          rail ? 'justify-center' : 'justify-between ps-5 pe-3',
        )}
      >
        {rail ? <LogoMark /> : <Wordmark />}
        {!rail && onToggleCollapsed && !inDrawer && (
          <IconButton
            icon={PanelLeftClose}
            aria-label={t('sidebar.collapse')}
            shortcut={keymap.toggleSidebar.keys}
            onPress={onToggleCollapsed}
          />
        )}
      </div>

      <div
        className={cn('flex min-h-0 flex-1 flex-col overflow-y-auto pb-4', rail ? 'px-2' : 'px-3')}
      >
        {rail && onToggleCollapsed && (
          <div className="flex justify-center pb-2">
            <IconButton
              icon={PanelLeftOpen}
              aria-label={t('sidebar.expand')}
              shortcut={keymap.toggleSidebar.keys}
              onPress={onToggleCollapsed}
            />
          </div>
        )}
        <SidebarItem
          icon={Search}
          label={t('sidebar.search')}
          shortcut={keymap.search.keys}
          rail={rail}
          isDisabled
        />

        <div className={cn('mt-4 flex flex-col', rail ? 'gap-3' : 'gap-4')}>
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[verticalOnly]}
            onDragEnd={onDragEnd}
            accessibility={{ announcements, screenReaderInstructions: instructions }}
          >
            <SortableContext items={ids} strategy={verticalListSortingStrategy}>
              {orgs.map((org, index) => (
                <SidebarOrgSection
                  key={org.id}
                  org={org}
                  rail={rail}
                  activeView={active?.orgId === org.id ? active.view : null}
                  counts={counts?.[org.id]}
                  canMoveUp={index > 0}
                  canMoveDown={index < orgs.length - 1}
                  onMove={(direction) => move(org.id, direction === 'up' ? index - 1 : index + 1)}
                  onToggleCollapsed={() => onToggleOrgCollapsed(org.id, !org.collapsed)}
                />
              ))}
            </SortableContext>
          </DndContext>
          <CreateOrgEntry
            rail={rail}
            defaultColor={nextColor(orgs.length)}
            onCreateOrg={onCreateOrg}
          />
        </div>
      </div>

      <div className={cn('shrink-0 border-t border-border py-2', rail ? 'px-2' : 'px-3')}>
        <UserMenu
          user={user}
          locale={locale}
          onLocaleChange={onLocaleChange}
          onSignOut={onSignOut}
          rail={rail}
        />
      </div>
    </nav>
  );
}

const roundRobin: readonly TagColor[] = [
  'blue',
  'green',
  'amber',
  'purple',
  'teal',
  'pink',
  'orange',
  'indigo',
  'red',
  'gray',
];

function nextColor(count: number): TagColor {
  return roundRobin[count % roundRobin.length] ?? 'blue';
}

interface CreateOrgEntryProps {
  rail: boolean;
  defaultColor: TagColor;
  onCreateOrg: SidebarProps['onCreateOrg'];
}

/** "+ New organisation" and its anchored popover form. */
function CreateOrgEntry({ rail, defaultColor, onCreateOrg }: CreateOrgEntryProps) {
  const { t } = useTranslation('shell');
  const [open, setOpen] = useState(false);
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <SidebarItem icon={Plus} label={t('sidebar.newOrg')} rail={rail} />
      <AriaPopover
        offset={overlayOffsetPx}
        placement={rail ? 'end top' : 'bottom start'}
        className={cn(popoverSurface, popoverMotion, 'p-0')}
      >
        <Dialog aria-label={t('createOrg.title')} className="outline-none">
          <CreateOrgForm
            defaultColor={defaultColor}
            onCancel={() => setOpen(false)}
            onSubmit={async (input) => {
              await onCreateOrg(input);
              setOpen(false);
            }}
          />
        </Dialog>
      </AriaPopover>
    </DialogTrigger>
  );
}
