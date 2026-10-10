import { crc32, deflateSync } from 'node:zlib';
import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import type { Attachment, TaskDetail } from '@rooster/core/schemas';
import { apiCall, signInAs, uniqueEmail } from './support/auth';
import { createTask, personalOrg } from './support/p3';
import { expect, test } from './support/test';

/**
 * Phase 10 attachments in the pane (WP 10.2, AC-10.2 in the UI): upload with the picker, drop
 * and paste; thumbnails and the lightbox; downloads; the size limit; delete. And the profile
 * picture (FR-SET-1), which runs through the same image pipeline.
 */

/** Set to a directory to keep the review screenshots (pane, lightbox, profile). */
const shots = process.env.ROOSTER_P10_SCREENSHOTS;
const wcag = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

/** A real PNG (sharp must be able to read it): `width` × `height`, one colour plus a stripe. */
function png(width: number, height: number, [r, g, b]: [number, number, number]): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const rows: Buffer[] = [];
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.alloc(1 + width * 3);
    for (let x = 0; x < width; x += 1) {
      const stripe = Math.abs(x - y) < width / 10;
      row[1 + x * 3] = stripe ? 255 : r;
      row[2 + x * 3] = stripe ? 255 : g;
      row[3 + x * 3] = stripe ? 255 : b;
    }
    rows.push(row);
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

async function detail(page: Page, taskId: string): Promise<TaskDetail> {
  return (await (await apiCall(page, 'GET', `/api/v1/tasks/${taskId}`)).json()) as TaskDetail;
}

async function openTask(page: Page, title: string) {
  await signInAs(page, uniqueEmail('frida.files'));
  const orgId = await personalOrg(page);
  const task = await createTask(page, orgId, { title });
  await page.goto(`/o/personal/t/${task.id}`);
  await expect(page.getByTestId('pane-attachments')).toBeVisible();
  return task;
}

function uploaded(page: Page) {
  return page.waitForResponse(
    (r) => /\/api\/v1\/tasks\/[^/]+\/attachments$/.test(r.url()) && r.request().method() === 'POST',
  );
}

test('AC-10.2 an image uploads to a thumbnail and opens in the lightbox; ←/→ and Esc', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  const task = await openTask(page, 'Survey the garden');
  const section = page.getByTestId('pane-attachments');
  await expect(section).toContainText('Drop files on this task, paste an image or');

  const response = uploaded(page);
  await page
    .getByTestId('attachment-input')
    .setInputFiles([
      { name: 'garden.png', mimeType: 'image/png', buffer: png(640, 480, [40, 120, 70]) },
    ]);
  expect((await response).status()).toBe(201);
  const second = uploaded(page);
  await page
    .getByTestId('attachment-input')
    .setInputFiles([
      { name: 'shed.png', mimeType: 'image/png', buffer: png(300, 500, [160, 90, 40]) },
    ]);
  expect((await second).status()).toBe(201);

  const thumbs = section.getByTestId('attachment-thumb');
  await expect(thumbs).toHaveCount(2);
  const img = thumbs.first().locator('img');
  await expect(img).toHaveAttribute('src', /\/api\/v1\/attachments\/[^/]+\/thumb$/);
  await expect
    .poll(() => img.evaluate((el) => (el as HTMLImageElement).naturalWidth))
    .toBeGreaterThan(0);
  // The row shows the paperclip count through the list's refetch (counts.attachments).
  expect((await detail(page, task.id)).counts.attachments).toBe(2);

  const axe = await new AxeBuilder({ page })
    .include('[data-testid="pane-attachments"]')
    .withTags(wcag)
    .analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  if (shots) {
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/pane-attachments-1440.png` });
  }

  await thumbs.first().click();
  const lightbox = page.getByTestId('lightbox');
  await expect(lightbox).toBeVisible();
  await expect(lightbox.getByTestId('lightbox-name')).toHaveText('garden.png');
  await expect(lightbox.getByTestId('lightbox-image')).toHaveAttribute('src', /\?inline=1$/);
  await expect
    .poll(() =>
      lightbox
        .getByTestId('lightbox-image')
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBe(640);
  await expect(lightbox).toContainText('1 of 2');
  if (shots) {
    // After the overlay's fade-in.
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/lightbox-1440.png` });
  }
  await page.keyboard.press('ArrowRight');
  await expect(lightbox.getByTestId('lightbox-name')).toHaveText('shed.png');
  await page.keyboard.press('ArrowRight');
  await expect(lightbox.getByTestId('lightbox-name')).toHaveText('garden.png');
  await page.keyboard.press('ArrowLeft');
  await expect(lightbox.getByTestId('lightbox-name')).toHaveText('shed.png');
  const download = page.waitForEvent('download');
  await lightbox.getByTestId('lightbox-download').click();
  expect((await download).suggestedFilename()).toBe('shed.png');
  await page.keyboard.press('Escape');
  await expect(lightbox).toHaveCount(0);
  // Focus is back on the thumbnail of the image last shown; the pane is still open.
  await expect(thumbs.nth(1)).toBeFocused();
  await expect(page.getByTestId('pane-attachments')).toBeVisible();
});

