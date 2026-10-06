import { useSortable } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import {
  ArrowDown,
  ArrowUp,
  ChevronDown,
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
import { type OrgCounts, useOrgCountsHook } from '../views/view-counts';
import { type OrgViewId, orgUrlSlug, paths } from './paths';
import { SidebarItem } from './sidebar-item';
import { type SidebarViewDefinition, viewsFor } from './sidebar-views';

export type { OrgCounts };

export interface SidebarOrgSectionProps {
  org: Org;
  activeView: OrgViewId | null;
  /** Fixed badges (kitchen sink, tests); otherwise live from the org's cached list. */
  counts?: OrgCounts | undefined;
  canMoveUp: boolean;
  canMoveDown: boolean;
  onMove: (direction: 'up' | 'down') => void;
  onToggleCollapsed: () => void;
  rail?: boolean;
  /** Kitchen sink: render the header in a forced state. */
  'data-force'?: string;
}

type MenuAction = 'up' | 'down' | 'collapse';

/**
 * One org in the sidebar (02 §2, 03 §3.10): a header (avatar, name, grip, "⋯") and
 * its views. The whole header is a pointer drag source; keyboard users lift the
 * section with the grip button (Space, arrows, Space) or use Move up/down. The grip
 * sits beside "⋯" (not in the left gutter) so it keeps a 28 px target (WCAG 2.5.8).
 */
export function SidebarOrgSection({
  org,
  activeView,
  counts,
  canMoveUp,
  canMoveDown,
  onMove,
  onToggleCollapsed,
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
  const collapsed = org.collapsed && !rail;
  const useLiveCounts = useOrgCountsHook();
  const live = useLiveCounts(org.id);
  const shown = counts ?? live;
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
        className="flex flex-col items-center gap-0.5"
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
      </section>
    );
  }

  return (
    <section
      ref={setNodeRef}
      style={style}
      aria-label={org.name}
      data-org-id={org.id}
      className={cn(
        'relative flex flex-col gap-0.5 rounded-md',
        isDragging && 'z-(--z-drag) bg-bg-elevated shadow-lg',
      )}
    >
      <div
        // Capture phase: React Aria buttons inside stop pointerdown from bubbling.
        onPointerDownCapture={(event) => {
          dragged.current = false;
          listeners?.onPointerDown?.(event);
        }}
        data-force={force}
        className="group/header relative flex h-control-sm items-center gap-1 pe-0.5"
      >
        <AriaButton
          onPress={() => {
            if (dragged.current) dragged.current = false;
            else onToggleCollapsed();
          }}
          aria-expanded={!collapsed}
          aria-controls={listId}
          className={cn(
            'flex h-control-sm min-w-0 flex-1 cursor-default items-center gap-2 rounded-sm px-2 text-xs font-semibold text-text-muted',
            'transition-colors duration-(--dur-fast) ease-standard hover:text-text-secondary',
            'outline-offset-0 focus-ring:outline-2 focus-ring:outline-border-focus',
          )}
        >
          <span className="flex w-5 shrink-0 justify-center">
            <Avatar
              id={org.id}
              name={org.name}
              emoji={org.avatarEmoji}
              color={org.color}
              shape="square"
              size={16}
              decorative
            />
          </span>
          <span className="min-w-0 truncate">{org.name}</span>
          <ChevronDown
            className={cn(
              'size-3 shrink-0 transition duration-(--dur-fast) ease-standard',
              collapsed ? '-rotate-90 opacity-100' : 'opacity-0 group-hover/header:opacity-100',
            )}
            strokeWidth={iconStrokeWidth}
            aria-hidden
          />
        </AriaButton>
        <button
          type="button"
          ref={setActivatorNodeRef}
          {...attributes}
          onKeyDown={listeners?.onKeyDown as KeyboardEventHandler<HTMLButtonElement> | undefined}
          aria-label={t('org.reorder', { name: org.name })}
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
              onAction={(key) => {
                const action = key as MenuAction;
                if (action === 'collapse') onToggleCollapsed();
                else onMove(action);
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
      <ul id={listId} hidden={collapsed} className="flex flex-col gap-0.5">
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
    </section>
  );
}
