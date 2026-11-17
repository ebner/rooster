import { findOrg } from '../../data/orgs';
import type { Me } from '../../data/types';
import { safeRedirectPath } from '../../lib/safe-redirect';
import { userStorageKey } from '../../lib/user-storage';
import { hasAllOrgs } from '../all-orgs/default-org';
import { allViewOfPath } from '../all-orgs/last-view';
import { savedViewIdOf, viewOfPath } from '../views/last-view';
import { paths } from './paths';

/** Where `/` goes without a better answer: Personal → My tasks (02 §2). */
export const fallbackStartPath = paths.orgView('personal', 'my');

const storageName = 'lastListPath';

/**
 * A list view's own path: `/o/<slug>/<view>`, `/o/<slug>/v/<id>` (a view, ADR 0073 B) or
 * `/all/<view>`, nothing else (no pane, no unsaved new view).
 */
export function isListPath(pathname: string): boolean {
  return viewOfPath(pathname) !== null || allViewOfPath(pathname) !== null;
}

/**
 * Remembers the list view shown, per user in this browser (ADR 0073 A6: "the last view"). Kept
 * under `userStorageKey`, so sign-out and a user switch sweep it. Blocked storage is ignored.
 */
export function rememberListPath(
  userId: string,
  pathname: string,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  if (!isListPath(pathname)) return;
  try {
    storage?.setItem(userStorageKey(userId, storageName), pathname);
  } catch {
    // Private mode or blocked storage: `/` falls back to My tasks.
  }
}

function storedListPath(userId: string, storage: Storage | undefined): string | null {
  try {
    return storage?.getItem(userStorageKey(userId, storageName)) ?? null;
  } catch {
    return null;
  }
}

/**
 * Forgets the remembered list view when it is `pathname`: a view that turned out to be gone
 * (deleted, archived, private to someone else) is not where `/` should open next time.
 */
export function forgetListPath(
  userId: string,
  pathname: string,
  storage: Storage | undefined = globalThis.localStorage,
): void {
  try {
    if (storedListPath(userId, storage) === pathname) {
      storage?.removeItem(userStorageKey(userId, storageName));
    }
  } catch {
    // Blocked storage: nothing was remembered either.
  }
}

/**
 * An org's live views when they are cached (`['views', orgId, 'live']`, persisted with the
 * offline cache), else undefined: then nothing is known, and a remembered view is opened as is.
 */
export type CachedViews = (orgId: string) => readonly { id: string }[] | undefined;

/**
 * Where `/` opens (Settings → Behaviour, "Open rooster on"; ADR 0073 A6): All organisations →
 * Today when chosen and offered, else the last list view shown in this browser, if it is still
 * a list view of an org the user is in. The stored value is only ever a path this app wrote,
 * but it is read back as untrusted: same-origin and list-shaped, or the fallback.
 *
 * A remembered view (`/o/<slug>/v/<id>`) opens when its org is still the user's, unless the
 * cached views of that org (`views`) show it is gone: then that org's My tasks, the nearest
 * list that surely exists. Unknown (never cached), it opens, and the view screen's own
 * not-found state answers (which also forgets it, `forgetListPath`).
 *
 * `me` is the cached `/me` (restored from the persisted cache before the first render): the
 * redirect never waits for the network, and without it `/` goes to the fallback.
 */
export function startPath(
  me: Pick<Me, 'user' | 'orgs' | 'prefs'> | undefined,
  storage: Storage | undefined = globalThis.localStorage,
  views?: CachedViews,
): string {
  if (!me) return fallbackStartPath;
  const withAll = hasAllOrgs(me);
  if (me.prefs?.startPage === 'all-today' && withAll) return paths.allView('today');
  const stored = safeRedirectPath(storedListPath(me.user.id, storage));
  if (!stored || !isListPath(stored)) return fallbackStartPath;
  if (allViewOfPath(stored)) return withAll ? stored : fallbackStartPath;
  const slug = /^\/o\/([^/]+)\//.exec(stored)?.[1];
  const org = slug ? findOrg(me.orgs, slug) : null;
  if (!slug || !org) return fallbackStartPath;
  const viewId = savedViewIdOf(viewOfPath(stored));
  const known = viewId ? views?.(org.id) : undefined;
  if (known && !known.some((view) => view.id === viewId)) return paths.orgView(slug, 'my');
  return stored;
}
