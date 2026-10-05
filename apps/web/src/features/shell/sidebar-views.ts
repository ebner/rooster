import { ListChecks, type LucideIcon } from 'lucide-react';
import type { Org } from '../../data/types';
import type { OrgViewId } from './paths';

export interface SidebarViewDefinition {
  id: OrgViewId;
  icon: LucideIcon;
  /** Only shown for orgs with other members (Everyone's tasks, P6). */
  sharedOnly?: boolean;
}

/**
 * The views listed under each org, in order (02 §2). Append entries here as the
 * phases add them; labels come from `shell:view.<id>`.
 */
export const sidebarViews: readonly SidebarViewDefinition[] = [{ id: 'my', icon: ListChecks }];

export function viewsFor(org: Pick<Org, 'isPersonal'>): readonly SidebarViewDefinition[] {
  return sidebarViews.filter((view) => !view.sharedOnly || !org.isPersonal);
}
