import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { Task } from '@rooster/core/schemas';
import { apiCall } from './support/auth';
import { createTask, waitForSync } from './support/p3';
import { sharedOrg } from './support/p6-people';
import { expect, test } from './support/test';

/** Phase 6, WP 6.2 (FR-VIEW-2, 02 §11): Everyone's tasks on desktop. */

const shots = process.env.ROOSTER_P6_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  if (shots) await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

const row = (page: Page, title: string) =>
  page
    .getByTestId('task-row')
    .filter({ has: page.locator('[data-focus-target]').getByText(title, { exact: true }) })
    .first();
const section = (page: Page, assignee: string) =>
  page.locator(`[data-testid="member-section"][data-assignee="${assignee}"]`);

async function task(page: Page, id: string): Promise<Task> {
  return (await (await apiCall(page, 'GET', `/api/v1/tasks/${id}`)).json()) as Task;
}

/** The view as text: `# <assignee>` for each section, then its row titles. */
async function outline(page: Page): Promise<string[]> {
  return page
    .locator('[data-list-root] [data-row-id]')
    .evaluateAll((els) =>
      els.flatMap((el) =>
        el.getAttribute('data-testid') === 'member-section'
          ? [`# ${el.getAttribute('data-assignee')}`]
          : el.getAttribute('data-testid') === 'task-row'
            ? [el.querySelector('[data-focus-target]')?.textContent ?? '']
            : [],
      ),
    );
}

test('FR-VIEW-2 sections per person (me first, Unassigned last), rows by due date, filters', async ({
  page,
  browser,
}) => {
  const { a, b, slug, orgId, aId, bId, bName } = await sharedOrg(page, browser, 'ev.sections');
  await createTask(a, orgId, { title: 'Mine, no date' });
  await createTask(a, orgId, { title: 'Mine, soon', dueDate: '2099-01-02' });
  await createTask(a, orgId, { title: 'Mine, sooner', dueDate: '2099-01-01' });
  await createTask(b, orgId, { title: 'Bertil’s', dueDate: '2000-01-01' });
  await createTask(a, orgId, { title: 'Nobody’s', assigneeId: null });

  await a.goto(`/o/${slug}/my`);
  await a
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: /Everyone/ })
    .click();
  await expect(a).toHaveURL(new RegExp(`/o/${slug}/everyone$`));
  await expect(a.getByRole('heading', { level: 1 })).toContainText(/Everyone.s tasks/);
  await expect
    .poll(() => outline(a))
    .toEqual([
      `# ${aId}`,
      'Mine, sooner',
      'Mine, soon',
      'Mine, no date',
      `# ${bId}`,
      'Bertil’s',
      '# none',
      'Nobody’s',
    ]);
  await expect(section(a, bId)).toContainText(bName);
  await expect(row(a, 'Bertil’s').getByTestId('row-assignee')).toHaveAttribute('data-user-id', bId);
  if (shots) {
    await a.screenshot({ path: `${shots}/1440-everyone.png` });
  }

  // Due filter: overdue only; then the member filter: Unassigned only.
  await a.getByTestId('everyone-filter').click();
  await a.getByRole('menuitemradio', { name: 'Overdue' }).click();
  await a.keyboard.press('Escape');
  await expect.poll(() => outline(a)).toEqual([`# ${aId}`, `# ${bId}`, 'Bertil’s', '# none']);
  await a.getByTestId('everyone-filter').click();
  await a.getByRole('menuitemradio', { name: 'Any date' }).click();
  await a.getByTestId('everyone-filter').click();
  await a.getByRole('menuitemcheckbox', { name: 'Unassigned' }).click();
  await a.keyboard.press('Escape');
  await expect.poll(() => outline(a)).toEqual(['# none', 'Nobody’s']);
});

