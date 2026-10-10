import { signInAs, uniqueEmail } from './support/auth';
import { expect, test } from './support/test';

/** AC-11.6 on phones: the guide from the settings index, with "‹ Help" back to the page list. */
test('AC-11.6 phones reach the guide from Settings and step back to the page list', async ({
  page,
}) => {
  await signInAs(page, uniqueEmail('help.phone'));
  await expect(page.getByRole('treegrid')).toBeVisible();
  await page.goto('/settings');
  await page.getByTestId('settings-index').getByRole('link', { name: /^Help/ }).click();
  await expect(page).toHaveURL(/\/help$/);
  await page
    .getByTestId('guide-index')
    .getByRole('link', { name: /Keyboard shortcuts/ })
    .click();
  await expect(page).toHaveURL(/\/help\/keyboard$/);
  await expect(page.getByRole('heading', { level: 1, name: 'Keyboard shortcuts' })).toBeVisible();
  // The page list sits beside the article only on wide screens.
  await expect(page.getByRole('navigation', { name: 'Guide pages' })).toBeHidden();
  // Wide tables scroll inside the article, never the page.
  const overflow = await page.evaluate(() => {
    const main = document.querySelector('main') as HTMLElement;
    return main.scrollWidth - main.clientWidth;
  });
  expect(overflow).toBeLessThanOrEqual(0);
  await page.getByRole('link', { name: 'Back to Help' }).click();
  await expect(page).toHaveURL(/\/help$/);
});
