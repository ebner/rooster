import { create } from 'zustand';
import type { OrgViewId } from '../shell/paths';

const listViews: readonly string[] = ['my', 'today', 'week', 'overdue', 'nodate'];

/** The list view a path shows (`/o/:slug/<view>`), or null (the pane, settings, …). */
export function viewOfPath(pathname: string): OrgViewId | null {
  const match = /^\/o\/[^/]+\/([^/]+)\/?$/.exec(pathname);
  const view = match?.[1];
  return view && listViews.includes(view) ? (view as OrgViewId) : null;
}

/**
 * The last list view shown (02 §2): `/o/:slug/t/:taskId` opens the pane over it, the sidebar
 * keeps it highlighted, and closing the pane returns to it. A direct load starts on My tasks.
 */
export const useLastListView = create<{ view: OrgViewId }>(() => ({ view: 'my' }));

/** The list view for `pathname`: its own, or the last one under the pane. */
export function listViewOf(pathname: string, last: OrgViewId): OrgViewId | null {
  if (/^\/o\/[^/]+\/t\//.test(pathname)) return last;
  return viewOfPath(pathname);
}
