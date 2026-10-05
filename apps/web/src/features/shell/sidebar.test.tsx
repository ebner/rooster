import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import type { Org, OrgReorderIntent } from '../../data/types';
import { AppShell } from './app-shell';
import { fixtureMe } from './fixtures';
import { Sidebar, type SidebarProps } from './sidebar';
import { sidebarStorageKey } from './use-sidebar-collapsed';

const orgs = fixtureMe.orgs;
const [personal, company, club] = orgs as [Org, Org, Org];

function renderSidebar(overrides: Partial<SidebarProps> = {}) {
  const onReorder = vi.fn<(intent: OrgReorderIntent) => void>();
  render(
    <Sidebar
      user={fixtureMe.user}
      orgs={orgs}
      locale="en"
      collapsed={false}
      onToggleCollapsed={() => {}}
      onReorder={onReorder}
      onToggleOrgCollapsed={() => {}}
      onCreateOrg={() => {}}
      onLocaleChange={() => {}}
      onSignOut={() => {}}
      {...overrides}
    />,
  );
  return { onReorder };
}

/** jsdom has no layout: give each org section a 100 px tall slot in sidebar order. */
function mockSectionLayout() {
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const section = this.closest('[data-org-id]');
    if (!section) return original.call(this);
    const index = orgs.findIndex((o) => o.id === section.getAttribute('data-org-id'));
    const top = index * 100;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 248,
      bottom: top + 100,
      width: 248,
      height: 100,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

const nextTick = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

describe('Sidebar org reordering', () => {
  afterEach(() => vi.restoreAllMocks());

  test('AC-1.5 a keyboard drag emits afterId (above) and beforeId (below) per 06 §1', async () => {
    mockSectionLayout();
    const { onReorder } = renderSidebar();
    const handle = screen.getByRole('button', { name: `Reorder ${club.name}` });
    handle.focus();
    // Lift Book club (3rd), move it up one position, drop.
    fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
    await nextTick();
    fireEvent.keyDown(handle, { code: 'ArrowUp', key: 'ArrowUp' });
    await nextTick();
    fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
    await nextTick();
    expect(onReorder).toHaveBeenCalledWith({
      orgId: club.id,
      afterId: personal.id,
      beforeId: company.id,
    });
  });

  test('the live region announces pick-up with the position', async () => {
    mockSectionLayout();
    renderSidebar();
    const handle = screen.getByRole('button', { name: `Reorder ${company.name}` });
    handle.focus();
    fireEvent.keyDown(handle, { code: 'Space', key: ' ' });
    await nextTick();
    expect(await screen.findByText(`Picked up ${company.name}. Position 2 of 3.`)).toBeTruthy();
    fireEvent.keyDown(handle, { code: 'Escape', key: 'Escape' });
    await nextTick();
  });

  test('"Move down" in the org menu is the non-drag alternative', async () => {
    const { onReorder } = renderSidebar();
    fireEvent.click(screen.getByRole('button', { name: `${personal.name} options` }));
    const menu = await screen.findByRole('menu', { name: `${personal.name} options` });
    expect(
      within(menu).getByRole('menuitem', { name: 'Move up' }).getAttribute('aria-disabled'),
    ).toBe('true');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Move down' }));
    expect(onReorder).toHaveBeenCalledWith({
      orgId: personal.id,
      afterId: company.id,
      beforeId: club.id,
    });
  });
});

describe('Sidebar rail', () => {
  beforeEach(() => localStorage.clear());

  function renderShell() {
    return render(
      <AppShell
        renderSidebar={({ collapsed, onToggleCollapsed, inDrawer }) =>
          inDrawer ? null : (
            <Sidebar
              user={fixtureMe.user}
              orgs={orgs}
              locale="en"
              collapsed={collapsed}
              onToggleCollapsed={onToggleCollapsed}
              onReorder={() => {}}
              onToggleOrgCollapsed={() => {}}
              onCreateOrg={() => {}}
              onLocaleChange={() => {}}
              onSignOut={() => {}}
            />
          )
        }
      >
        <p>content</p>
      </AppShell>,
    );
  }

  test('collapsing to the rail persists across a remount', () => {
    const first = renderShell();
    fireEvent.click(screen.getByRole('button', { name: 'Collapse sidebar' }));
    expect(localStorage.getItem(sidebarStorageKey)).toBe('1');
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
    first.unmount();

    renderShell();
    expect(screen.getByRole('button', { name: 'Expand sidebar' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Collapse sidebar' })).toBeNull();
  });

  test('Ctrl+\\ toggles the rail', () => {
    renderShell();
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', ctrlKey: true });
    expect(localStorage.getItem(sidebarStorageKey)).toBe('1');
    fireEvent.keyDown(window, { key: '\\', code: 'Backslash', ctrlKey: true });
    expect(localStorage.getItem(sidebarStorageKey)).toBe('0');
  });
});
