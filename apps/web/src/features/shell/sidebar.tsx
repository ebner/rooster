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
import type { SavedView, SavedViewMove } from '@rooster/core/schemas';
import type { Locale } from '@rooster/i18n/core';
import type { TagColor } from '@rooster/tokens';
import { Bell, PanelLeftClose, PanelLeftOpen, Plus, Search } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Popover as AriaPopover, Dialog, DialogTrigger } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { CreateOrgInput, CurrentUser, Org, OrgReorderIntent } from '../../data/types';
import { primaryKeys } from '../../keymap';
import { cn } from '../../lib/cn';
import { IconButton } from '../../ui/icon-button';
import { Logo, LogoMark } from '../../ui/logo';
import { overlayOffsetPx, popoverMotion, popoverSurface } from '../../ui/popover';
import { hasAllOrgs } from '../all-orgs/default-org';
import { useInboxNav } from '../collab/inbox-nav';
import { openPalette } from '../palette/store';
import type { AllCounts } from '../views/view-counts';
import { CreateOrgForm } from './create-org-form';
import { type AllViewId, type OrgViewId, paths } from './paths';
import { reorderIntent } from './reorder';
import { SidebarAllSection } from './sidebar-all-section';
import { SidebarItem } from './sidebar-item';
import { type OrgCounts, SidebarOrgSection } from './sidebar-org-section';
import { sectionDividerClass } from './sidebar-section-header';
import {
  allOrgsSectionId,
  allSectionCollapsed,
  orgSectionCollapsed,
  setSectionState,
  useSectionStates,
} from './sidebar-sections';
import { UserMenu } from './user-menu';

export interface SidebarActive {
  orgId: string;
  /** A built-in view, or null when a view of the org (ADR 0073 B) is shown. */
  view: OrgViewId | null;
  /** The org's view shown (or under the pane), `'new'` for "+ New view". */
  savedViewId?: string | null | undefined;
}

