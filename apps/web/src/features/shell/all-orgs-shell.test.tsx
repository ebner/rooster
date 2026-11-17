import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Org } from '../../data/types';
import { mobileQuery } from '../../ui/use-media';
import { longPressMs } from '../list/gestures';
import { AppShell, type MobileShell, ViewHeader } from './app-shell';
import { fixtureMe } from './fixtures';
import { allOrgsOptionId } from './org-switcher';

const orgs = fixtureMe.orgs;
const [personal] = orgs as [Org, Org, Org];

/** A phone viewport: only the mobile query matches. */
function phone() {
  vi.stubGlobal('matchMedia', (media: string) => ({
    matches: media === mobileQuery,
    media,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }));
}

function renderPhone(mobile: Partial<MobileShell> = {}) {
  const shell: MobileShell = {
    orgs,
    activeOrg: null,
    isAdmin: false,
    onSelectOrg: vi.fn(),
    allOrgs: { active: true, onSelect: vi.fn() },
    onCreateOrg: vi.fn(async () => undefined),
    onSignOut: vi.fn(),
    nav: null,
    ...mobile,
  };
  render(
    <AppShell renderSidebar={() => null} mobile={shell}>
      <ViewHeader title="Today" mobile={{ switcher: true }} />
    </AppShell>,
  );
  return shell;
}

beforeEach(() => phone());

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('the phone shell on All organisations (ADR 0073 A7, 02 §13.1)', () => {
  test('the header switcher shows All organisations instead of an org', () => {
    renderPhone();
    const switcher = screen.getByTestId('org-switcher');
    expect(switcher.getAttribute('aria-label')).toBe('All organisations, switch organisation');
    expect(within(switcher).getByText('All organisations').className).toContain('truncate');
    // Personal is only the next stop, waiting off to the side for a swipe.
    expect(within(switcher).getByText(personal.name).closest('[aria-hidden]')).not.toBeNull();
  });

  test('the sheet opens with All organisations first and checked', () => {
    renderPhone();
    fireEvent.click(screen.getByTestId('org-switcher'));
    const sheet = screen.getByTestId('org-sheet');
    const first = sheet.querySelector('[data-org-option]');
    expect(first?.getAttribute('data-org-option')).toBe(allOrgsOptionId);
    expect(first?.getAttribute('aria-pressed')).toBe('true');
  });

  test('the ⋯ menu leaves out Organisation settings (no org here)', async () => {
    renderPhone();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Organisation settings' })).toBeNull();
    expect(within(menu).getByRole('menuitem', { name: 'Sign out' })).toBeTruthy();
  });

  test('on an org screen the ⋯ menu keeps Organisation settings', async () => {
    renderPhone({ activeOrg: personal, allOrgs: { active: false, onSelect: vi.fn() } });
    expect(screen.getByTestId('org-switcher').textContent).toContain(personal.name);
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Organisation settings' })).toBeTruthy();
  });

  test('press-and-slide onto All organisations selects it', () => {
    vi.useFakeTimers();
    const shell = renderPhone({
      activeOrg: personal,
      allOrgs: { active: false, onSelect: vi.fn() },
    });
    const switcher = screen.getByTestId('org-switcher');
    const at = (y: number) => ({
      pointerId: 1,
      pointerType: 'touch',
      isPrimary: true,
      clientX: 100,
      clientY: y,
    });
    fireEvent.pointerDown(switcher, at(20));
    act(() => vi.advanceTimersByTime(longPressMs));
    const option = screen
      .getByTestId('org-sheet')
      .querySelector(`[data-org-option="${allOrgsOptionId}"]`);
    document.elementFromPoint = vi.fn(() => option);
    fireEvent.pointerMove(switcher, at(300));
    fireEvent.pointerUp(switcher, at(300));
    expect(shell.allOrgs?.onSelect).toHaveBeenCalledOnce();
    expect(shell.onSelectOrg).not.toHaveBeenCalled();
  });

  test('with a single org nothing about All organisations shows', () => {
    renderPhone({ orgs: [personal], activeOrg: personal, allOrgs: null });
    fireEvent.click(screen.getByTestId('org-switcher'));
    expect(screen.queryByRole('button', { name: 'All organisations' })).toBeNull();
  });
});