test('02 §11 dragging a row onto another person’s section reassigns it', async ({
  page,
  browser,
}) => {
  const { a, slug, orgId, bId } = await sharedOrg(page, browser, 'ev.drag');
  const moving = await createTask(a, orgId, { title: 'Hand this over' });
  await a.goto(`/o/${slug}/everyone`);
  const source = row(a, 'Hand this over');
  const target = section(a, bId);
  await expect(target).toBeVisible();
  const from = await source.boundingBox();
  const to = await target.boundingBox();
  if (!from || !to) throw new Error('no boxes');
  await a.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await a.mouse.down();
  await a.mouse.move(from.x + from.width / 2, from.y + from.height / 2 + 10, { steps: 4 });
  await a.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 10 });
  await expect(target.locator('[role="gridcell"]').first()).toHaveClass(/bg-bg-accent-subtle/);
  await a.mouse.up();
  await waitForSync(a);
  await expect.poll(async () => (await task(a, moving.id)).assigneeId).toBe(bId);
  await expect(a.getByText(/Assigned to .* · moved to their Inbox/)).toBeVisible();
  await expect
    .poll(() => outline(a))
    .toEqual([expect.stringMatching(/^# /), `# ${bId}`, 'Hand this over', '# none']);
});

test('02 §11 inline add under a person creates the task in their Inbox', async ({
  page,
  browser,
}) => {
  const { a, b, slug, bId, bName } = await sharedOrg(page, browser, 'ev.add');
  await a.goto(`/o/${slug}/everyone`);
  await b.goto(`/o/${slug}/my`);
  await a
    .locator(`[data-row-id="add:section:member:${bId}"]`)
    .getByRole('button', { name: 'Add task' })
    .click();
  await a.keyboard.type('Water the office plants');
  await a.keyboard.press('Enter');
  await a.keyboard.press('Escape');
  await expect(a.getByText(`Added to ${bName}’s Inbox`)).toBeVisible();
  await expect(row(a, 'Water the office plants')).toBeVisible();
  await waitForSync(a);
  await expect(row(b, 'Water the office plants')).toBeVisible();
  await expect(b.getByTestId('task-row').first()).toContainText('Water the office plants');
});

test('02 §11 the A key reassigns in Everyone’s tasks; @name assigns a new task', async ({
  page,
  browser,
}) => {
  const { a, slug, orgId, bId, bName } = await sharedOrg(page, browser, 'ev.keys');
  const loose = await createTask(a, orgId, { title: 'Up for grabs', assigneeId: null });
  await a.goto(`/o/${slug}/everyone`);
  await row(a, 'Up for grabs').locator('[data-focus-target]').focus();
  await a.keyboard.press('a');
  await a.getByTestId('assignee-picker').getByRole('option', { name: bName }).click();
  await waitForSync(a);
  await expect.poll(async () => (await task(a, loose.id)).assigneeId).toBe(bId);

  await a.goto(`/o/${slug}/my`);
  await a.getByRole('button', { name: 'Add task' }).first().click();
  await a.keyboard.type('Review the draft @bert');
  await expect(a.getByTestId('member-suggest')).toBeVisible();
  await a.keyboard.press('Enter');
  await a.keyboard.press('Escape');
  await expect(a.getByText(`Added to ${bName}’s Inbox`)).toBeVisible();
  await expect(row(a, 'Review the draft')).toHaveCount(0);
  await waitForSync(a);
  const created = (await (
    await apiCall(a, 'GET', `/api/v1/orgs/${orgId}/tasks?view=everyone&assignee=${bId}`)
  ).json()) as { items: Task[] };
  expect(created.items.map((t) => t.title)).toContain('Review the draft');
});

test('kitchen sink: assignment and Everyone’s tasks render and are axe-clean', async ({ page }) => {
  await page.goto('/_dev/ui');
  const section = page.getByTestId('section-people');
  await expect(section.locator('#people-title')).toHaveText('Assignment and Everyone’s tasks');
  await expect(section.getByTestId('assignee-picker-preview').getByRole('option')).toHaveCount(5);
  await expect(section.getByTestId('assignee-field')).toHaveCount(3);
  await expect(section.getByTestId('member-section').first()).toBeVisible();
  // Before scrolling: the sticky section headers would overlap rows (axe target-size).
  const results = await new AxeBuilder({ page })
    .include('[data-testid="section-people"]')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  expect(
    results.violations.map(
      (v) => `${v.id}: ${v.nodes.map((n) => `${n.target} ${n.html.slice(0, 200)}`).join(' | ')}`,
    ),
  ).toEqual([]);
  await section.scrollIntoViewIfNeeded();
  if (shots) {
    await section.screenshot({ path: `${shots}/kitchen-sink-people.png` });
  }
});
