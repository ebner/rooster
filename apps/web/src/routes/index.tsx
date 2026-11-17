import { createFileRoute, redirect } from '@tanstack/react-router';
import { meQueryOptions } from '../data/me';
import { queryKeys } from '../data/query-keys';
import type { Me } from '../data/types';
import { startPath } from '../features/shell/start-page';

/**
 * `/` (also the PWA's `start_url`) opens the start page (Settings → Behaviour, ADR 0073 A6):
 * All organisations → Today, or the last list view shown in this browser; Personal → My tasks
 * the first time. The cached `/me` (restored before the first render) decides, so a start
 * never waits for the network; only without one (the first sign-in in this browser) is `/me`
 * fetched, which the signed-in layout's guard would do on the target page anyway. A failure
 * goes to the fallback, where that guard sends a signed-out visitor to the login page.
 */
export const Route = createFileRoute('/')({
  beforeLoad: async ({ context }) => {
    const me =
      context.queryClient.getQueryData<Me>(queryKeys.me) ??
      (await context.queryClient.ensureQueryData(meQueryOptions).catch(() => undefined));
    // A remembered view that the cached views show is gone opens its org's My tasks instead.
    const views = (orgId: string) =>
      context.queryClient.getQueryData<readonly { id: string }[]>(queryKeys.views(orgId, false));
    throw redirect({ href: startPath(me, undefined, views), replace: true });
  },
});
