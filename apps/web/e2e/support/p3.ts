import type { Page } from '@playwright/test';
import type { MyList, Tag, Task } from '@rooster/core/schemas';
import { apiCall } from './auth';
import { expect } from './test';

/** Phase 3 helpers: the personal org, API seeding and list reads. */

export async function personalOrg(page: Page): Promise<string> {
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as {
    orgs: { id: string; isPersonal: boolean }[];
  };
  const org = me.orgs.find((o) => o.isPersonal);
  if (!org) throw new Error('no personal org');
  return org.id;
}

export async function myList(page: Page, orgId: string): Promise<MyList> {
  const res = await apiCall(page, 'GET', `/api/v1/orgs/${orgId}/my-list`);
  expect(res.status()).toBe(200);
  return (await res.json()) as MyList;
}

export async function groupId(page: Page, orgId: string, name: string): Promise<string> {
  const group = (await myList(page, orgId)).groups.find((g) => g.name === name);
  if (!group) throw new Error(`no group ${name}`);
  return group.id;
}

export async function createTask(
  page: Page,
  orgId: string,
  body: Record<string, unknown>,
): Promise<Task> {
  const res = await apiCall(page, 'POST', `/api/v1/orgs/${orgId}/tasks`, body);
  expect(res.status(), await res.text()).toBe(201);
  return (await res.json()) as Task;
}

export async function tags(page: Page, orgId: string): Promise<Tag[]> {
  return (await (await apiCall(page, 'GET', `/api/v1/orgs/${orgId}/tags`)).json()) as Tag[];
}

export async function waitForSync(page: Page) {
  await expect(page.getByTestId('sync-state')).toHaveAttribute('data-pending', '0');
}

export const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

/** A click on the row body (02 §3.3: selects and opens the pane), left of the date cell. */
export async function clickRowBody(page: Page, title: string) {
  const row = page.getByTestId('task-row').filter({ hasText: title }).first();
  const box = await row.boundingBox();
  if (!box) throw new Error(`no row ${title}`);
  await row.click({ position: { x: box.width - 140, y: box.height / 2 } });
}
