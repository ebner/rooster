import type { Page } from '@playwright/test';
import { clickRowBody, mod } from '../../../apps/web/e2e/support/p3';
import { api } from './demo-api';
import { DEMO } from './demo-env';
import { capturing, expect, shot, test } from './shoot';
import { terminalHtml, tuiFrame } from './terminal';

/** Desktop (1440 × 900, the 112.5 % UI scale): the screens the guide and the README show. */

const HERO = 'Homepage hero concepts';
const row = (page: Page, title: string) =>
  page.getByTestId('task-row').filter({ hasText: title }).first();

/** Back to a calm list: no popover, palette, pane or selection left over from the last shot. */
async function reset(page: Page, path: string) {
  await page.keyboard.press('Escape');
  await page.goto(path);
  await page.getByTestId('task-row').first().waitFor();
}

test('desktop screens', async ({ page, demo, request }, testInfo) => {
  test.setTimeout(600_000);
  const run = capturing(testInfo);
  const org = `/o/${demo.orgs.studioSlug}`;

  await run.take('my-tasks', async () => {
    await reset(page, `${org}/my`);
    await shot(page, testInfo, 'my-tasks');
  });

  await run.take('task-pane', async () => {
    await reset(page, `${org}/my`);
    await clickRowBody(page, HERO);
    const pane = page.getByTestId('detail-pane');
    await expect(pane.getByTestId('pane-title')).toHaveValue(HERO);
    await expect(pane.getByTestId('attachment-thumb').first()).toBeVisible();
    await shot(page, testInfo, 'task-pane');
    // Further down: the attachments and the conversation.
    await pane.getByTestId('pane-attachments').scrollIntoViewIfNeeded();
    await pane.getByText('could you shoot the tins').scrollIntoViewIfNeeded();
    await shot(page, testInfo, 'task-pane-activity');
  });

  await run.take('lightbox', async () => {
    await reset(page, `${org}/my`);
    await clickRowBody(page, HERO);
    const pane = page.getByTestId('detail-pane');
    await pane.getByTestId('attachment-thumb').nth(1).click();
    await expect(page.getByTestId('lightbox-image')).toBeVisible();
    await shot(page, testInfo, 'lightbox');
    await page.keyboard.press('Escape');
  });

  await run.take('date-picker', async () => {
    // The open popover with Repeat and Reminders is taller than 900 px: a tall window, and the
    // picture cropped to the row and the popover.
    await page.setViewportSize({ width: 1440, height: 1600 });
    await reset(page, `${org}/my`);
    await row(page, 'Send invoices for September').locator('[data-focus-target]').focus();
    await page.keyboard.press('d');
    const dialog = page.getByRole('dialog', { name: 'Due date' });
    await expect(dialog).toBeVisible();
    // As a user would: pick a repeat preset, then open the reminders (Alt+R). Esc afterwards
    // leaves the task unchanged.
    await dialog.getByRole('button', { name: 'Repeat' }).click();
    await dialog
      .getByText(/^Weekly on /)
      .first()
      .click();
    // A task that has reminders opens with them shown; Alt+R would close them again.
    await page.waitForTimeout(300);
    if (!(await dialog.getByTestId('reminder-section').isVisible())) {
      await page.keyboard.press('Alt+r');
    }
    await expect(dialog.getByTestId('reminder-section')).toBeVisible();
    await page.waitForTimeout(300);
    const a = await row(page, 'Send invoices for September').boundingBox();
    const b = await dialog.boundingBox();
    if (!a || !b) throw new Error('nothing to crop');
    const pad = 24;
    const x = Math.max(0, Math.min(a.x, b.x) - pad);
    const y = Math.max(0, Math.min(a.y, b.y) - pad);
    await shot(page, testInfo, 'date-picker', {
      clip: {
        x,
        y,
        width: Math.min(1440, Math.max(a.x + a.width, b.x + b.width) + pad) - x,
        height: Math.max(a.y + a.height, b.y + b.height) + pad - y,
      },
    });
    await page.keyboard.press('Escape');
    await page.setViewportSize({ width: 1440, height: 900 });
  });

  await run.take('nl-date', async () => {
    await reset(page, `${org}/my`);
    await row(page, 'Prepare the client workshop agenda').locator('[data-focus-target]').focus();
    await page.keyboard.press('n');
    await page.keyboard.type('Send the Tidewater quote fri at 10 #client !1h', { delay: 15 });
    await page.waitForTimeout(300);
    await shot(page, testInfo, 'nl-date');
    // Leave nothing behind: an emptied draft disappears.
    await page.keyboard.press(`${mod}+a`);
    await page.keyboard.press('Backspace');
    await page.keyboard.press('Escape');
  });

  for (const [name, view] of [
    ['today', 'today'],
    ['next-7-days', 'week'],
  ] as const) {
    await run.take(name, async () => {
      await reset(page, `${org}/${view}`);
      await shot(page, testInfo, name);
    });
  }

  await run.take('everyone', async () => {
    await reset(page, `${org}/everyone`);
    // Maja's own section comes first and is long: start the picture where the others begin.
    await page
      .locator(`[data-testid="member-section"][data-assignee="${demo.people.amara?.id}"]`)
      .evaluate((el) => {
        // Scroll the list's own scroller; scrollIntoView may also move the pinned frame.
        let scroller = el.parentElement;
        while (
          scroller &&
          !(
            /(auto|scroll)/.test(getComputedStyle(scroller).overflowY) &&
            scroller.scrollHeight > scroller.clientHeight
          )
        ) {
          scroller = scroller.parentElement;
        }
        if (!scroller) return;
        const top = el.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
        scroller.scrollTop += top - scroller.clientHeight * 0.4;
      });
    await shot(page, testInfo, 'everyone');
  });

  await run.take('palette', async () => {
    await reset(page, `${org}/my`);
    await page.keyboard.press(`${mod}+k`);
    await page.getByTestId('palette-input').fill('juniper');
    await expect(page.getByTestId('palette-task').first()).toBeVisible();
    await shot(page, testInfo, 'palette');
    await page.keyboard.press('Escape');
  });

  await run.take('shortcuts', async () => {
    await reset(page, `${org}/my`);
    await page.locator('body').click({ position: { x: 900, y: 880 } });
    await page.keyboard.press('?');
    await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' }).first()).toBeVisible();
    await shot(page, testInfo, 'shortcuts');
    await page.keyboard.press('Escape');
  });

  await run.take('inbox', async () => {
    await page.goto('/inbox');
    await expect(page.getByTestId('inbox')).toBeVisible();
    await shot(page, testInfo, 'inbox');
  });

  await run.take('notification-settings', async () => {
    await page.goto('/settings/notifications');
    await expect(page.getByRole('table').first()).toBeVisible();
    await shot(page, testInfo, 'notification-settings');
  });

  await run.take('calendar-feed', async () => {
    await page.goto('/settings/calendar');
    await expect(page.getByTestId('calendar-feeds')).toBeVisible();
    await shot(page, testInfo, 'calendar-feed');
  });

  await run.take('device-consent', async () => {
    // What `rooster login` does: ask for a device code, then send the user to /device.
    const res = await request.post('/api/auth/device/code', {
      form: { client_id: 'rooster-cli', scope: 'tasks:write comments:write groups:write' },
    });
    expect(res.status(), await res.text()).toBe(200);
    const code = (await res.json()) as { verification_uri_complete: string };
    const verify = new URL(code.verification_uri_complete);
    await page.goto(verify.pathname + verify.search);
    await expect(page.getByTestId('device-request')).toBeVisible();
    await shot(page, testInfo, 'device-consent');
    await page.getByTestId('device-approve').click();
    await expect(page.getByTestId('device-done')).toBeVisible();
  });

  await run.take('connected-apps', async () => {
    await page.goto('/settings/security');
    const apps = page.getByTestId('connected-apps');
    await apps.scrollIntoViewIfNeeded();
    await expect(apps).toContainText('Weekly report script');
    await shot(page, testInfo, 'connected-apps');
  });

  await run.take('tui', async () => {
    // The real TUI, signed in with a token that is revoked again afterwards (after the
    // Connected apps shot, which must not show it).
    const created = await api<{ token: string; grant: { id: string } }>(
      page,
      'POST',
      '/me/tokens',
      {
        name: 'Docs TUI',
        scopes: [
          'tasks:read',
          'tasks:write',
          'comments:write',
          'groups:write',
          'notifications:read',
        ],
        constraints: { orgs: 'all' },
        expiresInDays: 1,
      },
    );
    try {
      const frame = tuiFrame(DEMO.baseURL, created.token, {
        columns: 100,
        rows: 30,
        org: 'Kestrel Lane',
        wait: ['Homepage hero concepts'],
        timezone: DEMO.timezone,
      });
      const terminal = await page.context().newPage();
      try {
        await terminal.setContent(terminalHtml(frame, 'rooster'));
        const box = await terminal.locator('#terminal').boundingBox();
        if (!box) throw new Error('no terminal');
        const pad = 24;
        await shot(terminal, testInfo, 'tui', {
          clip: {
            x: box.x - pad,
            y: box.y - pad,
            width: box.width + 2 * pad,
            height: box.height + 2 * pad,
          },
        });
      } finally {
        await terminal.close();
      }
    } finally {
      await api(page, 'DELETE', `/me/grants/${created.grant.id}`);
    }
  });

  run.done();
});
