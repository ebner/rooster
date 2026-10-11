import type { AnyRouter } from '@tanstack/react-router';
import { listViewOf, useLastListView } from '../views/last-view';
import type { OrgViewId } from './paths';

export interface ScrollResets {
  /** `<main>` and the list column: another page or list view. */
  page: boolean;
  /** The pane: another task. */
  task: boolean;
}

let reset: ScrollResets = { page: true, task: true };

/** The page a path shows: the pane's path is the list view under it. */
function pageOf(pathname: string, lastView: OrgViewId): string {
  const view = listViewOf(pathname, lastView);
  const org = /^\/o\/([^/]+)\//.exec(pathname)?.[1];
  return view && org ? `/o/${org}/${view}` : pathname.replace(/\/+$/, '');
}

function taskOf(pathname: string): string | null {
  return /^\/o\/[^/]+\/t\/([^/]+)/.exec(pathname)?.[1] ?? null;
}

/** What a navigation from `from` to `to` resets, with `lastView` under the pane. */
export function scrollResets(from: string, to: string, lastView: OrgViewId): ScrollResets {
  return {
    page: pageOf(from, lastView) !== pageOf(to, lastView),
    task: taskOf(from) !== taskOf(to),
  };
}

/** Decides, before each navigation renders, which of the scrollers below start at the top. */
export function trackScrollResets(router: AnyRouter): void {
  router.subscribe('onBeforeLoad', ({ fromLocation, toLocation }) => {
    if (!fromLocation) return;
    const lastView = useLastListView.getState().view;
    reset = scrollResets(fromLocation.pathname, toLocation.pathname, lastView);
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
 * (`/o/:slug/t/:taskId` is its list view's page); another task starts the pane at its top.
 */
export const scrollToTopSelectors: Array<() => Element | null> = [
  () => (reset.page ? document.querySelector('[data-scroll-main]') : null),
  () => (reset.page ? document.querySelector('[data-list-column]') : null),
  () => (reset.task ? document.querySelector('[data-pane-scroller]') : null),
];
