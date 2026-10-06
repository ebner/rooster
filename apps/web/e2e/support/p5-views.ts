import type { Page } from '@playwright/test';
import { addDays, todayIn } from '@rooster/core/dates';
import type { Task } from '@rooster/core/schemas';
import { apiCall, signInAs, uniqueEmail } from './auth';
import { createTask, groupId, personalOrg } from './p3';

/** Phase 5 smart-view helpers: a signed-in user with tasks spread over dates and groups. */

export interface ViewsSetup {
  orgId: string;
  today: string;
  groups: Record<'Inbox' | 'Today' | 'Prio' | 'Upcoming', string>;
  tasks: Record<string, Task>;
}

/** The viewer's today in their own zone (what the app shows). */
export async function viewerToday(page: Page): Promise<string> {
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as { timezone: string };
  return todayIn(me.timezone, Date.now());
}

/**
 * Seeds: "Late report" (Prio, 2 days ago), "Water plants" (Today group, today), "Inbox call"
 * (Inbox, today), "Someday idea" (Upcoming, no date), "Dentist" (Prio, today + 3).
 */
export async function setupViews(page: Page, name: string): Promise<ViewsSetup> {
  await signInAs(page, uniqueEmail(name));
  const orgId = await personalOrg(page);
  const today = await viewerToday(page);
  const groups = {
    Inbox: await groupId(page, orgId, 'Inbox'),
    Today: await groupId(page, orgId, 'Today'),
    Prio: await groupId(page, orgId, 'Prio'),
    Upcoming: await groupId(page, orgId, 'Upcoming'),
  };
  const seed: [string, keyof typeof groups, string | null][] = [
    ['Late report', 'Prio', addDays(today, -2)],
    ['Water plants', 'Today', today],
    ['Inbox call', 'Inbox', today],
    ['Someday idea', 'Upcoming', null],
    ['Dentist', 'Prio', addDays(today, 3)],
  ];
  const tasks: Record<string, Task> = {};
  for (const [title, group, dueDate] of seed) {
    tasks[title] = await createTask(page, orgId, {
      title,
      groupId: groups[group],
      ...(dueDate ? { dueDate } : {}),
    });
  }
  return { orgId, today, groups, tasks };
}
