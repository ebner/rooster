import { create } from 'zustand';
import type { OrgViewId } from '../shell/paths';

const listViews: readonly string[] = ['my', 'today', 'week', 'overdue', 'nodate', 'everyone'];

/** Phase 13 (ADR 0073 B): a view of the org (`saved_view`) as a list view, `v:<viewId>`. */
export type SavedViewKey = `v:${string}`;

/** A list view of an org: a built-in one (My tasks, the smart views, Everyone's tasks) or a view. */
export type ListViewKey = OrgViewId | SavedViewKey;

export function savedViewKey(viewId: string): SavedViewKey {
  return `v:${viewId}`;
}

/** The view's ID of a `v:<id>` key; null for a built-in view (or none). */
export function savedViewIdOf(key: ListViewKey | null | undefined): string | null {
  return key?.startsWith('v:') ? key.slice(2) || null : null;
}

/** The built-in view of a key; null for a view of the org (or none). */
export function orgViewOf(key: ListViewKey | null | undefined): OrgViewId | null {
  return key && !key.startsWith('v:') ? (key as OrgViewId) : null;
}

/**
 * The list view a path shows: `/o/:slug/<view>`, or `/o/:slug/v/:viewId` as `v:<viewId>`; null
 * for anything else (the pane, settings, and "+ New view" at `/o/:slug/v/new`, which shows no
 * list yet).
 */
export function viewOfPath(pathname: string): ListViewKey | null {
  const saved = /^\/o\/[^/]+\/v\/([^/]+)\/?$/.exec(pathname)?.[1];
  if (saved) return saved === 'new' ? null : savedViewKey(saved);
  const match = /^\/o\/[^/]+\/([^/]+)\/?$/.exec(pathname);
  const view = match?.[1];
  return view && listViews.includes(view) ? (view as OrgViewId) : null;
}

/** "+ New view": `/o/:slug/v/new` (ADR 0073 B7), a view with no ID yet. */
export function isNewViewPath(pathname: string): boolean {
  return /^\/o\/[^/]+\/v\/new\/?$/.test(pathname);
}

/**
 * The last list view shown (02 §2): `/o/:slug/t/:taskId` opens the pane over it, the sidebar
 * keeps it highlighted, and closing the pane returns to it. A direct load starts on My tasks.
 */
export const useLastListView = create<{ view: ListViewKey }>(() => ({ view: 'my' }));

/** The list view for `pathname`: its own, or the last one under the pane. */
export function listViewOf(pathname: string, last: ListViewKey): ListViewKey | null {
  if (/^\/o\/[^/]+\/t\//.test(pathname)) return last;
  return viewOfPath(pathname);
}
