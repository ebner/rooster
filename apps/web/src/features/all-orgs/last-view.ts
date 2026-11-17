import { create } from 'zustand';
import type { AllViewId } from '../shell/paths';

const allViews: readonly string[] = ['today', 'week', 'overdue'];

/** True on every All organisations path: `/all/<view>` and the pane over it, `/all/t/<id>`. */
export function isAllPath(pathname: string): boolean {
  return /^\/all(?:\/|$)/.test(pathname);
}

/** The All organisations view a path shows (`/all/<view>`), or null. */
export function allViewOfPath(pathname: string): AllViewId | null {
  const view = /^\/all\/([^/]+)\/?$/.exec(pathname)?.[1];
  return view && allViews.includes(view) ? (view as AllViewId) : null;
}

/**
 * The last All organisations view shown: `/all/t/<id>` opens the pane over it, the sidebar
 * keeps it highlighted, and closing the pane returns to it.
 */
export const useLastAllView = create<{ view: AllViewId }>(() => ({ view: 'today' }));

/** The All view for `pathname`: its own, or the last one under the pane; null off `/all`. */
export function allListViewOf(pathname: string, last: AllViewId): AllViewId | null {
  if (/^\/all\/t\//.test(pathname)) return last;
  return allViewOfPath(pathname);
}
