import { expect, type Page } from '@playwright/test';

/** The section header's toggle: named by the org alone (its grip and "⋯" add words). */
export const sectionToggle = (page: Page, name: string) =>
  page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('region', { name })
    .getByRole('button', { name, exact: true });

/**
 * Opens an org's sidebar section if it is collapsed: from three orgs on, the orgs other than
 * the one in the URL start collapsed (ADR 0076).
 */
export async function expandSection(page: Page, name: string): Promise<void> {
  const toggle = sectionToggle(page, name);
  if ((await toggle.getAttribute('aria-expanded')) === 'false') await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
}
