import type { Page } from '@playwright/test';
import { addDays, todayIn } from '@rooster/core/dates';
import { expectAxeClean } from './support/a11y';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { createTask, groupId, myList, personalOrg, waitForSync } from './support/p3';
import { expect, reload, test } from './support/test';
import { longPress, pressAndSlide, showKeyboard, swipe, swipeAndHold } from './support/touch';

/**
 * Phase 4 phone layout and gestures (WP 4.5–4.6, AC-4.5) on the iPhone 15 (WebKit) and
 * Pixel 8 (Chromium) profiles: swipes, long-press drag and selection mode, the FAB with the
 * accessory bar, the detail sheet with history, the org switcher, 16 px inputs and axe.
 */
const shots = process.env.ROOSTER_P4_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

/** Axe on the whole page, re-checked once a sheet's or popover's transition has had time to end. */
async function expectNoAxeViolations(page: Page) {
  await expectAxeClean(page, page.url());
}

/** Signs in and seeds `titles` at the top of Today, in order. */
async function setup(page: Page, name: string, titles: string[]) {
  await signInAs(page, uniqueEmail(name));
  const orgId = await personalOrg(page);
  const today = await groupId(page, orgId, 'Today');
  let afterId: string | null = null;
  const ids: string[] = [];
  for (const title of titles) {
    const task = await createTask(page, orgId, { title, groupId: today, afterId, beforeId: null });
    ids.push(task.id);
    afterId = task.id;
  }
  await reload(page);
  await expect(page.getByTestId('task-row').first()).toBeVisible({ timeout: 15_000 });
  return { orgId, today, ids };
}

const row = (page: Page, title: string) =>
  page.getByTestId('task-row').filter({ hasText: title }).first();

test('the phone frame: header, view switcher, bottom nav and FAB, axe-clean', async ({ page }) => {
  await setup(page, 'phone.frame', ['Reply to Anna', 'Book dentist']);
  await expect(page.getByTestId('mobile-header')).toBeVisible();
  await expect(page.getByTestId('org-switcher')).toContainText('Personal');
  await expect(page.getByRole('navigation', { name: 'Views' })).toBeVisible();
  const nav = page.getByRole('navigation', { name: 'Primary' });
  await expect(nav.getByRole('link', { name: 'My tasks' })).toHaveAttribute('aria-current', 'page');
  await expect(nav.getByRole('link', { name: 'Settings' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'New task' })).toBeVisible();
  // 02 §13.2: 52 px rows, a 44 × 44 checkbox.
  const box = await row(page, 'Book dentist').boundingBox();
  expect(Math.round(box?.height ?? 0)).toBe(52);
  const check = await row(page, 'Book dentist').locator('label').first().boundingBox();
  expect(Math.round(check?.width ?? 0)).toBeGreaterThanOrEqual(44);
  await expectNoAxeViolations(page);
});

test('AC-4.5 swipe right completes the task', async ({ page }) => {
  const { orgId, ids } = await setup(page, 'swipe.right', ['Swipe me done', 'Stay put']);
  await swipe(page, row(page, 'Swipe me done'), 0.6);
  await expect(page.getByText('Completed “Swipe me done”').first()).toBeAttached();
  await expect(row(page, 'Swipe me done')).toHaveCount(0);
  await waitForSync(page);
  const list = await myList(page, orgId);
  expect(list.tasks.find((t) => t.id === ids[0])?.completedAt).not.toBeNull();
  expect(list.tasks.find((t) => t.id === ids[1])?.completedAt).toBeNull();
});

