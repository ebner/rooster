import { MutationCache, QueryCache, QueryClient } from '@tanstack/react-query';
import { createRouter } from '@tanstack/react-router';
import { ApiError } from './data/errors';
import { queryKeys } from './data/query-keys';
import { safeRedirectPath } from './lib/safe-redirect';
import { routeTree } from './routeTree.gen';

export interface RouterContext {
  queryClient: QueryClient;
}

/** Pages that work signed out: a 401 there is expected, not a lost session. */
const publicPaths = /^\/(login|not-invited|invite\/)/;

/**
 * A 401 from any request means the session ended (revoked, expired, user disabled):
 * go to the login page and come back afterwards (AC-1.7). `/me` itself is the guard's
 * probe and is handled by the routes.
 */
function onUnauthenticated(error: unknown, isMeQuery = false): void {
  if (!(error instanceof ApiError) || error.status !== 401 || isMeQuery) return;
  const { pathname, href } = router.state.location;
  if (publicPaths.test(pathname)) return;
  queryClient.removeQueries({ queryKey: queryKeys.me });
  const redirect = safeRedirectPath(href);
  void router.navigate({ to: '/login', search: redirect ? { redirect } : {}, replace: true });
}

export const queryClient = new QueryClient({
  queryCache: new QueryCache({
    onError: (error, query) => onUnauthenticated(error, query.queryKey[0] === queryKeys.me[0]),
  }),
  mutationCache: new MutationCache({ onError: (error) => onUnauthenticated(error) }),
  defaultOptions: {
    queries: {
      staleTime: 30_000,
      refetchOnWindowFocus: false,
      // Client errors (401/403/404/409/…) will not change on retry.
      retry: (failures, error) =>
        !(error instanceof ApiError && error.status < 500) && failures < 2,
    },
  },
});

export const router = createRouter({
  routeTree,
  context: { queryClient },
  defaultPreload: 'intent',
  scrollRestoration: true,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
