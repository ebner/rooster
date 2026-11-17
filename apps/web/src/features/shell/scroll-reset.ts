import type { AnyRouter } from '@tanstack/react-router';
import { allListViewOf, useLastAllView } from '../all-orgs/last-view';
import { listViewOf, useLastListView } from '../views/last-view';
import type { AllViewId, OrgViewId } from './paths';

export interface ScrollResets {
  /** `<main>` and the list column: another page or list view. */
  page: boolean;
  /** The pane: another task. */
  task: boolean;
}

let reset: ScrollResets = { page: true, task: true };

/** The page a path shows: the pane's path is the list view under it. */
function pageOf(pathname: string, lastView: OrgViewId, lastAllView: AllViewId): string {
  const allView = allListViewOf(pathname, lastAllView);
  if (allView) return `/all/${allView}`;
  const view = listViewOf(pathname, lastView);
  const org = /^\/o\/([^/]+)\//.exec(pathname)?.[1];
  return view && org ? `/o/${org}/${view}` : pathname.replace(/\/+$/, '');
}

function taskOf(pathname: string): string | null {
  return /^\/(?:o\/[^/]+|all)\/t\/([^/]+)/.exec(pathname)?.[1] ?? null;
}

/**
 * What a navigation from `from` to `to` resets, with `lastView` under an org's pane and
 * `lastAllView` under All organisations' pane (`/all/t/:id`, ADR 0073 A).
 */
export function scrollResets(
  from: string,
  to: string,
  lastView: OrgViewId,
  lastAllView: AllViewId = 'today',
): ScrollResets {
  return {
    page: pageOf(from, lastView, lastAllView) !== pageOf(to, lastView, lastAllView),
    task: taskOf(from) !== taskOf(to),
  };
}

/** Decides, before each navigation renders, which of the scrollers below start at the top. */
export function trackScrollResets(router: AnyRouter): void {
  router.subscribe('onBeforeLoad', ({ fromLocation, toLocation }) => {
    if (!fromLocation) return;
    const lastView = useLastListView.getState().view;
    const lastAllView = useLastAllView.getState().view;
    reset = scrollResets(fromLocation.pathname, toLocation.pathname, lastView, lastAllView);
  });
}

/**
 * What a navigation scrolls back to the top (the router's `scrollToTopSelectors`). The app
 * scrolls inside `<main>`, the list column and the pane, not the window, and the router
 * carries an element's offset over to the next page unless it is listed: settings, admin and
 * help pages opened where the previous page was scrolled to. Back and forward still restore
 * each page's own offset.
 *
 * The list stays where it is while the pane opens, follows the cursor and closes over it
 * (`/o/:slug/t/:taskId` and `/all/t/:taskId` are their list view's page); another task starts
 * the pane at its top.
 */
export const scrollToTopSelectors: Array<() => Element | null> = [
  () => (reset.page ? document.querySelector('[data-scroll-main]') : null),
  () => (reset.page ? document.querySelector('[data-list-column]') : null),
  () => (reset.task ? document.querySelector('[data-pane-scroller]') : null),
];
