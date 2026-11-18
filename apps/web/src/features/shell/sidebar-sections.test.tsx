import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { sessionDataCleared } from '../../data/session-events';
import type { Org } from '../../data/types';
import { sweepUserStorage, userStorageKey } from '../../lib/user-storage';
import { fixtureMe } from './fixtures';
import { Sidebar, type SidebarProps } from './sidebar';
import {
  allOrgsSectionId,
  allSectionCollapsed,
  orgSectionCollapsed,
  sectionState,
  setSectionState,
} from './sidebar-sections';

const user = fixtureMe.user;
const [personal, company, club] = fixtureMe.orgs as [Org, Org, Org];
const storageKeyOf = (sectionId: string) => userStorageKey(user.id, `sidebar.section.${sectionId}`);

beforeEach(() => {
  localStorage.clear();
  // Drops the page's cached toggles, as a sign-out does.
  sessionDataCleared();
});

describe('orgSectionCollapsed (ADR 0076)', () => {
  const base = { stored: null, serverCollapsed: false, active: false, orgCount: 3 };

  test('from three orgs on, an untouched org is collapsed unless it is the one in the URL', () => {
    expect(orgSectionCollapsed(base)).toBe(true);
    expect(orgSectionCollapsed({ ...base, active: true })).toBe(false);
    expect(orgSectionCollapsed({ ...base, orgCount: 5 })).toBe(true);
  });

  test('with fewer than three orgs, every untouched org is open', () => {
    expect(orgSectionCollapsed({ ...base, orgCount: 2 })).toBe(false);
    expect(orgSectionCollapsed({ ...base, orgCount: 1 })).toBe(false);
  });

  test("an explicit choice on this browser wins, the URL's org included", () => {
    expect(orgSectionCollapsed({ ...base, stored: 'open' })).toBe(false);
    expect(orgSectionCollapsed({ ...base, stored: 'closed', active: true })).toBe(true);
    expect(orgSectionCollapsed({ ...base, stored: 'closed', orgCount: 2 })).toBe(true);
    // Expanded here after a collapse stored on the server (another browser): this one's wins.
    expect(orgSectionCollapsed({ ...base, stored: 'open', serverCollapsed: true })).toBe(false);
  });

  test('a collapse stored on the server counts as explicit: navigating in keeps it closed', () => {
    expect(orgSectionCollapsed({ ...base, serverCollapsed: true, active: true })).toBe(true);
    expect(orgSectionCollapsed({ ...base, serverCollapsed: true, orgCount: 1 })).toBe(true);
  });

  test('All organisations is open unless collapsed on this browser', () => {
    expect(allSectionCollapsed(null)).toBe(false);
    expect(allSectionCollapsed('open')).toBe(false);
    expect(allSectionCollapsed('closed')).toBe(true);
  });
});

describe('the tri-state on this browser', () => {
  test('unset until chosen; stored per user and section', () => {
    expect(sectionState(user.id, company.id)).toBeNull();
    setSectionState(user.id, company.id, 'closed');
    expect(localStorage.getItem(storageKeyOf(company.id))).toBe('closed');
    expect(sectionState(user.id, company.id)).toBe('closed');
    setSectionState(user.id, company.id, 'open');
    expect(sectionState(user.id, company.id)).toBe('open');
    expect(sectionState('someone-else', company.id)).toBeNull();
  });

  test('read back from storage in a fresh page; anything else there counts as unset', () => {
    localStorage.setItem(storageKeyOf(club.id), 'closed');
    localStorage.setItem(storageKeyOf(personal.id), 'sideways');
    expect(sectionState(user.id, club.id)).toBe('closed');
    expect(sectionState(user.id, personal.id)).toBeNull();
  });

  test('swept with the other per-user keys on sign-out', () => {
    setSectionState(user.id, company.id, 'open');
    setSectionState(user.id, allOrgsSectionId, 'closed');
    sweepUserStorage(undefined, localStorage, async () => {});
    sessionDataCleared();
    expect(localStorage.getItem(storageKeyOf(company.id))).toBeNull();
    expect(sectionState(user.id, company.id)).toBeNull();
    expect(sectionState(user.id, allOrgsSectionId)).toBeNull();
  });

  test('blocked storage: the choice still holds for the page', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('blocked', 'SecurityError');
    });
    setSectionState(user.id, company.id, 'closed');
    expect(sectionState(user.id, company.id)).toBe('closed');
    spy.mockRestore();
  });
});

