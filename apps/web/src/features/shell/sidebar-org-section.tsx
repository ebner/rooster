import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import type { SavedView, SavedViewMove } from '@rooster/core/schemas';
import {
  ArrowDown,
  ArrowUp,
  ChevronsDownUp,
  ChevronsUpDown,
  GripVertical,
  MoreHorizontal,
  Settings,
  UserPlus,
} from 'lucide-react';
import { type KeyboardEventHandler, useId, useRef } from 'react';
import { Button as AriaButton } from 'react-aria-components';
import { useTranslation } from 'react-i18next';
import type { Org } from '../../data/types';
import { cn } from '../../lib/cn';
import { Avatar } from '../../ui/avatar';
import { iconStrokeWidth } from '../../ui/button';
import { IconButton } from '../../ui/icon-button';
import { Menu, MenuItem, MenuPopover, MenuSeparator, MenuTrigger } from '../../ui/menu';
import { type OrgCounts, useOrgCountsHook, useSavedViewsHook } from '../views/view-counts';
import { type OrgViewId, orgUrlSlug, paths } from './paths';
import { SidebarItem } from './sidebar-item';
import { SidebarSavedViews } from './sidebar-saved-views';
import {
  SectionChevron,
  SectionItems,
  sectionDividerClass,
  sectionHeaderButtonClass,
} from './sidebar-section-header';
import { type SidebarViewDefinition, viewsFor } from './sidebar-views';

export type { OrgCounts };

const noViews: readonly SavedView[] = [];

export interface SidebarOrgSectionProps {
  org: Org;
  activeView: OrgViewId | null;
  /** The org's view shown (or under the pane), `'new'` for "+ New view" (ADR 0073 B). */
  activeSavedViewId?: string | null | undefined;
  /** Fixed views (kitchen sink, tests); otherwise live from `['views', orgId]`. */
  savedViews?: readonly SavedView[] | undefined;
  /** With `savedViews`: where a reorder goes. */
  onMoveSavedView?: ((id: string, intent: SavedViewMove) => unknown) | undefined;
  /** Kitchen sink: the first view lifted. */
  forceViewDragging?: boolean;
  /** Fixed badges (kitchen sink, tests); otherwise live from the org's cached list. */
  counts?: OrgCounts | undefined;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: 'up' | 'down') => void;
  /** Whether the section is collapsed (`orgSectionCollapsed`); the rail ignores it. */
  collapsed?: boolean | undefined;
  onToggleCollapsed: () => void;
  /** A hairline above the section: every section but the sidebar's first has one. */
  divider?: boolean;
  rail?: boolean;
  /** Kitchen sink: render the header in a forced state. */
  'data-force'?: string;
}

/**
 * One org in the sidebar (02 §2, 03 §3.10, ADR 0076): a header row (chevron, avatar, name,
 * grip, "⋯") and its views, indented past a guide in the org's colour. The header's toggle
 * opens and collapses the section. The whole header is a pointer drag source; keyboard users
 * lift the section with the grip button (Space, arrows, Space) or use Move up/down. The grip
 * sits beside "⋯" (not in the left gutter) so it keeps a 28 px target (WCAG 2.5.8).
 */
