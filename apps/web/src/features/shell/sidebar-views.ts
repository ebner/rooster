import {
  CalendarOff,
  CalendarRange,
  CircleAlert,
  ListChecks,
  type LucideIcon,
  Sun,
  Users,
} from 'lucide-react';
import type { Org } from '../../data/types';
import type { OrgViewId } from './paths';

export interface SidebarViewDefinition {
  id: OrgViewId;
  icon: LucideIcon;
  /** Only shown for orgs with other members (Everyone's tasks, P6). */
  sharedOnly?: boolean;
  /** The sidebar badge (02 §2): none for Next 7 days and No date. */
  badge?: 'count' | 'danger';
}

/**
 * The views listed under each org, in order (02 §2, icons 03 §2.9). Append entries here as
 * the phases add them; labels come from `shell:view.<id>`.
 */
export const sidebarViews: readonly SidebarViewDefinition[] = [
  { id: 'my', icon: ListChecks, badge: 'count' },
  { id: 'today', icon: Sun, badge: 'count' },
  { id: 'week', icon: CalendarRange },
  { id: 'overdue', icon: CircleAlert, badge: 'danger' },
  { id: 'nodate', icon: CalendarOff },
  { id: 'everyone', icon: Users, sharedOnly: true },
];

export function viewsFor(org: Pick<Org, 'isPersonal'>): readonly SidebarViewDefinition[] {
  return sidebarViews.filter((view) => !view.sharedOnly || !org.isPersonal);
}
