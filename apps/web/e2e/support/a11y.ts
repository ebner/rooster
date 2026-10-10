import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { Task } from '@rooster/core/schemas';
import { apiCall } from './auth';
import { createTask, groupId, personalOrg } from './p3';
import { expect } from './test';

/**
 * Phase 11 accessibility helpers (WP 11.3, AC-11.3): axe with the WCAG 2.2 AA rule tags, and a
 * seeded list that shows every kind of row decoration.
 */

export const wcagTags = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

/** `id: target | target` per violation, so a failure names the rule and the elements. */
export async function axeViolations(page: Page, include?: string): Promise<string[]> {
  let builder = new AxeBuilder({ page }).withTags(wcagTags);
  if (include) builder = builder.include(include);
  const results = await builder.analyze();
  return results.violations.map(
    (v) =>
      `${v.id}: ${v.nodes.map((n) => `${n.target.join(' ')} ${n.html.slice(0, 160)}`).join(' | ')}`,
  );
}

/**
 * Waits for entry animations (popovers fade and scale in) and two frames: axe reads colours
 * mid-fade as low contrast.
 */
async function settled(page: Page) {
  await page.waitForFunction(() =>
    document
      .getAnimations()
      .every(
        (a) =>
          a.playState !== 'running' ||
          a.effect?.getTiming().iterations === Number.POSITIVE_INFINITY,
      ),
  );
  await page.evaluate(
    () => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))),
  );
}

/**
 * Runs axe on the page as it is, after entry animations settle. Light only: the app has no dark
 * theme (D-22). Soft, so every screen is checked even after one fails and the report lists them
 * all.
 */
export async function expectAxeClean(page: Page, screen: string, include?: string) {
  await settled(page);
  let violations = await axeViolations(page, include);
  // A transition can start after `settled` (a button enabled once its data arrives), and axe
  // reads it mid-way as low contrast. A real violation is still there a moment later.
  for (let attempt = 1; attempt < 3 && violations.length > 0; attempt++) {
    await page.waitForTimeout(500);
    await settled(page);
    violations = await axeViolations(page, include);
  }
  expect.soft(violations, screen).toEqual([]);
}

/** The browser's zone date, as the server sees the e2e user (the default timezone). */
export async function todayOf(page: Page): Promise<string> {
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as { timezone: string };
  return page.evaluate(
    (zone) => new Intl.DateTimeFormat('en-CA', { timeZone: zone }).format(new Date()),
    me.timezone,
  );
}

export function plusDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export interface A11ySeed {
  orgId: string;
  slug: string;
  today: string;
  dentist: Task;
  groups: Record<'Inbox' | 'Today' | 'Prio' | 'Upcoming', string>;
}

/**
 * The personal list with every row decoration (02 §3, 03 §3.1): "Book dentist" due tomorrow with
 * a tag, a description, a weekly repeat, a reminder, 5 subtasks (2 done, expanded), a comment
 * and an attachment; plus overdue, today, this-week, undated and completed tasks.
 */
export async function seedA11yList(page: Page): Promise<A11ySeed> {
  const orgId = await personalOrg(page);
  const slug = /\/o\/([^/]+)\//.exec(page.url())?.[1] ?? '';
  const today = await todayOf(page);
  const groups = {
    Inbox: await groupId(page, orgId, 'Inbox'),
    Today: await groupId(page, orgId, 'Today'),
    Prio: await groupId(page, orgId, 'Prio'),
    Upcoming: await groupId(page, orgId, 'Upcoming'),
  };
  const dentist = await createTask(page, orgId, {
    title: 'Book dentist',
    groupId: groups.Today,
    dueDate: plusDays(today, 1),
    description: 'Ask about the **cleaning** too.\n\n- call before 10\n- bring the card',
    tagNames: ['health'],
    recurrence: 'FREQ=WEEKLY',
    // Absolute and in the future, so the bell shows whatever the time of day.
    reminders: [{ at: Date.now() + 2 * 86_400_000 }],
  });
  const subs: Task[] = [];
  for (let i = 1; i <= 5; i++) {
    subs.push(
      await createTask(page, orgId, { title: `Step ${i}`, parentId: dentist.id, afterId: null }),
    );
  }
  for (const sub of subs.slice(0, 2)) {
    const res = await apiCall(page, 'POST', `/api/v1/tasks/${sub.id}/complete`, {
      completed: true,
    });
    expect(res.status(), await res.text()).toBe(200);
  }
  await apiCall(page, 'PUT', `/api/v1/tasks/${dentist.id}/expanded`);
  const comment = await apiCall(page, 'POST', `/api/v1/tasks/${dentist.id}/comments`, {
    body: 'Called once, **no answer**. Will try again tomorrow.',
  });
  expect(comment.status(), await comment.text()).toBe(201);
  const origin = new URL(page.url()).origin;
  const upload = await page.request.post(`/api/v1/tasks/${dentist.id}/attachments`, {
    headers: { Origin: origin },
    multipart: {
      file: { name: 'referral.txt', mimeType: 'text/plain', buffer: Buffer.from('Referral') },
    },
  });
  expect(upload.status(), await upload.text()).toBe(201);

  await createTask(page, orgId, {
    title: 'Pay the electricity bill',
    groupId: groups.Today,
    dueDate: plusDays(today, -2),
  });
  await createTask(page, orgId, {
    title: 'Call Bob',
    groupId: groups.Today,
    dueDate: today,
    dueTime: '14:00',
    dueTz: ((await (await apiCall(page, 'GET', '/api/v1/me')).json()) as { timezone: string })
      .timezone,
  });
  await createTask(page, orgId, {
    title: 'Plan the team offsite',
    groupId: groups.Prio,
    dueDate: plusDays(today, 4),
    startDate: plusDays(today, 2),
    tagNames: ['work', 'planning'],
  });
  await createTask(page, orgId, { title: 'Read the onboarding notes', groupId: groups.Prio });
  await createTask(page, orgId, { title: 'Water the plants', groupId: groups.Inbox });
  const done = await createTask(page, orgId, {
    title: 'Renew the passport',
    groupId: groups.Upcoming,
    dueDate: plusDays(today, 20),
  });
  await apiCall(page, 'POST', `/api/v1/tasks/${done.id}/complete`, { completed: true });
  return { orgId, slug, today, dentist, groups };
}
