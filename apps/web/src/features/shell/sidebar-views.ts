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
import type { AllViewId, OrgViewId } from './paths';

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

/**
 * The view an org switch lands on (ADR 0063): the same one (Today stays Today) when the other
 * org has it, otherwise My tasks.
 */
export function switchView(view: OrgViewId | null, org: Pick<Org, 'isPersonal'>): OrgViewId {
  return view && viewsFor(org).some((v) => v.id === view) ? view : 'my';
}

const allViewIds: readonly string[] = ['today', 'week', 'overdue'] satisfies AllViewId[];

/** Whether an org view also exists in All organisations (ADR 0073 A1). */
export function isAllViewId(view: string | null): view is AllViewId {
  return view !== null && allViewIds.includes(view);
}

/** All organisations' views (ADR 0073 A1): the per-org entries, so icons and badges match. */
export const allSidebarViews = sidebarViews.filter(
  (view): view is SidebarViewDefinition & { id: AllViewId } => isAllViewId(view.id),
);

/**
 * The All organisations view a switch from an org lands on (ADR 0073 A7): Today, Next 7 days
 * and Overdue stay; My tasks, No date and Everyone's tasks (per org only) land on Today.
 */
export function switchAllView(view: OrgViewId | null): AllViewId {
  return isAllViewId(view) ? view : 'today';
}