test('AC-10.2 a non-image is a row that downloads; an oversize file shows the limit', async ({
  page,
}) => {
  const task = await openTask(page, 'File the receipts');
  const response = uploaded(page);
  await page.getByTestId('attachment-input').setInputFiles([
    {
      name: 'receipts.csv',
      mimeType: 'text/csv',
      buffer: Buffer.from('date,amount\n2026-10-01,120\n'),
    },
  ]);
  expect((await response).status()).toBe(201);
  const row = page.getByTestId('attachment-file');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('receipts.csv');
  await expect(row).toContainText('Frida Files');
  const download = page.waitForEvent('download');
  await row.getByRole('link', { name: 'Download receipts.csv' }).click();
  const file = await download;
  expect(file.suggestedFilename()).toBe('receipts.csv');

  // 30 MB against the default 25 MB limit: cut off with 413, said plainly.
  const tooBig = uploaded(page);
  await page.getByTestId('attachment-input').setInputFiles([
    {
      name: 'footage.mov',
      mimeType: 'video/quicktime',
      buffer: Buffer.alloc(30 * 1024 * 1024, 1),
    },
  ]);
  expect((await tooBig).status()).toBe(413);
  const failed = page.getByTestId('attachment-upload');
  await expect(failed).toHaveAttribute('data-status', 'failed');
  await expect(failed).toContainText('footage.mov is larger than the upload limit.');
  await failed.getByRole('button', { name: 'Dismiss' }).click();
  await expect(failed).toHaveCount(0);
  expect((await detail(page, task.id)).attachments?.map((a) => a.filename)).toEqual([
    'receipts.csv',
  ]);
});

test('a pasted image becomes an attachment, never part of the description; drop works too', async ({
  page,
}) => {
  const task = await openTask(page, 'Collect screenshots');
  const editor = page.locator('[data-testid="description-field"] [contenteditable="true"]');
  await editor.click();
  await page.keyboard.type('Notes');
  const pasted = uploaded(page);
  const bytes = [...png(120, 80, [20, 60, 200])];
  await editor.evaluate((el, data) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(data)], 'image.png', { type: 'image/png' }));
    el.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: transfer, bubbles: true, cancelable: true }),
    );
  }, bytes);
  expect((await pasted).status()).toBe(201);
  await expect(page.getByTestId('attachment-thumb')).toHaveCount(1);
  await expect(editor.locator('img')).toHaveCount(0);
  await expect(editor).toHaveText('Notes');

  // Drop a file onto the description: the overlay shows, the file is attached.
  const dropped = uploaded(page);
  await editor.evaluate((el) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File(['agenda'], 'agenda.txt', { type: 'text/plain' }));
    el.dispatchEvent(
      new DragEvent('dragenter', { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
    (window as unknown as { __drop: DataTransfer }).__drop = transfer;
  });
  await expect(page.getByTestId('attachment-drop-overlay')).toBeVisible();
  await expect(page.getByTestId('attachment-drop-overlay')).toContainText('Drop to attach');
  await editor.evaluate((el) => {
    const transfer = (window as unknown as { __drop: DataTransfer }).__drop;
    el.dispatchEvent(
      new DragEvent('drop', { dataTransfer: transfer, bubbles: true, cancelable: true }),
    );
  });
  expect((await dropped).status()).toBe(201);
  await expect(page.getByTestId('attachment-drop-overlay')).toHaveCount(0);
  await expect(page.getByTestId('attachment-file')).toContainText('agenda.txt');
  const names = (await detail(page, task.id)).attachments?.map((a: Attachment) => a.filename);
  expect(names?.[0]).toMatch(/^Pasted image \d{4}-\d{2}-\d{2} \d{2}\.\d{2}\.\d{2}\.png$/);
  expect(names?.[1]).toBe('agenda.txt');
  expect((await detail(page, task.id)).description).not.toContain('image');
});

