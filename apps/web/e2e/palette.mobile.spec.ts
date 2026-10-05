import { englishUi, palette, paletteInput, paletteTask, seed } from './support/p5-palette';
import { expect, test } from './support/test';

/** Phase 5 on phones (02 §13.1, ADR 0011): the bottom nav's Search tab opens the palette sheet. */

const shots = process.env.ROOSTER_P5_SCREENSHOTS;

test.beforeEach(async ({ page }) => {
  await englishUi(page);
});

test('the Search tab opens the full-screen palette; a result opens the detail sheet', async ({
  page,
}, testInfo) => {
  const { ids } = await seed(page, 'palette.phone', ['Boka tandläkare', 'Handla mat']);
  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Search' })
    .tap();
  await expect(palette(page)).toBeVisible();
  await expect(paletteInput(page)).toBeFocused();
  const box = await palette(page).boundingBox();
  const viewport = page.viewportSize();
  expect(Math.round(box?.width ?? 0)).toBe(viewport?.width);
  expect(Math.round(box?.height ?? 0)).toBe(viewport?.height);
  await expect(page.getByTestId('palette-empty')).toBeVisible();
  if (shots && testInfo.project.name === 'mobile') {
    await page.waitForTimeout(400);
    await page.screenshot({ path: `${shots}/palette-empty-390.png` });
  }
  await page.getByRole('button', { name: 'Cancel' }).tap();
  await expect(palette(page)).toHaveCount(0);

  await page
    .getByRole('navigation', { name: 'Primary' })
    .getByRole('button', { name: 'Search' })
    .tap();
  await paletteInput(page).fill('tand');
  const hit = paletteTask(page, 'Boka tandläkare');
  await expect(hit).toBeVisible();
  const row = await hit.boundingBox();
  expect(row?.height ?? 0).toBeGreaterThanOrEqual(44);
  if (shots && testInfo.project.name === 'mobile') {
    await page.screenshot({ path: `${shots}/palette-results-390.png` });
  }
  await hit.tap();
  await expect(palette(page)).toHaveCount(0);
  await expect(page).toHaveURL(new RegExp(`/o/personal/t/${ids[0]}$`));
});

test('Settings → Data on a phone: export and an empty Trash', async ({ page }, testInfo) => {
  await seed(page, 'palette.phonedata', ['Kept']);
  await page.goto('/settings/data');
  await expect(page.getByTestId('trash-empty')).toBeVisible();
  await expect(page.getByTestId('export-json')).toBeVisible();
  if (shots && testInfo.project.name === 'mobile') {
    await page.screenshot({ path: `${shots}/settings-data-390.png` });
  }
});