export function SidebarOrgSection({
  org,
  activeView,
  activeSavedViewId = null,
  savedViews,
  onMoveSavedView,
  forceViewDragging = false,
  counts,
  canMoveUp,
  canMoveDown,
  onMove,
  collapsed: collapsedProp,
  onToggleCollapsed,
  divider = false,
  rail = false,
  'data-force': force,
}: SidebarOrgSectionProps) {
  const { t } = useTranslation('shell');
  const listId = useId();
  const slug = orgUrlSlug(org);
  const sortable = useSortable({ id: org.id, disabled: rail });
  const { setNodeRef, setActivatorNodeRef, attributes, listeners, transform, transition } =
    sortable;
  const isDragging = sortable.isDragging;
  // React Aria fires onPress on pointer up even after a drag; swallow that one press.
  const dragged = useRef(false);
  if (isDragging) dragged.current = true;
  const views = viewsFor(org);
  const collapsed = (collapsedProp ?? org.collapsed) && !rail;
  const useLiveCounts = useOrgCountsHook();
  const live = useLiveCounts(org.id);
  const shown = counts ?? live;
  const liveViews = useSavedViewsHook()(org.id);
  const orgViews = savedViews ?? liveViews.views ?? noViews;
  const moveView = onMoveSavedView ?? liveViews.move;
  /** 02 §2 / 03 §3.10: counts only where the view has a badge; Overdue in danger. */
  const badge = (view: SidebarViewDefinition) => ({
    count: view.badge ? shown?.[view.id] : undefined,
    countTone: view.badge === 'danger' ? ('danger' as const) : ('default' as const),
  });

  const style = { transform: CSS.Translate.toString(transform), transition };

  if (rail) {
    return (
      <section
        ref={setNodeRef}
        aria-label={org.name}
        className={cn('flex flex-col items-center gap-0.5', divider && sectionDividerClass)}
      >
        <span className="flex h-control-sm items-center" title={org.name}>
          <Avatar
            id={org.id}
            name={org.name}
            emoji={org.avatarEmoji}
            color={org.color}
            shape="square"
            size={20}
            decorative
          />
        </span>
        {views.map((view) => (
          <SidebarItem
            key={view.id}
            rail
            icon={view.icon}
            label={t(`view.${view.id}`)}
            railHint={org.name}
            href={paths.orgView(slug, view.id)}
            isActive={activeView === view.id}
            {...badge(view)}
          />
        ))}
        <SidebarSavedViews
          rail
          orgName={org.name}
          slug={slug}
          views={orgViews}
          activeViewId={activeSavedViewId}
          onMove={moveView}
        />
      </section>
    );
  }

  return (
    <section
      ref={setNodeRef}
      style={style}
      aria-label={org.name}
      data-org-id={org.id}
      data-collapsed={collapsed ? '' : undefined}
      className={cn(
        'relative flex flex-col gap-1 rounded-md',
        divider && sectionDividerClass,
        // Lifted, the section is a card: its divider stays behind with the column.
        isDragging && 'z-(--z-drag) border-transparent bg-bg-elevated shadow-lg',
      )}
    >
      <div
        // Capture phase: React Aria buttons inside stop pointerdown from bubbling.
        onPointerDownCapture={(event) => {
          dragged.current = false;
          listeners?.onPointerDown?.(event);
        }}
        data-force={force}
        className="group/header relative flex h-control items-center gap-0.5 pe-0.5 pointer-coarse:h-hit-touch"
      >
        <AriaButton
          onPress={() => {
            if (dragged.current) dragged.current = false;
            else onToggleCollapsed();
          }}
          aria-expanded={!collapsed}
          aria-controls={listId}
          className={sectionHeaderButtonClass}
        >
          <SectionChevron collapsed={collapsed} />
          <Avatar
            id={org.id}
            name={org.name}
            emoji={org.avatarEmoji}
            color={org.color}
            shape="square"
            size={24}
            decorative
          />
          <span className="ms-1 min-w-0 truncate">{org.name}</span>
        </AriaButton>
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          onKeyDown={listeners?.onKeyDown as KeyboardEventHandler<HTMLButtonElement> | undefined}
          aria-label={t('org.reorder', { name: org.name })}
          // While lifted, the keys belong to the drag, not to the list's navigate keys.
          data-overlay={isDragging ? '' : undefined}
          className={cn(
            'flex size-control-sm shrink-0 cursor-grab items-center justify-center rounded-sm text-icon-subtle hover:bg-bg-muted',
            'opacity-0 transition-opacity duration-(--dur-fade) group-hover/header:opacity-100 focus-ring:opacity-100',
            'outline-offset-0 focus-ring:outline-2 focus-ring:outline-border-focus',
            'pointer-coarse:hidden',
            isDragging && 'cursor-grabbing opacity-100',
          )}
        >
          <GripVertical className="size-4" strokeWidth={iconStrokeWidth} aria-hidden />
        </button>
        <MenuTrigger>
          <IconButton
            icon={MoreHorizontal}
            size="sm"
            aria-label={t('org.menu', { name: org.name })}
            className={cn(
              'opacity-0 transition-opacity duration-(--dur-fade) group-hover/header:opacity-100',
              'focus-ring:opacity-100 aria-expanded:opacity-100 pointer-coarse:opacity-100',
            )}
          />
          <MenuPopover placement="bottom end">
            <Menu
              aria-label={t('org.menu', { name: org.name })}
              disabledKeys={[...(canMoveUp ? [] : ['up']), ...(canMoveDown ? [] : ['down'])]}
              // Link items (settings, invite) fire onAction too: match the keys explicitly.
              onAction={(key) => {
                if (key === 'collapse') onToggleCollapsed();
                else if (key === 'up' || key === 'down') onMove(key);
              }}
            >
              <MenuItem id="settings" icon={Settings} href={paths.orgSettings(slug)}>
                {t('org.settings')}
              </MenuItem>
              {!org.isPersonal && org.role === 'owner' && (
                <MenuItem id="invite" icon={UserPlus} href={paths.orgInvites(slug)}>
                  {t('org.invite')}
                </MenuItem>
              )}
              <MenuSeparator />
              <MenuItem id="up" icon={ArrowUp}>
                {t('org.moveUp')}
              </MenuItem>
              <MenuItem id="down" icon={ArrowDown}>
                {t('org.moveDown')}
              </MenuItem>
              <MenuItem id="collapse" icon={collapsed ? ChevronsUpDown : ChevronsDownUp}>
                {collapsed ? t('org.expand') : t('org.collapse')}
              </MenuItem>
            </Menu>
          </MenuPopover>
        </MenuTrigger>
      </div>
      <SectionItems id={listId} hidden={collapsed}>
        <ul className="flex flex-col gap-0.5">
          {views.map((view) => (
            <li key={view.id}>
              <SidebarItem
                icon={view.icon}
                label={t(`view.${view.id}`)}
                href={paths.orgView(slug, view.id)}
                isActive={activeView === view.id}
                {...badge(view)}
              />
            </li>
          ))}
        </ul>
        {/* A drag context of its own: a view moves among the org's views, never between orgs. */}
        <SidebarSavedViews
          orgName={org.name}
          slug={slug}
          views={orgViews}
          activeViewId={activeSavedViewId}
          onMove={moveView}
          forceDragging={forceViewDragging}
        />
      </SectionItems>
    </section>
  );
}