test('the swipe reveal sits exactly behind the swiped row', async ({ page }) => {
  await setup(page, 'swipe.reveal', ['First row', 'Second row', 'Third row']);
  const target = row(page, 'Third row');
  const release = await swipeAndHold(page, target, 0.2);
  const reveal = page.locator('[data-swipe-reveal]');
  await expect(reveal).toBeVisible();
  const [revealBox, rowBox] = [await reveal.boundingBox(), await target.boundingBox()];
  expect(Math.abs((revealBox?.y ?? 0) - (rowBox?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((revealBox?.height ?? 0) - (rowBox?.height ?? 0))).toBeLessThanOrEqual(1);
  await release();
  await expect(reveal).toHaveCount(0);
});

test('AC-4.5 a short swipe springs back without acting', async ({ page }) => {
  const { orgId, ids } = await setup(page, 'swipe.short', ['Barely moved']);
  await swipe(page, row(page, 'Barely moved'), 0.15, 20);
  await page.waitForTimeout(400);
  await expect(row(page, 'Barely moved')).toBeVisible();
  const list = await myList(page, orgId);
  expect(list.tasks.find((t) => t.id === ids[0])?.completedAt).toBeNull();
});

test('AC-4.5 swipe left opens the quick date sheet', async ({ page }) => {
  const { orgId, ids } = await setup(page, 'swipe.left', ['Date me']);
  await swipe(page, row(page, 'Date me'), -0.6);
  const sheet = page.getByRole('dialog', { name: 'Due date' });
  await expect(sheet).toBeVisible();
  for (const label of ['Today', 'Tomorrow', 'Weekend', 'Next week', 'Pick date…', 'No date']) {
    await expect(sheet.getByRole('button', { name: new RegExp(`^${label}`) })).toBeVisible();
  }
  if (shots) await page.waitForTimeout(400);
  if (shots) await page.screenshot({ path: `${shots}/390-date-sheet.png` });
  await expectNoAxeViolations(page);
  await sheet.getByRole('button', { name: /^Tomorrow/ }).click();
  await expect(sheet).toHaveCount(0);
  await waitForSync(page);
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as { timezone: string };
  const list = await myList(page, orgId);
  expect(list.tasks.find((t) => t.id === ids[0])?.dueDate).toBe(
    addDays(todayIn(me.timezone, Date.now()), 1),
  );
});

test('AC-4.5 long-press drag reorders', async ({ page }) => {
  const { orgId, today, ids } = await setup(page, 'long.drag', ['First', 'Second', 'Third']);
  const target = await row(page, 'Third').boundingBox();
  if (!target) throw new Error('no target');
  await longPress(page, row(page, 'First'), {
    x: target.x + target.width / 2 - 40,
    y: target.y + target.height * 0.8,
  });
  await expect
    .poll(async () => {
      const list = await myList(page, orgId);
      return list.tasks
        .filter((t) => t.placement?.groupId === today)
        .sort((a, b) => ((a.placement?.position ?? '') < (b.placement?.position ?? '') ? -1 : 1))
        .map((t) => t.id);
    })
    .toEqual([ids[1], ids[2], ids[0]]);
});

test('AC-4.5 long-press without moving enters selection mode; bulk complete', async ({ page }) => {
  const { orgId, ids } = await setup(page, 'select.mode', ['Pick one', 'Pick two', 'Leave me']);
  await longPress(page, row(page, 'Pick one'));
  const header = page.getByTestId('selection-header');
  await expect(header).toContainText('1 selected');
  // The bulk bar replaces the bottom nav.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  await row(page, 'Pick two').click();
  await expect(header).toContainText('2 selected');
  await expect(page.getByTestId('detail-pane')).toHaveCount(0);
  if (shots) await page.waitForTimeout(400);
  if (shots) await page.screenshot({ path: `${shots}/390-selection.png` });
  await expectNoAxeViolations(page);
  const bar = page.getByRole('toolbar', { name: /Bulk actions/ });
  await bar.getByRole('button', { name: 'Complete' }).click();
  await expect(header).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Primary' })).toBeVisible();
  await waitForSync(page);
  const list = await myList(page, orgId);
  const done = (id: string | undefined) => list.tasks.find((t) => t.id === id)?.completedAt;
  expect(done(ids[0])).not.toBeNull();
  expect(done(ids[1])).not.toBeNull();
  expect(done(ids[2])).toBeNull();
});

test('AC-4.5 the FAB creates tasks with the accessory bar above the keyboard', async ({ page }) => {
  const { orgId } = await setup(page, 'fab.create', ['Already here']);
  await page.getByRole('button', { name: 'New task' }).tap();
  const input = page.locator('[data-list-input]');
  await expect(input).toBeFocused();
  const bar = page.getByTestId('accessory-bar');
  await expect(bar).toBeVisible();
  // The FAB and the bottom nav make way for the keyboard.
  await expect(page.getByRole('navigation', { name: 'Primary' })).toHaveCount(0);
  // 02 §13.3: the bar rides on the keyboard (visualViewport).
  await showKeyboard(page, 300);
  await expect
    .poll(async () => {
      const box = await bar.boundingBox();
      const inner = await page.evaluate(() => window.innerHeight);
      return Math.round(inner - ((box?.y ?? 0) + (box?.height ?? 0)));
    })
    .toBe(300);
  // No iOS focus zoom: inputs are at least 16 px.
  expect(
    await input.evaluate((el) => Number.parseFloat(getComputedStyle(el).fontSize)),
  ).toBeGreaterThanOrEqual(16);
  await input.fill('Buy milk');
  if (shots) await page.waitForTimeout(400);
  if (shots) await page.screenshot({ path: `${shots}/390-fab-create.png` });
  await bar.getByRole('button', { name: 'Next' }).click();
  // "Next" creates the task and opens another draft; the keyboard stays.
  await expect(row(page, 'Buy milk')).toBeVisible();
  await expect(page.locator('[data-list-input]')).toBeFocused();
  await expect(page.locator('[data-list-input]')).toHaveValue('');
  // Date from the bar: the sheet, then back to typing.
  await bar.getByRole('button', { name: 'Date' }).click();
  await page
    .getByRole('dialog', { name: 'Due date' })
    .getByRole('button', { name: /^Today/ })
    .click();
  await expect(bar.getByRole('button', { name: 'Today', exact: true })).toBeVisible();
  await expect(page.locator('[data-list-input]')).toBeFocused();
  await page.locator('[data-list-input]').fill('Call the bank');
  await bar.getByRole('button', { name: 'Next' }).click();
  await expect(row(page, 'Call the bank')).toBeVisible();
  await waitForSync(page);
  const list = await myList(page, orgId);
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as { timezone: string };
  expect(list.tasks.find((t) => t.title === 'Buy milk')).toBeTruthy();
  expect(list.tasks.find((t) => t.title === 'Call the bank')?.dueDate).toBe(
    todayIn(me.timezone, Date.now()),
  );
});

test('a new row is scrolled to the top of the list, clear of the keyboard', async ({ page }) => {
  await setup(
    page,
    'draft.top',
    Array.from({ length: 14 }, (_, i) => `Task ${i + 1}`),
  );
  const keyboard = 300;
  /** The draft sits right under its sticky group header and above the keyboard. */
  const expectDraftAtTop = async () => {
    const draft = page.locator('[data-draft]');
    await expect(page.locator('[data-list-input]')).toBeFocused();
    await expect
      .poll(async () => {
        const header = await page.getByTestId('group-header').last().boundingBox();
        const box = await draft.boundingBox();
        const inner = await page.evaluate(() => window.innerHeight);
        if (!header || !box) return 'missing';
        return [
          Math.abs(box.y - (header.y + header.height)) <= 2,
          box.y + box.height <= inner - keyboard,
        ];
      })
      .toEqual([true, true]);
  };
  // The last group's "Add task" is the list's last row: there is room to scroll it up anyway.
  await page.getByRole('button', { name: 'Add task', exact: true }).last().tap();
  await showKeyboard(page, keyboard);
  await expectDraftAtTop();
  await page.locator('[data-list-input]').fill('First');
  await page.getByTestId('accessory-bar').getByRole('button', { name: 'Next' }).click();
  await expect(row(page, 'First')).toBeAttached();
  await expectDraftAtTop();
});

test("a new row's calendar opens the date sheet while its name stays in edit", async ({ page }) => {
  const { orgId } = await setup(page, 'draft.calendar', ['Already here']);
  await page.getByRole('button', { name: 'New task' }).tap();
  const input = page.locator('[data-list-input]');
  await expect(input).toBeFocused();
  await input.fill('Pay rent');
  const draftRow = page.getByTestId('task-row').filter({ has: input });
  const calendar = draftRow.getByRole('button', { name: 'Set due date' });
  // Touch has no hover: the calendar shows while the name is typed.
  await expect(calendar.locator('svg')).toHaveCSS('opacity', '0.6');
  await calendar.tap();
  await page
    .getByRole('dialog', { name: 'Due date' })
    .getByRole('button', { name: /^Tomorrow/ })
    .tap();
  await expect(page.getByRole('dialog', { name: 'Due date' })).toHaveCount(0);
  // Still the same draft, with its name and the caret back, and the date on its row.
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('Pay rent');
  await expect(draftRow.getByRole('button', { name: /^Due date: Tomorrow/ })).toBeVisible();
  await input.press('Enter');
  await expect(row(page, 'Pay rent')).toBeVisible();
  await waitForSync(page);
  const list = await myList(page, orgId);
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as { timezone: string };
  expect(list.tasks.find((t) => t.title === 'Pay rent')?.dueDate).toBe(
    addDays(todayIn(me.timezone, Date.now()), 1),
  );
});

test("a new row's calendar opens one sheet and keeps the edit when the click comes late (Android)", async ({
  page,
}) => {
  await setup(page, 'draft.calendar.late', ['Already here']);
  await page.getByRole('button', { name: 'New task' }).tap();
  const input = page.locator('[data-list-input]');
  await expect(input).toBeFocused();
  const calendar = page
    .getByTestId('task-row')
    .filter({ has: input })
    .getByRole('button', { name: 'Set due date' });
  // A real Android tap: the click follows pointerup ~30 ms later, focus moving to the button
  // in between. The draft's hold must last until that click, or the edit ends under the sheet.
  const sheetsSeen = await calendar.evaluate(async (el) => {
    const counts: number[] = [];
    const watch = new MutationObserver(() => {
      const n = document.querySelectorAll('[data-testid="quick-date-sheet"]').length;
      if (counts.at(-1) !== n) counts.push(n);
    });
    watch.observe(document.body, { childList: true, subtree: true });
    const r = el.getBoundingClientRect();
    const at = {
      bubbles: true,
      cancelable: true,
      composed: true,
      clientX: r.x + r.width / 2,
      clientY: r.y + r.height / 2,
    };
    const touch = { ...at, pointerId: 7, pointerType: 'touch', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', touch));
    await new Promise((done) => setTimeout(done, 60));
    el.dispatchEvent(new PointerEvent('pointerup', touch));
    await new Promise((done) => setTimeout(done, 40));
    (el as HTMLElement).focus();
    el.dispatchEvent(new MouseEvent('click', { ...at, detail: 1 }));
    await new Promise((done) => setTimeout(done, 1200));
    watch.disconnect();
    return counts;
  });
  // The sheet appeared once and stayed: no close-and-reopen.
  expect(sheetsSeen).toEqual([1]);
  await expect(input).toHaveCount(1);
  await page
    .getByRole('dialog', { name: 'Due date' })
    .getByRole('button', { name: /^Tomorrow/ })
    .tap();
  await expect(page.getByRole('dialog', { name: 'Due date' })).toHaveCount(0);
  await expect(input).toBeFocused();
});

test('the detail sheet opens on tap and closes with back (history) and ‹', async ({ page }) => {
  await setup(page, 'sheet.open', ['Write Q4 plan']);
  await row(page, 'Write Q4 plan').click();
  const sheet = page.getByTestId('detail-pane');
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(/\/t\//);
  await page.waitForTimeout(400);
  if (shots) await page.waitForTimeout(400);
  if (shots) await page.screenshot({ path: `${shots}/390-sheet.png` });
  await expectNoAxeViolations(page);
  // Property rows are 48 px and open bottom sheets.
  await page.getByTestId('sheet-due').click();
  await expect(page.getByRole('dialog', { name: 'Due date' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Due date' })).toHaveCount(0);
  // System back closes the sheet (it is a history entry).
  await page.goBack();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/my$/);
  // ‹ back closes it too and leaves no extra history entry behind.
  await row(page, 'Write Q4 plan').click();
  await expect(sheet).toBeVisible();
  await page.getByRole('button', { name: 'Back' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/my$/);
});

test('a tap on a description link shows the link card, and Open opens it (ADR 0062)', async ({
  page,
}) => {
  const { ids } = await setup(page, 'link.card', ['Read the guide']);
  // A long address must truncate, not push Edit and Remove off the screen.
  const target = new URL(`/help?q=${'keyboard-shortcuts-'.repeat(8)}`, page.url()).href;
  // Enough text below the link for the sheet to scroll.
  const filler = Array.from({ length: 30 }, (_, i) => `Line ${i + 1}.`).join('\n\n');
  const res = await apiCall(page, 'PATCH', `/api/v1/tasks/${ids[0]}`, {
    description: `See [the guide](${target}) first.\n\n${filler}`,
  });
  expect(res.ok()).toBe(true);
  await reload(page);
  await row(page, 'Read the guide').click();
  const sheet = page.getByTestId('detail-pane');
  await expect(sheet).toBeVisible();
  await sheet.getByRole('link', { name: 'the guide' }).tap();
  const card = page.getByTestId('link-card');
  await expect(card).toBeVisible();
  // The tap only placed the caret: the text is still being edited, nothing navigated.
  await expect(page).toHaveURL(/\/t\//);
  const viewport = page.viewportSize();
  const remove = await card.getByRole('button', { name: 'Remove link' }).boundingBox();
  expect(remove && viewport && remove.x + remove.width).toBeLessThanOrEqual(viewport?.width ?? 0);
  // The card follows its link when the sheet scrolls.
  const link = sheet.getByRole('link', { name: 'the guide' });
  await page.locator('[data-pane-scroller]').evaluate((el) => el.scrollBy(0, 40));
  await expect(async () => {
    const [linkBox, cardBox] = await Promise.all([link.boundingBox(), card.boundingBox()]);
    expect(Math.abs((cardBox?.y ?? 0) - ((linkBox?.y ?? 0) + (linkBox?.height ?? 0)))).toBeLessThan(
      12,
    );
  }).toPass();
  await expectNoAxeViolations(page);
  const popup = page.waitForEvent('popup');
  await card.getByRole('link', { name: /^Open / }).tap();
  await expect(await popup).toHaveURL(target);
});

test('an edit from another device while the link card is open never rewrites another link', async ({
  page,
}) => {
  const { ids } = await setup(page, 'link.remote', ['Pay the invoice']);
  const before = 'See [docs](https://example.com/) and [billing](https://billing.example/).';
  expect(
    (await apiCall(page, 'PATCH', `/api/v1/tasks/${ids[0]}`, { description: before })).ok(),
  ).toBe(true);
  await reload(page);
  await row(page, 'Pay the invoice').click();
  const sheet = page.getByTestId('detail-pane');
  await sheet.getByRole('link', { name: 'docs' }).tap();
  const card = page.getByTestId('link-card');
  await expect(card).toBeVisible();
  // Another device rewrites the description; it waits while this one is being edited.
  // It ends with a link, so the caret at its end is inside one.
  const remote = 'See [billing](https://billing.example/)';
  expect(
    (await apiCall(page, 'PATCH', `/api/v1/tasks/${ids[0]}`, { description: remote })).ok(),
  ).toBe(true);
  await page.waitForTimeout(1500);
  await card.getByRole('button', { name: 'Edit link' }).tap();
  // While anything editable has focus the keyboard stays up, and the user types the new
  // address, field visible or not (after a human pause: the field shows with the bubble menu,
  // 250 ms after the selection).
  await page.waitForTimeout(600);
  const editable = await page.evaluate(
    () => document.activeElement?.matches('input, [contenteditable="true"]') ?? false,
  );
  if (editable) {
    await page.keyboard.type('https://changed.example/');
    await page.keyboard.press('Enter');
  }
  await page.getByRole('button', { name: 'Back' }).tap();
  await waitForSync(page);
  const task = await (await apiCall(page, 'GET', `/api/v1/tasks/${ids[0]}`)).json();
  expect(task.description).not.toContain('changed.example');
});

test('the org switcher sheet lists the orgs and switches', async ({ page }) => {
  await signInAs(page, uniqueEmail('org.switch'));
  const res = await apiCall(page, 'POST', '/api/v1/orgs', { name: 'Garden club' });
  expect(res.status()).toBe(201);
  await reload(page);
  await page.getByTestId('org-switcher').click();
  const sheet = page.getByRole('dialog', { name: 'Organisations' });
  await expect(sheet.getByRole('button', { name: 'Personal' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'New organisation' })).toBeVisible();
  await expectNoAxeViolations(page);
  await sheet.getByRole('button', { name: 'Garden club' }).click();
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/o\/garden-club[^/]*\/my$/);
  await expect(page.getByTestId('org-switcher')).toContainText('Garden club');
});

test('ADR 0063 a swipe on the org name moves between orgs and keeps the view', async ({ page }) => {
  await signInAs(page, uniqueEmail('org.swipe'));
  for (const name of ['Garden club', 'Book club']) {
    expect((await apiCall(page, 'POST', '/api/v1/orgs', { name })).status()).toBe(201);
  }
  await reload(page);
  await page.getByRole('link', { name: 'Today' }).click();
  await expect(page).toHaveURL(/\/today$/);
  const switcher = page.getByTestId('org-switcher');
  await expect(switcher).toContainText('Personal');
  await expect(page.getByTestId('org-dots').locator('span')).toHaveCount(3);
  // Left brings the next org in, in sidebar order, on the same view.
  await swipe(page, switcher, -0.9);
  await expect(page).toHaveURL(/\/o\/garden-club[^/]*\/today$/);
  await expect(switcher).toContainText('Garden club');
  await swipe(page, switcher, -0.9);
  await expect(switcher).toContainText('Book club');
  // Past the last org it only springs back; the sheet stays closed.
  await swipe(page, switcher, -0.9);
  await page.waitForTimeout(400);
  await expect(switcher).toContainText('Book club');
  await expect(page.getByRole('dialog', { name: 'Organisations' })).toHaveCount(0);
  // Right goes back.
  await swipe(page, switcher, 0.9);
  await expect(switcher).toContainText('Garden club');
  await expect(page).toHaveURL(/\/today$/);
});

test('ADR 0063 press-and-slide: hold the org name, slide to an org, lift to switch', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('org.slide'));
  expect((await apiCall(page, 'POST', '/api/v1/orgs', { name: 'Garden club' })).status()).toBe(201);
  await reload(page);
  const switcher = page.getByTestId('org-switcher');
  await expect(switcher).toContainText('Personal');
  const sheet = page.getByRole('dialog', { name: 'Organisations' });
  await pressAndSlide(page, switcher, sheet.getByRole('button', { name: 'Garden club' }));
  await expect(sheet).toHaveCount(0);
  await expect(page).toHaveURL(/\/o\/garden-club[^/]*\/my$/);
  await expect(switcher).toContainText('Garden club');
  // Lifting outside the list leaves the sheet open, as a tap would.
  await pressAndSlide(page, switcher, sheet.getByRole('heading', { name: 'Organisations' }));
  await expect(sheet).toBeVisible();
  await expect(page).toHaveURL(/\/o\/garden-club[^/]*\/my$/);
});

test('inputs are at least 16 px on phones (no zoom on focus)', async ({ page }) => {
  await setup(page, 'font.size', ['Tag me']);
  await row(page, 'Tag me').click();
  await page.getByRole('button', { name: 'Add tag' }).click();
  await expect(page.getByRole('dialog', { name: 'Tags' })).toBeVisible();
  const sizes = await page
    .locator(
      'input:not([type="checkbox"]):not([type="radio"]):visible, textarea:visible, [contenteditable="true"]:visible',
    )
    .evaluateAll((els) =>
      els.map(
        (el) =>
          `${el.tagName}.${el.getAttribute('aria-label') ?? el.getAttribute('placeholder') ?? ''}=${Number.parseFloat(getComputedStyle(el).fontSize)}`,
      ),
    );
  expect(sizes.length).toBeGreaterThan(0);
  for (const entry of sizes)
    expect(Number(entry.split('=').at(-1)), entry).toBeGreaterThanOrEqual(16);
});

test('Settings → Behaviour stores the swipe actions', async ({ page }) => {
  const { orgId, ids } = await setup(page, 'swipe.prefs', ['Swipe to delete']);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'Settings' })
    .click();
  await page.getByRole('link', { name: 'Behaviour' }).click();
  await page.getByRole('button', { name: /Swipe right/ }).click();
  await page.getByRole('option', { name: 'Delete' }).click();
  await expect
    .poll(
      async () =>
        (
          (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as {
            prefs: { swipeRight: string };
          }
        ).prefs.swipeRight,
    )
    .toBe('delete');
  await expectNoAxeViolations(page);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('link', { name: 'My tasks' })
    .click();
  await swipe(page, row(page, 'Swipe to delete'), 0.6);
  await expect(row(page, 'Swipe to delete')).toHaveCount(0);
  await waitForSync(page);
  const list = await myList(page, orgId);
  expect(list.tasks.find((t) => t.id === ids[0])).toBeUndefined();
});

test('390 × 844 screenshots', async ({ page }, testInfo) => {
  test.skip(!shots, 'design review only');
  const tag = testInfo.project.name === 'mobile' ? '' : `-${testInfo.project.name}`;
  await page.setViewportSize({ width: 390, height: 844 });
  const { orgId } = await setup(page, 'shots.phone', [
    'Reply to Anna about the invoice',
    'Book dentist',
    'Renew passport',
  ]);
  const prio = await groupId(page, orgId, 'Prio');
  await createTask(page, orgId, {
    title: 'Write Q4 plan',
    groupId: prio,
    afterId: null,
    beforeId: null,
  });
  await reload(page);
  await expect(row(page, 'Write Q4 plan')).toBeVisible();
  await page.screenshot({ path: `${shots}/390-list${tag}.png` });
  await page.getByTestId('org-switcher').click();
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${shots}/390-org-sheet${tag}.png` });
});
