import type { Browser, Page } from '@playwright/test';
import { apiCall, displayNameOf, newClient, signInAs, uniqueEmail } from './auth';
import { groupId } from './p3';
import { expect } from './test';

/**
 * WP 11.4 (ADR 0052 §8): one org whose owner has 2,000 open tasks in My tasks. The API allows
 * 600 requests per minute per user, so three helpers who join the org create 500 tasks each,
 * assigned to the owner (they land in the owner's Inbox), while the owner creates 500 in their
 * own groups ("Today 0" … "Upcoming 166").
 */

/**
 * Creates `count` tasks through the page's API context (not the app, whose own requests would
 * share the user's budget), 20 at a time; a 429 waits out its Retry-After and tries again.
 */
async function createMany(page: Page, orgId: string, count: number, body: (i: number) => object) {
  const origin = new URL(page.url()).origin;
  const create = async (i: number): Promise<void> => {
    const res = await page.request.post(`/api/v1/orgs/${orgId}/tasks`, {
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      data: body(i),
    });
    if (res.status() === 429) {
      const wait = Number(res.headers()['retry-after'] ?? '5');
      await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
      return create(i);
    }
    expect(res.status(), await res.text()).toBe(201);
  };
  for (let start = 0; start < count; start += 20) {
    await Promise.all(
      Array.from({ length: Math.min(20, count - start) }, (_, i) => create(start + i)),
    );
  }
}

async function joinAndSeed(
  browser: Browser,
  invitePath: string,
  slug: string,
  orgId: string,
  ownerId: string,
  index: number,
) {
  const context = await newClient(browser);
  await context.addInitScript(() => localStorage.setItem('rooster.locale', 'en'));
  const page = await context.newPage();
  const email = uniqueEmail(`perf.helper${'abc'[index]}`);
  await signInAs(page, email, displayNameOf(email), {
    startAt: invitePath,
    button: 'Accept and sign in with Dev login',
    landing: new RegExp(`/o/${slug}/my$`),
  });
  // Off the app, so its refetches (every create is an SSE event) don't eat the budget.
  const origin = new URL(page.url()).origin;
  await page.goto(`${origin}/api/v1/me`).catch(() => undefined);
  await createMany(page, orgId, 500, (i) => ({
    title: `Helper ${index} task ${i}`,
    assigneeId: ownerId,
  }));
  await context.close();
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? Number.POSITIVE_INFINITY;
}

export async function seed2000(
  page: Page,
  browser: Browser,
): Promise<{ id: string; slug: string }> {
  await signInAs(page, uniqueEmail('perf.owner'));
  const created = await apiCall(page, 'POST', '/api/v1/orgs', { name: 'Perf' });
  const org = (await created.json()) as { id: string; slug: string };
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as { id: string };
  const invite = await apiCall(page, 'POST', `/api/v1/orgs/${org.slug}/invites`, {
    role: 'member',
    multiUse: true,
  });
  expect(invite.status(), await invite.text()).toBeLessThan(300);
  const invitePath = new URL(((await invite.json()) as { url: string }).url).pathname;
  const groups = {
    Today: await groupId(page, org.id, 'Today'),
    Prio: await groupId(page, org.id, 'Prio'),
    Upcoming: await groupId(page, org.id, 'Upcoming'),
  };
  await page.goto('/api/v1/me').catch(() => undefined);
  await Promise.all([
    (async () => {
      // The owner's 500, spread over three groups, while the page is off the app.
      const names = Object.keys(groups) as (keyof typeof groups)[];
      await createMany(page, org.id, 500, (i) => {
        const name = names[i % 3] as keyof typeof groups;
        return { title: `${name} ${Math.floor(i / 3)}`, groupId: groups[name] };
      });
    })(),
    ...[0, 1, 2].map((i) => joinAndSeed(browser, invitePath, org.slug, org.id, me.id, i)),
  ]);

  return org;
}