test('Tab+U opens the picker from the pane; delete asks inline first', async ({ page }) => {
  const task = await openTask(page, 'Tidy attachments');
  await page
    .getByTestId('attachment-input')
    .setInputFiles([{ name: 'old.txt', mimeType: 'text/plain', buffer: Buffer.from('old') }]);
  const row = page.getByTestId('attachment-file');
  await expect(row).toHaveCount(1);

  // Keyboard path to the picker (keymap `attachFile`): Tab held, then U.
  await page.getByTestId('attach-files').focus();
  const chooser = page.waitForEvent('filechooser');
  await page.keyboard.down('Tab');
  await page.keyboard.press('u');
  await page.keyboard.up('Tab');
  await (await chooser).setFiles([
    { name: 'new.txt', mimeType: 'text/plain', buffer: Buffer.from('new') },
  ]);
  await expect(row).toHaveCount(2);

  await page.getByRole('button', { name: 'Delete old.txt' }).click();
  const confirm = page.getByTestId('attachment-confirm');
  await expect(confirm).toContainText('Delete old.txt? This can’t be undone.');
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Delete old.txt' })).toBeFocused();
  await page.getByRole('button', { name: 'Delete old.txt' }).click();
  await page.getByTestId('attachment-confirm-delete').click();
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('new.txt');
  expect((await detail(page, task.id)).attachments?.map((a) => a.filename)).toEqual(['new.txt']);
});

test('offline the section says so and attaches nothing', async ({ page, context }) => {
  await openTask(page, 'Offline files');
  await context.setOffline(true);
  await expect(page.getByTestId('attachments-offline')).toBeVisible();
  await expect(page.getByTestId('attach-files')).toBeDisabled();
  await context.setOffline(false);
  await expect(page.getByTestId('attachments-offline')).toHaveCount(0);
});

test('FR-SET-1 a profile picture uploads, shows everywhere, and can be removed', async ({
  page,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await signInAs(page, uniqueEmail('petra.picture'));
  await page.goto('/settings/profile');
  const field = page.getByTestId('avatar-field');
  await expect(field).toContainText(
    'Until you upload one, your picture comes from your sign-in provider.',
  );
  const put = page.waitForResponse(
    (r) => r.url().endsWith('/api/v1/me/avatar') && r.request().method() === 'PUT',
  );
  await page
    .getByTestId('avatar-input')
    .setInputFiles([
      { name: 'me.png', mimeType: 'image/png', buffer: png(400, 300, [200, 120, 60]) },
    ]);
  expect((await put).status()).toBe(200);
  const me = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as {
    id: string;
    image: string;
  };
  expect(me.image).toMatch(new RegExp(`^/api/v1/avatars/${me.id}\\?v=`));
  // The profile and the sidebar's user menu both show the new picture.
  const pictures = page.locator(`img[src="${me.image}"]`);
  await expect(pictures.first()).toBeVisible();
  expect(await pictures.count()).toBeGreaterThanOrEqual(2);
  await expect(page.getByTestId('avatar-remove')).toBeVisible();
  if (shots) await page.screenshot({ path: `${shots}/profile-avatar-1440.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  if (shots) await page.screenshot({ path: `${shots}/profile-avatar-390.png` });
  await page.setViewportSize({ width: 1440, height: 900 });

  // SVG is never accepted as a picture.
  await page
    .getByTestId('avatar-input')
    .setInputFiles([{ name: 'me.svg', mimeType: 'image/svg+xml', buffer: Buffer.from('<svg/>') }]);
  await expect(field.getByRole('alert')).toHaveText('Choose a PNG, JPEG, GIF, WebP or AVIF image.');

  await page.getByTestId('avatar-remove').click();
  await expect(page.getByTestId('avatar-remove')).toHaveCount(0);
  const after = (await (await apiCall(page, 'GET', '/api/v1/me')).json()) as {
    image: string | null;
  };
  expect(after.image ?? '').not.toContain('/api/v1/avatars/');
});
