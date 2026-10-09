import type { Browser, Page } from '@playwright/test';
import { apiCall, displayNameOf, newClient, signInAs, uniqueEmail } from './auth';

/** Phase 6 helpers (assignment, Everyone's tasks): a shared org of two people. */

export interface SharedOrg {
  a: Page;
  b: Page;
  slug: string;
  orgId: string;
  aId: string;
  bId: string;
  aName: string;
  bName: string;
}

/** A signs in and creates an org; B joins it through an invite link. */
export async function sharedOrg(page: Page, browser: Browser, name: string): Promise<SharedOrg> {
  const aEmail = uniqueEmail(`${name}.alice`);
  await signInAs(page, aEmail);
  const created = await apiCall(page, 'POST', '/api/v1/orgs', { name: 'Harbour' });
  const org = (await created.json()) as { id: string; slug: string };
  const invite = await apiCall(page, 'POST', `/api/v1/orgs/${org.slug}/invites`, {
    role: 'member',
  });
  const invitePath = new URL(((await invite.json()) as { url: string }).url).pathname;
  const bContext = await newClient(browser);
  await bContext.addInitScript(() => localStorage.setItem('rooster.locale', 'en'));
  const b = await bContext.newPage();
  const bEmail = uniqueEmail(`${name}.bertil`);
  await signInAs(b, bEmail, displayNameOf(bEmail), {
    startAt: invitePath,
    button: 'Accept and sign in',
    landing: new RegExp(`/o/${org.slug}/my$`),
  });
  const id = async (p: Page) =>
    ((await (await apiCall(p, 'GET', '/api/v1/me')).json()) as { id: string }).id;
  return {
    a: page,
    b,
    slug: org.slug,
    orgId: org.id,
    aId: await id(page),
    bId: await id(b),
    aName: displayNameOf(aEmail),
    bName: displayNameOf(bEmail),
  };
}
