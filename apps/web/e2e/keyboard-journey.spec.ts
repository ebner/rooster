import type { Page } from '@playwright/test';
import { apiCall, uniqueEmail, useIdentity } from './support/auth';
import { mod, myList, personalOrg, waitForSync } from './support/p3';
import { expect, test } from './support/test';

/**
 * WP 11.3, AC-11.3: the core journey with the keyboard only (02 §6, hard rule 8). Signs in,
 * creates a task with a natural-language date, adds a subtask, moves, completes and undoes,
 * searches with the palette and opens the hit, changes a setting and comes back. The pointer
 * is never used, and every step leaves a visible focus indicator (WCAG 2.4.7).
 */

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
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
    .filter({ has: page.locator('[data-focus-target]').getByText(title, { exact: true }) });

/**
 * The focused element shows a focus indicator: an outline or ring on it or on the row or cell
 * that draws it (rows outline themselves around the focused title), or the caret of a text
 * field.
 */
async function expectVisibleFocus(page: Page, step: string) {
  const focus = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el || el === document.body) return { ok: false, what: 'nothing (body)' };
    const what = `${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''} "${(el.textContent ?? '').trim().slice(0, 30)}"`;
    if (
      el.matches('input:not([type=checkbox]):not([type=radio]), textarea, [contenteditable=true]')
    )
      return { ok: true, what };
    const drawn = (node: Element) => {
      const style = getComputedStyle(node);
      const outline = style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0;
      return outline || (style.boxShadow !== 'none' && style.boxShadow !== '');
    };
    let node: Element | null = el;
    for (let depth = 0; node && depth < 4; depth++, node = node.parentElement) {
      if (drawn(node)) return { ok: el.matches(':focus-visible'), what };
    }
    return { ok: false, what: `${what} (no indicator)` };
  });
  expect(focus.ok, `${step}: focus on ${focus.what}`).toBe(true);
}

/** Presses Tab until `done` holds (at most `max` times). */
async function tabUntil(page: Page, done: () => Promise<boolean>, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    if (await done()) return;
  }
  throw new Error('Tab never got there');
}

/** Presses Tab until the focused element's name is `name` (at most `max` times). */
async function tabTo(page: Page, name: string | RegExp, max = 40) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const label = await page.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      return (el?.getAttribute('aria-label') ?? el?.textContent ?? '').trim();
    });
    if (typeof name === 'string' ? label === name : name.test(label)) return;
  }
  throw new Error(`Tab never reached ${name}`);
}

async function chord(page: Page, key: string) {
  await page.keyboard.down('Tab');
  await page.keyboard.press(key);
  await page.keyboard.up('Tab');
}

