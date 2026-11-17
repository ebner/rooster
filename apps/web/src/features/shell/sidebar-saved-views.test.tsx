import type { SavedViewMove } from '@rooster/core/schemas';
import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, test, vi } from 'vitest';
import type { Org } from '../../data/types';
import { useKeymap, useKeymapHandlers } from '../../use-keymap';
import { FixedSavedViews } from '../views/view-counts';
import { useViewTabs } from '../views/view-tabs';
import { fixtureMe } from './fixtures';
import { sampleSavedView } from './saved-views-kitchen';
import { Sidebar, type SidebarProps } from './sidebar';
import { SidebarSavedViews, type SidebarSavedViewsProps } from './sidebar-saved-views';
import { orgListViewOf } from './sidebar-views';

const [personal, company] = fixtureMe.orgs as [Org, Org, Org];
const juniper = sampleSavedView(1, 'Juniper', {
  tags: ['0192f5d0-7a1e-7c3a-9f10-0000000000f1'],
  openCount: 7,
});
const mine = sampleSavedView(2, 'Mine this week', { shared: false, openCount: 3 });
const launch = sampleSavedView(3, 'Launch', {
  tags: ['0192f5d0-7a1e-7c3a-9f10-0000000000f2'],
  openCount: 0,
});
const views = [juniper, mine, launch];

const nextTick = () => act(() => new Promise((resolve) => setTimeout(resolve, 0)));

function renderViews(overrides: Partial<SidebarSavedViewsProps> = {}) {
  const onMove = vi.fn<(id: string, intent: SavedViewMove) => unknown>();
  const result = render(
    <SidebarSavedViews
      orgName={company.name}
      slug={company.slug}
      views={views}
      activeViewId={null}
      onMove={onMove}
      {...overrides}
    />,
  );
  return { onMove, ...result };
}

/** jsdom has no layout: each view row gets a 32 px slot in list order. */
function mockViewLayout(order: () => readonly string[]) {
  const original = Element.prototype.getBoundingClientRect;
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    const row = this.closest('[data-view-id]');
    if (!row) return original.call(this);
    const top = order().indexOf(row.getAttribute('data-view-id') ?? '') * 32;
    return {
      x: 0,
      y: top,
      top,
      left: 0,
      right: 248,
      bottom: top + 32,
      width: 248,
      height: 32,
      toJSON: () => ({}),
    } as DOMRect;
  });
}

const names = () =>
  within(screen.getByRole('list', { name: `Views in ${company.name}` }))
    .getAllByRole('link')
    .map((link) => link.textContent);

