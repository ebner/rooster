import { DEFAULT_PREFS } from '@rooster/core/limits';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ListTransportContext } from '../../data/list';
import { createFixtureTransport, type FixtureTask } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import { keymap, paletteCommandIds } from '../../keymap';
import { useListStore } from '../../state/list-store';
import { useSyncStore } from '../../state/sync-store';
import { useUndoStore } from '../../state/undo-store';
import { clearToasts, ToastRegion } from '../../ui/toast';
import { useKeymap } from '../../use-keymap';
import { fixtureMe } from '../shell/fixtures';
import { ListHeaderMenu, type ListMenuView, listMenuItemIds, useListPrint } from './header-actions';
import { completeHideUntilReload, holdsUntilReload } from './hide-delay';
import { MyListView } from './my-list-view';

const userId = fixtureMe.user.id;
const orgId = '01900000-0000-7000-8000-0000000000aa';

function Root({ view }: { view: ListMenuView }) {
  useKeymap();
  useListPrint();
  return <ListHeaderMenu orgId={orgId} view={view} />;
}

async function setup({
  view = 'my',
  tasks = { 1: ['Alpha', 'Beta'], 2: ['Gamma'] },
  completeHideMs = DEFAULT_PREFS.completeHideMs,
}: {
  view?: ListMenuView;
  tasks?: Record<number, FixtureTask[]>;
  completeHideMs?: number;
} = {}) {
  const transport = createFixtureTransport({ userId, tasks });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.me, {
    ...fixtureMe,
    prefs: { ...DEFAULT_PREFS, completeHideMs },
  });
  const result = render(
    <QueryClientProvider client={queryClient}>
      <ListTransportContext.Provider value={transport}>
        <Root view={view} />
        <MyListView
          orgId={orgId}
          userId={userId}
          label="My tasks"
          {...(view === 'smart' ? { view: 'week' as const } : {})}
        />
        <ToastRegion />
      </ListTransportContext.Provider>
    </QueryClientProvider>,
  );
  await screen.findByRole('treegrid');
  return result;
}

function openMenu() {
  fireEvent.click(screen.getByTestId('list-menu'));
  return screen.getByRole('menu');
}

function groupStates(): Record<string, boolean> {
  return Object.fromEntries(
    screen
      .getAllByTestId('group-header')
      .filter((row) => !row.hasAttribute('data-inbox'))
      .map((row) => [
        row.querySelector('h2')?.textContent ?? '',
        row.getAttribute('aria-expanded') === 'true',
      ]),
  );
}

function rowTitles(): string[] {
  return screen
    .queryAllByTestId('task-row')
    .map((row) => row.querySelector('[data-focus-target]')?.textContent ?? '');
}

beforeEach(() => {
  // "Show completed" persists in localStorage; every test starts with it off.
  localStorage.clear();
  useListStore.getState().reset();
  useUndoStore.getState().clear();
  useSyncStore.setState({ online: true });
});