test('AC-11.3 keyboard only: sign in, create with a date, subtask, move, complete, undo, search, settings', async ({
  page,
}) => {
  test.setTimeout(120_000);
  const email = uniqueEmail('keyboard.only');
  await useIdentity(page.context(), email);

  // Sign in: Tab to the provider button, Enter.
  await page.goto('/login');
  // The provider buttons come with /meta: Tab only once they are there.
  await expect(page.getByRole('button', { name: 'Continue with Dev login' })).toBeVisible();
  await tabTo(page, 'Continue with Dev login');
  await expectVisibleFocus(page, 'sign-in button');
  await page.keyboard.press('Enter');
  await page.waitForURL(/\/o\/[^/]+\/my$/);
  await expect(page.getByRole('treegrid')).toBeVisible();
  const orgId = await personalOrg(page);

  // Create: Q opens a draft in the Inbox; the date phrase becomes the due date and time.
  await page.keyboard.press('q');
  await expect(page.locator('input[data-list-input]')).toBeFocused();
  await expectVisibleFocus(page, 'quick add');
  await page.keyboard.type('Call Bob fri 14:00');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Escape');
  await expect(row(page, 'Call Bob')).toBeVisible();
  // On a Friday, "fri" is next week's Friday, which the row shows as a date ("Oct 23").
  await expect(row(page, 'Call Bob')).toContainText(/Fri|Today|Tomorrow|[A-Z][a-z]{2} \d{1,2}/);
  await expect(row(page, 'Call Bob').locator('[data-focus-target]')).toBeFocused();
  await expectVisibleFocus(page, 'created row');
  await waitForSync(page);
  const created = (await myList(page, orgId)).tasks.find((t) => t.title === 'Call Bob');
  expect(created?.dueTime).toBe('14:00');

  // Subtask: Tab+S, type, Esc back to the subtask row.
  await chord(page, 's');
  await expect(page.locator('input[data-list-input]')).toBeFocused();
  await page.keyboard.type('Find his number');
  await page.keyboard.press('Escape');
  await expect(row(page, 'Find his number')).toBeVisible();
  await expectVisibleFocus(page, 'subtask row');

  // Move the parent: ↑ to it, M, type the group, Enter.
  await page.keyboard.press('ArrowUp');
  await expect(row(page, 'Call Bob').locator('[data-focus-target]')).toBeFocused();
  await page.keyboard.press('m');
  const filter = page.getByRole('combobox', { name: 'Filter groups' });
  await expect(filter).toBeFocused();
  await expectVisibleFocus(page, 'move menu');
  await page.keyboard.type('Prio');
  await page.keyboard.press('Enter');
  await expect(filter).toHaveCount(0);
  await expect(row(page, 'Call Bob').locator('[data-focus-target]')).toBeFocused();
  await expectVisibleFocus(page, 'moved row');
  await waitForSync(page);
  const prio = (await myList(page, orgId)).groups.find((g) => g.name === 'Prio');
  expect(
    (await myList(page, orgId)).tasks.find((t) => t.title === 'Call Bob')?.placement?.groupId,
  ).toBe(prio?.id);

  // Complete, then undo.
  await page.keyboard.press(`${mod}+Enter`);
  await expect(row(page, 'Call Bob')).toHaveAttribute('data-done', 'true');
  await page.keyboard.press(`${mod}+z`);
  await expect(row(page, 'Call Bob')).not.toHaveAttribute('data-done', 'true');
  await expect(row(page, 'Call Bob')).toBeVisible();
  await expectVisibleFocus(page, 'after undo');
  await waitForSync(page);
  expect(
    (await myList(page, orgId)).tasks.find((t) => t.title === 'Call Bob')?.completedAt,
  ).toBeNull();

  // Search with the palette and open the hit: the pane opens on it.
  await page.keyboard.press(`${mod}+k`);
  const input = page.getByTestId('palette').getByRole('combobox');
  await expect(input).toBeFocused();
  await expectVisibleFocus(page, 'palette');
  await page.keyboard.type('find his');
  await expect(page.getByTestId('palette').getByRole('option').first()).toContainText(
    'Find his number',
  );
  await page.keyboard.press('Enter');
  const pane = page.getByTestId('detail-pane');
  await expect(pane).toBeVisible();
  await expect(pane.getByRole('textbox', { name: 'Task name' })).toHaveValue('Find his number');
  await expectVisibleFocus(page, 'palette result opened');
  await page.keyboard.press('Escape');
  await expect(pane).toHaveCount(0);
  await expectVisibleFocus(page, 'pane closed');

  // Settings: G S, then change "Start of week" in Profile with the keyboard.
  await page.keyboard.press('g');
  await page.keyboard.press('s');
  await page.waitForURL(/\/settings/);
  const weekStart = page.getByRole('radiogroup', { name: 'Week starts on' });
  await expect(weekStart).toBeVisible();
  // The week start radios are the ones with the values 0 and 1 (Sunday, Monday).
  await tabUntil(page, () =>
    page.evaluate(
      () =>
        document.activeElement?.matches(
          'input[type=radio][value="0"], input[type=radio][value="1"]',
        ) ?? false,
    ),
  );
  await expectVisibleFocus(page, 'settings radio');
  const weekStartOf = async () =>
    ((await (await apiCall(page, 'GET', '/api/v1/me')).json()) as { weekStart: number }).weekStart;
  const before = await weekStartOf();
  // Arrows move the choice within a radio group (and wrap).
  await page.keyboard.press('ArrowDown');
  await expect(weekStart.getByRole('radio', { checked: true })).toBeFocused();
  await expect.poll(weekStartOf).not.toBe(before);

  // And back to My tasks: G M from anywhere outside a field.
  await page.keyboard.press('Escape');
  await page.keyboard.press('g');
  await page.keyboard.press('m');
  await page.waitForURL(/\/o\/[^/]+\/my$/);
  await expect(row(page, 'Call Bob')).toBeVisible();
});