describe('Sidebar sections', () => {
  function renderSidebar(overrides: Partial<SidebarProps> = {}) {
    const onToggleOrgCollapsed = vi.fn<(orgId: string, collapsed: boolean) => void>();
    const props: SidebarProps = {
      user,
      orgs: fixtureMe.orgs,
      locale: 'en',
      collapsed: false,
      onReorder: () => {},
      onToggleOrgCollapsed,
      onCreateOrg: () => {},
      onLocaleChange: () => {},
      onSignOut: () => {},
      ...overrides,
    };
    const result = render(<Sidebar {...props} />);
    return { ...result, onToggleOrgCollapsed, props };
  }
  const header = (name: string) =>
    within(screen.getByRole('region', { name })).getAllByRole('button')[0] as HTMLElement;
  const expanded = (name: string) => header(name).getAttribute('aria-expanded');
  /** Enter or Space on the focused header, as React Aria hears a key press. */
  const press = (element: HTMLElement, key: 'Enter' | ' ') => {
    act(() => element.focus());
    fireEvent.keyDown(element, { key, code: key === ' ' ? 'Space' : 'Enter' });
    fireEvent.keyUp(element, { key, code: key === ' ' ? 'Space' : 'Enter' });
  };

  test('the header names the org and controls its items', () => {
    renderSidebar({ activeOrgId: company.id });
    const button = header(company.name);
    expect(screen.getByRole('button', { name: company.name })).toBe(button);
    const items = document.getElementById(button.getAttribute('aria-controls') ?? '');
    expect(items?.contains(screen.getByRole('link', { name: /^My tasks/ }))).toBe(true);
  });

  test('three orgs: only the one in the URL starts open', () => {
    renderSidebar({ activeOrgId: company.id });
    expect(expanded(company.name)).toBe('true');
    expect(expanded(personal.name)).toBe('false');
    expect(expanded(club.name)).toBe('false');
    // One org's views are reachable; the collapsed ones' are hidden.
    expect(screen.getAllByRole('link', { name: /^My tasks/ })).toHaveLength(1);
  });

  test('the org in the URL defaults to `active`’s org', () => {
    renderSidebar({ active: { orgId: club.id, view: 'today' } });
    expect(expanded(club.name)).toBe('true');
    expect(expanded(company.name)).toBe('false');
  });

  test('with two orgs, every org starts open', () => {
    renderSidebar({ orgs: [personal, company] });
    expect(expanded(personal.name)).toBe('true');
    expect(expanded(company.name)).toBe('true');
  });

  test('an org that becomes the one in the URL opens; untouched, it closes again on leaving', () => {
    const { rerender, props } = renderSidebar({ activeOrgId: company.id });
    rerender(<Sidebar {...props} activeOrgId={club.id} />);
    expect(expanded(club.name)).toBe('true');
    expect(expanded(company.name)).toBe('false');
  });

  test('Enter on a header expands it for good and writes the server pref', () => {
    const { onToggleOrgCollapsed, unmount } = renderSidebar({ activeOrgId: company.id });
    press(header(club.name), 'Enter');
    expect(expanded(club.name)).toBe('true');
    expect(onToggleOrgCollapsed).toHaveBeenCalledWith(club.id, false);
    expect(localStorage.getItem(storageKeyOf(club.id))).toBe('open');
    unmount();

    // Elsewhere in the app later: still open, though it isn't the org in the URL.
    renderSidebar({ activeOrgId: personal.id });
    expect(expanded(club.name)).toBe('true');
  });

  test('Space on the URL’s org collapses it, and navigating back in keeps it collapsed', () => {
    const { onToggleOrgCollapsed, rerender, props } = renderSidebar({ activeOrgId: company.id });
    press(header(company.name), ' ');
    expect(expanded(company.name)).toBe('false');
    expect(onToggleOrgCollapsed).toHaveBeenCalledWith(company.id, true);
    expect(localStorage.getItem(storageKeyOf(company.id))).toBe('closed');
    rerender(<Sidebar {...props} activeOrgId={personal.id} />);
    rerender(<Sidebar {...props} activeOrgId={company.id} />);
    expect(expanded(company.name)).toBe('false');
  });

  test('a collapse stored on the server holds when the org is in the URL', () => {
    renderSidebar({
      orgs: fixtureMe.orgs.map((o) => ({ ...o, collapsed: o.id === company.id })),
      activeOrgId: company.id,
    });
    expect(expanded(company.name)).toBe('false');
  });

  test('a toggle shows in every copy of the sidebar (the tablet rail and its expanded copy)', () => {
    renderSidebar({ activeOrgId: company.id });
    renderSidebar({ activeOrgId: company.id });
    const headers = screen.getAllByRole('button', { name: club.name });
    expect(headers).toHaveLength(2);
    press(headers[0] as HTMLElement, 'Enter');
    for (const h of screen.getAllByRole('button', { name: club.name })) {
      expect(h.getAttribute('aria-expanded')).toBe('true');
    }
  });

  test('All organisations collapses from the keyboard, on this browser only', () => {
    const { onToggleOrgCollapsed, unmount } = renderSidebar({ activeOrgId: company.id });
    const all = screen.getByRole('button', { name: 'All organisations' });
    expect(all.getAttribute('aria-expanded')).toBe('true');
    press(all, 'Enter');
    expect(all.getAttribute('aria-expanded')).toBe('false');
    expect(
      within(screen.getByRole('region', { name: 'All organisations' })).queryByRole('link'),
    ).toBeNull();
    expect(onToggleOrgCollapsed).not.toHaveBeenCalled();
    expect(localStorage.getItem(storageKeyOf(allOrgsSectionId))).toBe('closed');
    unmount();
    renderSidebar({ activeAllView: 'today' });
    expect(
      screen.getByRole('button', { name: 'All organisations' }).getAttribute('aria-expanded'),
    ).toBe('false');
  });

  test('the "⋯" menu’s Collapse follows the same state', async () => {
    const { onToggleOrgCollapsed } = renderSidebar({ activeOrgId: company.id });
    fireEvent.click(screen.getByRole('button', { name: `${company.name} options` }));
    const menu = await screen.findByRole('menu', { name: `${company.name} options` });
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Collapse' }));
    expect(onToggleOrgCollapsed).toHaveBeenCalledWith(company.id, true);
    expect(expanded(company.name)).toBe('false');
  });

  test('every guide is the neutral border colour, coloured org or not', () => {
    renderSidebar({
      orgs: [company, { ...club, color: null }],
    });
    const items = (name: string) =>
      document.getElementById(header(name).getAttribute('aria-controls') ?? '');
    for (const name of [company.name, club.name, 'All organisations']) {
      expect(items(name)?.className).toContain('border-border');
      expect(items(name)?.className).not.toContain('border-tag-');
    }
  });

  test('hairlines between the sections: every one but the first', () => {
    renderSidebar({ activeOrgId: company.id });
    const nav = screen.getByRole('navigation', { name: 'Main' });
    const divided = within(nav)
      .getAllByRole('region')
      .map((r) => r.classList.contains('border-t'));
    expect(divided).toEqual([false, true, true, true]);
  });

  test('the rail ignores collapse: every org’s views stay reachable', () => {
    renderSidebar({ collapsed: true });
    expect(screen.getAllByRole('link', { name: /^My tasks · / })).toHaveLength(3);
  });
});
