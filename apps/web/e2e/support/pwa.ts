import type { Page } from '@playwright/test';
import { apiCall } from './auth';
import { expect } from './test';

/** Phase 4 helpers: service worker state, the sync pill, the cached list. */

/** Resolves once a service worker is active for the page's scope (the shell is precached). */
export async function swActive(page: Page): Promise<void> {
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const registration = await navigator.serviceWorker.getRegistration();
          return registration?.active?.state ?? null;
        }),
      { timeout: 20_000 },
    )
    .toBe('activated');
}

/** Whether the page is controlled by a service worker. */
export function controlled(page: Page): Promise<boolean> {
  return page.evaluate(() => navigator.serviceWorker.controller !== null);
}

export function syncPill(page: Page) {
  return page.getByRole('status', { name: 'Sync status' });
}

/** The outbox length every tab mirrors (`data-pending` on the list). */
export async function waitForPending(page: Page, count: number) {
  await expect(page.getByTestId('sync-state')).toHaveAttribute('data-pending', String(count));
}

export async function orgs(page: Page) {
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as {
    orgs: { id: string; slug: string; name: string; isPersonal: boolean }[];
  };
  return me.orgs;
}

/** The persisted query cache in IndexedDB has a my-list entry for every given org. */
export async function waitForPersistedLists(page: Page, orgIds: string[]) {
  await expect
    .poll(
      () =>
        page.evaluate(async (ids) => {
          const raw = await new Promise<string | undefined>((resolve) => {
            const open = indexedDB.open('keyval-store');
            open.onsuccess = () => {
              const db = open.result;
              if (!db.objectStoreNames.contains('keyval')) return resolve(undefined);
              // One snapshot per account (`cacheStorageKey`): the browser owner's.
              const owner = localStorage.getItem('rooster.cacheOwner');
              if (!owner) return resolve(undefined);
              const get = db
                .transaction('keyval')
                .objectStore('keyval')
                .get(`rooster-cache-v1:${owner}`);
              get.onsuccess = () => resolve(get.result as string | undefined);
              get.onerror = () => resolve(undefined);
            };
            open.onerror = () => resolve(undefined);
          });
          if (!raw) return false;
          // Stored by `createCachePersister`: each query's metadata apart from its data.
          const cache = JSON.parse(raw) as { queries: { q: { queryKey: unknown[] } }[] };
          const lists = new Set(
            cache.queries.filter((x) => x.q.queryKey[0] === 'my-list').map((x) => x.q.queryKey[1]),
          );
          return ids.every((id) => lists.has(id));
        }, orgIds),
      { timeout: 25_000 },
    )
    .toBe(true);
}