export interface SidebarProps {
  user: Pick<CurrentUser, 'id' | 'name' | 'email' | 'image' | 'isAdmin'>;
  /** In the user's sidebar order. */
  orgs: readonly Org[];
  active?: SidebarActive | null | undefined;
  /**
   * The org in the URL, also off its lists (settings, the pane): its section opens unless the
   * user collapsed it (ADR 0076). Defaults to `active`'s org.
   */
  activeOrgId?: string | null | undefined;
  counts?: Partial<Record<string, OrgCounts>> | undefined;
  /** Fixed views per org ID (kitchen sink, tests); otherwise live per org. */
  savedViews?: Partial<Record<string, readonly SavedView[]>> | undefined;
  /** With `savedViews`: where a view reorder goes. */
  onMoveSavedView?: ((id: string, intent: SavedViewMove) => unknown) | undefined;
  /** The All organisations view shown (or under the pane), else null (ADR 0073 A). */
  activeAllView?: AllViewId | null | undefined;
  /** Fixed All organisations badges (kitchen sink, tests); otherwise live. */
  allCounts?: AllCounts | undefined;
  locale: Locale;
  collapsed: boolean;
  onToggleCollapsed?: (() => void) | undefined;
  onReorder: (intent: OrgReorderIntent) => void;
  /** An explicit collapse or expand, for the server pref (`PATCH /me/orgs/:id`). */
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
 * 02 §2 / 03 §3.10: logo, Search, Inbox, All organisations (with two orgs or more), one
 * section per org (drag to reorder), the "New organisation" entry and the user menu. 248 px
 * wide, or a 56 px icon rail. Hairlines part the sections; from three orgs on, those not in
 * the URL start collapsed (ADR 0076).
 */
export function Sidebar({
  user,
  orgs,
  active,
  activeOrgId = active?.orgId ?? null,
  counts,
  savedViews,
  onMoveSavedView,
  activeAllView = null,
  allCounts,
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

  const explicit = useSectionStates(user.id);
  const isCollapsed = (org: Org) =>
    orgSectionCollapsed({
      stored: explicit(org.id),
      serverCollapsed: org.collapsed,
      active: org.id === activeOrgId,
      orgCount: orgs.length,
    });
  const toggleOrg = (org: Org) => {
    const next = !isCollapsed(org);
    setSectionState(user.id, org.id, next ? 'closed' : 'open');
    onToggleOrgCollapsed(org.id, next);
  };
  const allCollapsed = allSectionCollapsed(explicit(allOrgsSectionId));
  const withAll = hasAllOrgs({ orgs: [...orgs] });

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
        {rail ? <LogoMark size={32} label={t('app.name', { ns: 'common' })} /> : <Logo size={32} />}
        {!rail && onToggleCollapsed && !inDrawer && (
          <IconButton
            icon={PanelLeftClose}
            aria-label={t('sidebar.collapse')}
            shortcut={primaryKeys('toggleSidebar')}
            onPress={onToggleCollapsed}
          />
        )}
      </div>

      {/*
       * The rows keep their height once the sections outgrow the sidebar (`*:shrink-0`): the
       * column scrolls instead of squeezing Search and Inbox below their target size.
       */}
      <div
        className={cn(
          'flex min-h-0 flex-1 flex-col overflow-y-auto pb-4 *:shrink-0',
          rail ? 'px-2' : 'px-3',
        )}
      >
        {rail && onToggleCollapsed && (
          <div className="flex justify-center pb-2">
            <IconButton
              icon={PanelLeftOpen}
              aria-label={t('sidebar.expand')}
              shortcut={primaryKeys('toggleSidebar')}
              onPress={onToggleCollapsed}
            />
          </div>
        )}
        <SidebarItem
          icon={Search}
          label={t('sidebar.search')}
          shortcut={primaryKeys('search')}
          rail={rail}
          onPress={(event) => openPalette({ returnFocus: event.pointerType === 'keyboard' })}
        />
        <InboxEntry rail={rail} />

        {/* Each section brings its own room above its header (`pt-3`), the first one too. */}
        <div className="mt-3 flex flex-col gap-3 *:pt-3">
          {/* From the second org on: with one org it would repeat that org's views. */}
          {withAll && (
            <SidebarAllSection
              activeView={activeAllView}
              counts={allCounts}
              rail={rail}
              collapsed={allCollapsed}
              onToggleCollapsed={() =>
                setSectionState(user.id, allOrgsSectionId, allCollapsed ? 'open' : 'closed')
              }
            />
          )}
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
                  activeSavedViewId={active?.orgId === org.id ? active.savedViewId : null}
                  savedViews={savedViews?.[org.id]}
                  onMoveSavedView={onMoveSavedView}
                  counts={counts?.[org.id]}
                  canMoveUp={index > 0}
                  canMoveDown={index < orgs.length - 1}
                  onMove={(direction) => move(org.id, direction === 'up' ? index - 1 : index + 1)}
                  collapsed={isCollapsed(org)}
                  onToggleCollapsed={() => toggleOrg(org)}
                  divider={withAll || index > 0}
                />
              ))}
            </SortableContext>
          </DndContext>
          <div className={sectionDividerClass}>
            <CreateOrgEntry
              rail={rail}
              defaultColor={nextColor(orgs.length)}
              onCreateOrg={onCreateOrg}
            />
          </div>
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

/** 02 §2: the Inbox under Search, with the unread count (a dot in the rail). */
function InboxEntry({ rail }: { rail: boolean }) {
  const { t } = useTranslation('shell');
  const { unread, active } = useInboxNav();
  return (
    <SidebarItem
      icon={Bell}
      label={t('sidebar.inbox')}
      href={paths.inbox}
      count={unread}
      countLabel={unread ? t('sidebar.unread', { count: unread }) : undefined}
      isActive={active}
      rail={rail}
      data-testid="sidebar-inbox"
    />
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

export function nextColor(count: number): TagColor {
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
