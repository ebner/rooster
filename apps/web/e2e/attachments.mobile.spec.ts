import { crc32, deflateSync } from 'node:zlib';
import { signInAs, uniqueEmail } from './support/auth';
import { createTask, personalOrg } from './support/p3';
import { expect, test } from './support/test';
import { swipe } from './support/touch';

/** Phase 10 attachments on phones: the full-screen pane sheet, the lightbox and its swipes. */

const shots = process.env.ROOSTER_P10_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem('e2e-init')) {
      sessionStorage.setItem('e2e-init', '1');
      localStorage.setItem('rooster.locale', 'en');
    }
  });
});

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
  header[8] = 8;
  header[9] = 2;
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([r, g, b], 1 + x * 3);
  const rows = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(rows)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

test('the pane sheet shows thumbnails; the lightbox swipes between images and closes', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('philip.phone'));
  const orgId = await personalOrg(page);
  const task = await createTask(page, orgId, { title: 'Snap the meter' });
  // Let the post-sign-in landing settle first (WebKit otherwise interrupts the navigation).
  await page.waitForLoadState('networkidle');
  await page.goto(`/o/personal/t/${task.id}`);
  await expect(page.getByTestId('detail-pane')).toBeVisible();
  const section = page.getByTestId('pane-attachments');
  await expect(section).toBeVisible();
  await page
    .getByTestId('attachment-input')
    .setInputFiles([
      { name: 'meter.png', mimeType: 'image/png', buffer: png(480, 640, [30, 90, 160]) },
    ]);
  await expect(section.getByTestId('attachment-thumb')).toHaveCount(1);
  await page
    .getByTestId('attachment-input')
    .setInputFiles([
      { name: 'fuse-box.png', mimeType: 'image/png', buffer: png(640, 480, [170, 60, 40]) },
    ]);
  await expect(section.getByTestId('attachment-thumb')).toHaveCount(2);
  await section.scrollIntoViewIfNeeded();
  if (shots) {
    await page.screenshot({ path: `${shots}/pane-attachments-${test.info().project.name}.png` });
  }

  await section.getByTestId('attachment-thumb').first().tap();
  const lightbox = page.getByTestId('lightbox');
  await expect(lightbox.getByTestId('lightbox-name')).toHaveText('meter.png');
  await expect
    .poll(() =>
      lightbox
        .getByTestId('lightbox-image')
        .evaluate((el) => (el as HTMLImageElement).naturalWidth),
    )
    .toBe(480);
  if (shots) {
    // After the overlay's fade-in.
    await page.waitForTimeout(1000);
    await page.screenshot({ path: `${shots}/lightbox-${test.info().project.name}.png` });
  }
  await swipe(page, lightbox.getByTestId('lightbox-image'), -0.6);
  await expect(lightbox.getByTestId('lightbox-name')).toHaveText('fuse-box.png');
  await swipe(page, lightbox.getByTestId('lightbox-image'), 0.6);
  await expect(lightbox.getByTestId('lightbox-name')).toHaveText('meter.png');
  await lightbox.getByTestId('lightbox-close').tap();
  await expect(lightbox).toHaveCount(0);
  // Still in the task's sheet.
  await expect(section).toBeVisible();
});