describe('the sidebar views part (ADR 0073 B9)', () => {
  afterEach(() => vi.restoreAllMocks());

  test('lists the views in the given order with open counts, icons and links', () => {
    renderViews();
    const list = screen.getByRole('list', { name: `Views in ${company.name}` });
    const links = within(list).getAllByRole('link');
    expect(links.map((l) => [l.textContent, l.getAttribute('href')])).toEqual([
      ['Juniper7', `/o/northwind/v/${juniper.id}`],
      ['Mine this week3', `/o/northwind/v/${mine.id}`],
      ['Launch', `/o/northwind/v/${launch.id}`],
    ]);
    // `#` for a project view (exactly one tag), ⌕ otherwise.
    const rows = list.querySelectorAll('[data-view-id]');
    expect([...rows].map((row) => row.hasAttribute('data-project'))).toEqual([true, false, true]);
    expect(screen.getByRole('link', { name: 'New view' }).getAttribute('href')).toBe(
      '/o/northwind/v/new',
    );
  });

  test('without views only a quiet "New view" shows', () => {
    renderViews({ views: [] });
    expect(screen.queryByRole('list')).toBeNull();
    const add = screen.getByRole('link', { name: 'New view' });
    expect(add.className).toContain('text-text-muted');
  });

  test('marks the view shown, or "New view" while a new one is open', () => {
    const { rerender, onMove } = renderViews({ activeViewId: mine.id });
    expect(screen.getByRole('link', { name: /^Mine this week/ }).getAttribute('aria-current')).toBe(
      'page',
    );
    expect(screen.getByRole('link', { name: 'New view' }).getAttribute('aria-current')).toBeNull();
    rerender(
      <SidebarSavedViews
        orgName={company.name}
        slug={company.slug}
        views={views}
        activeViewId="new"
        onMove={onMove}
      />,
    );
    expect(screen.getByRole('link', { name: 'New view' }).getAttribute('aria-current')).toBe(
      'page',
    );
  });

  test('AC-13.3 a keyboard drag moves a view in the member’s own order, with announcements', async () => {
    mockViewLayout(() => views.map((v) => v.id));
    const { onMove } = renderViews();
    onMove.mockImplementation(() => new Promise(() => {}));
    const grip = screen.getByRole('button', { name: 'Reorder Launch' });
    grip.focus();
    fireEvent.keyDown(grip, { code: 'Space', key: ' ' });
    await nextTick();
    expect(await screen.findByText('Picked up Launch. Position 3 of 3.')).toBeTruthy();
    fireEvent.keyDown(grip, { code: 'ArrowUp', key: 'ArrowUp' });
    await nextTick();
    fireEvent.keyDown(grip, { code: 'Space', key: ' ' });
    await nextTick();
    expect(onMove).toHaveBeenCalledWith(launch.id, { afterId: juniper.id, beforeId: mine.id });
    // Shown at once, before the server's order comes back.
    expect(names()).toEqual(['Juniper7', 'Launch', 'Mine this week3']);
  });

  test('while a view is lifted, the arrows and Space never reach the list', async () => {
    mockViewLayout(() => views.map((v) => v.id));
    const selectPrevious = vi.fn();
    const peekPane = vi.fn();
    function ListKeys() {
      useKeymap();
      useKeymapHandlers({ selectPrevious, peekPane });
      return null;
    }
    render(<ListKeys />);
    renderViews();
    const grip = screen.getByRole('button', { name: 'Reorder Launch' });
    grip.focus();
    fireEvent.keyDown(grip, { code: 'Space', key: ' ' });
    await nextTick();
    fireEvent.keyDown(grip, { code: 'ArrowUp', key: 'ArrowUp' });
    await nextTick();
    fireEvent.keyDown(grip, { code: 'Space', key: ' ' });
    await nextTick();
    expect(selectPrevious).not.toHaveBeenCalled();
    expect(peekPane).not.toHaveBeenCalled();
    // Not lifted, the sidebar's buttons leave the list keys alone as before.
    fireEvent.keyDown(grip, { code: 'ArrowUp', key: 'ArrowUp' });
    expect(selectPrevious).toHaveBeenCalledTimes(1);
  });

  test('a failed move puts the view back', async () => {
    mockViewLayout(() => views.map((v) => v.id));
    const { onMove } = renderViews();
    onMove.mockRejectedValue(new Error('offline'));
    const grip = screen.getByRole('button', { name: 'Reorder Juniper' });
    grip.focus();
    fireEvent.keyDown(grip, { code: 'Space', key: ' ' });
    await nextTick();
    fireEvent.keyDown(grip, { code: 'ArrowDown', key: 'ArrowDown' });
    await nextTick();
    fireEvent.keyDown(grip, { code: 'Space', key: ' ' });
    await nextTick();
    expect(onMove).toHaveBeenCalledWith(juniper.id, { afterId: mine.id, beforeId: launch.id });
    await nextTick();
    expect(names()).toEqual(['Juniper7', 'Mine this week3', 'Launch']);
  });

  test('the server’s next list replaces the shown order', async () => {
    mockViewLayout(() => views.map((v) => v.id));
    const { onMove, rerender } = renderViews();
    onMove.mockResolvedValue(undefined);
    const grip = screen.getByRole('button', { name: 'Reorder Juniper' });
    grip.focus();
    fireEvent.keyDown(grip, { code: 'Space', key: ' ' });
    await nextTick();
    fireEvent.keyDown(grip, { code: 'ArrowDown', key: 'ArrowDown' });
    await nextTick();
    fireEvent.keyDown(grip, { code: 'Space', key: ' ' });
    await nextTick();
    expect(names()).toEqual(['Mine this week3', 'Juniper7', 'Launch']);
    // Another member's change arrives first (SSE): the server's list wins.
    rerender(
      <SidebarSavedViews
        orgName={company.name}
        slug={company.slug}
        views={[launch, juniper, mine]}
        activeViewId={null}
        onMove={onMove}
      />,
    );
    expect(names()).toEqual(['Launch', 'Juniper7', 'Mine this week3']);
  });

  test('the rail shows the views as icons named with the org, without "New view"', () => {
    renderViews({ rail: true });
    expect(screen.getByRole('link', { name: `Juniper · ${company.name}` })).toBeTruthy();
    expect(screen.queryByRole('link', { name: 'New view' })).toBeNull();
  });
});