afterEach(() => {
  clearToasts();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('the list header ⋯ menu (02 §2)', () => {
  test('items per view: smart views have no groups, Everyone’s tasks no completed tasks', () => {
    expect(listMenuItemIds('my')).toEqual([
      'addGroup',
      'showCompleted',
      'collapseAll',
      'expandAll',
      'exportJson',
      'exportMarkdown',
      'print',
    ]);
    expect(listMenuItemIds('smart')).toEqual([
      'showCompleted',
      'exportJson',
      'exportMarkdown',
      'print',
    ]);
    expect(listMenuItemIds('everyone')).toEqual(['exportJson', 'exportMarkdown', 'print']);
  });

  test('the commands are registry entries: palette actions, and keyed ones in the cheat sheet', () => {
    for (const id of ['collapseAllGroups', 'expandAllGroups', 'printList', 'addGroupAtEnd']) {
      expect(paletteCommandIds).toContain(id);
    }
    expect(keymap.collapseAllGroups.keys).toEqual(['Shift+ArrowLeft']);
    expect(keymap.expandAllGroups.keys).toEqual(['Shift+ArrowRight']);
    expect(keymap.printList.keys).toEqual(['Mod+P']);
    expect(keymap.addGroupAtEnd.scope).toBe('palette');
  });

  test('renders the items of My tasks, with shortcut hints and a checkable Show completed', async () => {
    await setup();
    const menu = openMenu();
    expect(within(menu).getAllByRole('menuitem')).toHaveLength(6);
    const show = within(menu).getByRole('menuitemcheckbox', { name: /Show completed/ });
    expect(show.getAttribute('aria-checked')).toBe('false');
  });

  test('Show completed mirrors and flips the header toggle state', async () => {
    await setup();
    fireEvent.click(within(openMenu()).getByRole('menuitemcheckbox', { name: /Show completed/ }));
    expect(useListStore.getState().showCompleted).toBe(true);
    const show = within(openMenu()).getByRole('menuitemcheckbox', { name: /Show completed/ });
    expect(show.getAttribute('aria-checked')).toBe('true');
  });

  test('Collapse all and Expand all fold every normal group; Shift+←/→ do the same', async () => {
    await setup();
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: /Collapse all groups/ }));
    await waitFor(() => expect(Object.values(groupStates()).every((open) => !open)).toBe(true));
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: /Expand all groups/ }));
    await waitFor(() => expect(Object.values(groupStates()).every((open) => open)).toBe(true));

    // The keys, from a selected task: the cursor moves to its (now folded) group header.
    fireEvent.click(screen.getByText('Gamma'));
    act(() => useListStore.getState().navigate());
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'ArrowLeft',
      shiftKey: true,
    });
    await waitFor(() => expect(Object.values(groupStates()).every((open) => !open)).toBe(true));
    expect(useListStore.getState().cursor).toMatch(/^group:/);
    fireEvent.keyDown(document.activeElement ?? document.body, {
      key: 'ArrowRight',
      shiftKey: true,
    });
    await waitFor(() => expect(Object.values(groupStates()).every((open) => open)).toBe(true));
  });

  test('Add group adds one at the end with its name in edit', async () => {
    await setup();
    const before = screen.getAllByTestId('group-header').length;
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Add group' }));
    await waitFor(() => expect(screen.getAllByTestId('group-header')).toHaveLength(before + 1));
    const last = screen.getAllByTestId('group-header').at(-1) as HTMLElement;
    expect(last.querySelector('input')).not.toBeNull();
  });

  test('Print and Mod+P call window.print', async () => {
    const print = vi.spyOn(window, 'print').mockImplementation(() => {});
    await setup();
    expect(document.documentElement.dataset.print).toBe('list');
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: /Print/ }));
    expect(print).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(document.body, { key: 'p', ctrlKey: true });
    expect(print).toHaveBeenCalledTimes(2);
  });

  test('Export downloads JSON or Markdown, and is off while offline', async () => {
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    await setup();
    fireEvent.click(within(openMenu()).getByRole('menuitem', { name: 'Export Markdown' }));
    expect(click).toHaveBeenCalledTimes(1);
    const link = click.mock.contexts[0] as HTMLAnchorElement;
    expect(link.getAttribute('href')).toBe(`/api/v1/orgs/${orgId}/export?format=markdown`);
    expect(link.hasAttribute('download')).toBe(true);
    act(() => useSyncStore.setState({ online: false }));
    const json = within(openMenu()).getByRole('menuitem', { name: 'Export JSON' });
    expect(json.getAttribute('aria-disabled')).toBe('true');
  });

  test('a smart view offers no group items and declines the group commands', async () => {
    await setup({ view: 'smart' });
    const menu = openMenu();
    expect(within(menu).queryByRole('menuitem', { name: 'Add group' })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: /Collapse all/ })).toBeNull();
    expect(within(menu).getByRole('menuitemcheckbox', { name: /Show completed/ })).toBeTruthy();
  });
});

describe('Hide completed tasks after (FR-SET-2, 02 §3.6)', () => {
  test('until reload is the schema maximum', () => {
    expect(completeHideUntilReload).toBe(10_000);
    expect(holdsUntilReload(10_000)).toBe(true);
    expect(holdsUntilReload(3000)).toBe(false);
    expect(holdsUntilReload(0)).toBe(false);
  });

  test('a timed hold collapses the completed row', async () => {
    await setup({ completeHideMs: 3000 });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete Alpha' }));
    act(() => vi.advanceTimersByTime(2900));
    expect(rowTitles()).toContain('Alpha');
    act(() => vi.advanceTimersByTime(400));
    expect(rowTitles()).not.toContain('Alpha');
  });

  test('until reload keeps completed rows, also through an unrelated undo', async () => {
    await setup({ completeHideMs: completeHideUntilReload });
    vi.useFakeTimers();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete Alpha' }));
    act(() => vi.advanceTimersByTime(60_000));
    expect(rowTitles()).toContain('Alpha');
    expect(useListStore.getState().hiding).toEqual({
      [screen.getAllByTestId('task-row')[0]?.getAttribute('data-row-id') ?? '']: 'hold',
    });
    // Undoing another change leaves the held row alone.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Complete Beta' }));
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    act(() => vi.advanceTimersByTime(60_000));
    expect(rowTitles()).toEqual(expect.arrayContaining(['Alpha', 'Beta']));
    expect(screen.getByRole('checkbox', { name: 'Complete Beta' })).toBeTruthy();
    // Completing again during the hold reopens it.
    fireEvent.click(screen.getByRole('checkbox', { name: 'Mark Alpha incomplete' }));
    expect(useListStore.getState().hiding).toEqual({});
    expect(rowTitles()).toContain('Alpha');
  });
});