describe('the views part in the sidebar', () => {
  function renderSidebar(overrides: Partial<SidebarProps> = {}) {
    render(
      <Sidebar
        user={fixtureMe.user}
        orgs={fixtureMe.orgs}
        locale="en"
        collapsed={false}
        onReorder={() => {}}
        onToggleOrgCollapsed={() => {}}
        onCreateOrg={() => {}}
        onLocaleChange={() => {}}
        onSignOut={() => {}}
        savedViews={{ [company.id]: views }}
        {...overrides}
      />,
    );
  }

  test('follows Everyone’s tasks in its own org; every org offers "New view"', () => {
    renderSidebar();
    const org = screen.getByRole('region', { name: company.name });
    const links = within(org)
      .getAllByRole('link')
      .map((l) => l.textContent);
    expect(links.slice(5)).toEqual([
      "Everyone's tasks",
      'Juniper7',
      'Mine this week3',
      'Launch',
      'New view',
    ]);
    const own = within(screen.getByRole('region', { name: personal.name }));
    expect(own.queryByRole('list', { name: `Views in ${personal.name}` })).toBeNull();
    expect(own.getByRole('link', { name: 'New view' }).getAttribute('href')).toBe(
      '/o/personal/v/new',
    );
  });

  test('marks the active view of the active org only', () => {
    renderSidebar({ active: { orgId: company.id, view: null, savedViewId: juniper.id } });
    const org = within(screen.getByRole('region', { name: company.name }));
    expect(org.getByRole('link', { name: /^Juniper/ }).getAttribute('aria-current')).toBe('page');
    expect(org.getByRole('link', { name: /^My tasks/ }).getAttribute('aria-current')).toBeNull();
  });

  test('a collapsed org hides its views too', () => {
    renderSidebar({ orgs: fixtureMe.orgs.map((o) => ({ ...o, collapsed: o.id === company.id })) });
    const org = screen.getByRole('region', { name: company.name });
    expect(within(org).queryByRole('link', { name: /^Juniper/ })).toBeNull();
  });
});

describe('the phone’s view switcher (ADR 0073 B12)', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <FixedSavedViews views={{ [company.id]: views }}>{children}</FixedSavedViews>
  );

  test('lists the org’s views after Everyone, the shown one current', () => {
    const { result } = renderHook(() => useViewTabs(company, 'northwind', null, mine.id), {
      wrapper,
    });
    expect(result.current.map((tab) => tab.label)).toEqual([
      'My tasks',
      'Today',
      '7 days',
      'Overdue',
      'No date',
      'Everyone',
      'Juniper',
      'Mine this week',
      'Launch',
    ]);
    expect(result.current.filter((tab) => tab.isActive).map((tab) => tab.href)).toEqual([
      `/o/northwind/v/${mine.id}`,
    ]);
  });

  test('a view’s `v:<id>` key (the list view under the pane too) marks its tab', () => {
    const { result } = renderHook(() => useViewTabs(company, 'northwind', `v:${launch.id}`), {
      wrapper,
    });
    expect(result.current.filter((tab) => tab.isActive).map((tab) => tab.label)).toEqual([
      'Launch',
    ]);
  });

  test('a built-in view stays current when no view is shown', () => {
    const { result } = renderHook(() => useViewTabs(company, 'northwind', 'today'), { wrapper });
    expect(result.current.filter((tab) => tab.isActive).map((tab) => tab.id)).toEqual(['today']);
  });
});

describe('orgListViewOf', () => {
  test('a built-in view, a view (also under the pane) and "New view"', () => {
    expect(orgListViewOf('/o/northwind/today', 'today')).toEqual({
      view: 'today',
      savedViewId: null,
    });
    expect(orgListViewOf(`/o/northwind/v/${juniper.id}`, `v:${juniper.id}`)).toEqual({
      view: null,
      savedViewId: juniper.id,
    });
    expect(orgListViewOf('/o/northwind/t/abc', `v:${juniper.id}`)).toEqual({
      view: null,
      savedViewId: juniper.id,
    });
    expect(orgListViewOf('/o/northwind/v/new', null)).toEqual({ view: null, savedViewId: 'new' });
    expect(orgListViewOf('/inbox', null)).toEqual({ view: null, savedViewId: null });
  });
});
