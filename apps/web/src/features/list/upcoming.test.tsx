import { addDays, todayIn, weekdayOf } from '@rooster/core/dates';
import type { ListOp } from '@rooster/core/reducers';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ListTransportContext } from '../../data/list';
import { createFixtureTransport, type FixtureTask } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import { sessionDataCleared } from '../../data/session-events';
import { userStorageKey } from '../../lib/user-storage';
import { upcomingRowId, useListStore } from '../../state/list-store';
import { useUndoStore } from '../../state/undo-store';
import { clearToasts, ToastRegion } from '../../ui/toast';
import { useKeymap } from '../../use-keymap';
import { fixtureMe } from '../shell/fixtures';
import { lastAnnouncement } from './announcer';
import { MyListView } from './my-list-view';

/** ADR 0068: the Upcoming section of My tasks, in the component. */

const userId = fixtureMe.user.id;
const orgId = '01900000-0000-7000-8000-0000000000aa';
const zone = fixtureMe.user.timezone;
const today = () => todayIn(zone, Date.now());
const storageKey = userStorageKey(userId, `list.upcomingOpen.${orgId}`);

function KeymapRoot() {
  useKeymap();
  return null;
}

async function setup(tasks: Record<number, FixtureTask[]>) {
  const transport = createFixtureTransport({ userId, tasks, timezone: zone });
  const sent: ListOp[] = [];
  const send = transport.send;
  transport.send = (op, org) => {
    sent.push(op);
    return send(op, org);
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.me, fixtureMe);
  render(
    <QueryClientProvider client={queryClient}>
      <ListTransportContext.Provider value={transport}>
        <KeymapRoot />
        <MyListView orgId={orgId} userId={userId} label="My tasks" />
        <ToastRegion />
      </ListTransportContext.Provider>
    </QueryClientProvider>,
  );
  await screen.findByRole('treegrid');
  return { transport, sent };
}

const rows = () => screen.queryAllByTestId('task-row');
const titles = () =>
  rows().map((row) => {
    const input = row.querySelector('input[data-list-input]') as HTMLInputElement | null;
    return input
      ? `[${input.value}]`
      : (row.querySelector('[data-focus-target]')?.textContent ?? '');
  });
const row = (title: string) =>
  rows().find((r) => r.querySelector('[data-focus-target]')?.textContent === title) as HTMLElement;
const header = () => screen.getByTestId('upcoming-header');
const idOf = (title: string) => row(title).dataset.rowId as string;
const key = (k: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key: k, ...init });
const moves = (sent: readonly ListOp[]) =>
  sent.filter((op) => op.kind === 'task.move' || op.kind === 'task.bulk');

/** Today: A, Water plants (weekly, next week), B; Prio: Bins (weekly, in 3 days). */
const sample = (): Record<number, FixtureTask[]> => ({
  1: [
    'Alpha',
    { title: 'Water plants', dueDate: addDays(today(), 7), recurrence: 'FREQ=WEEKLY' },
    'Beta',
  ],
  2: [{ title: 'Bins', dueDate: addDays(today(), 3), recurrence: 'FREQ=WEEKLY' }],
});

beforeEach(() => {
  useListStore.getState().reset();
  useUndoStore.getState().clear();
  localStorage.clear();
  sessionDataCleared();
});

afterEach(() => {
  clearToasts();
});

describe('ADR 0068 Upcoming', () => {
  test('folded at the end with its count; a click opens it, sorted by date, and it stays open', async () => {
    await setup(sample());
    expect(titles()).toEqual(['Alpha', 'Beta']);
    expect(header().getAttribute('aria-expanded')).toBe('false');
    expect(header().getAttribute('aria-label')).toBe('Recurring, 2 tasks');
    // Group counts leave Upcoming out.
    const today = screen.getAllByTestId('group-header')[0] as HTMLElement;
    expect(today.getAttribute('aria-label')).toBe('Today, group, 2 tasks');

    fireEvent.click(within(header()).getByRole('heading'));
    await waitFor(() => expect(titles()).toEqual(['Alpha', 'Beta', 'Bins', 'Water plants']));
    expect(header().getAttribute('aria-expanded')).toBe('true');
    expect(localStorage.getItem(storageKey)).toBe('1');
    // Rows show the group they go back to and their date, and have no drag handle.
    const bins = row('Bins');
    expect(bins.dataset.upcoming).toBe('true');
    expect(within(bins).getByTestId('group-chip').textContent).toContain('Prio');
    expect(bins.querySelector('[data-drag-handle]')).toBeNull();
    expect(bins.getAttribute('aria-label')).toMatch(/^Bins, due /);
    expect(row('Alpha').querySelector('[data-drag-handle]')).not.toBeNull();

    fireEvent.click(within(header()).getByRole('button', { name: 'Collapse Recurring' }));
    await waitFor(() => expect(titles()).toEqual(['Alpha', 'Beta']));
    expect(localStorage.getItem(storageKey)).toBeNull();
  });

  test('←/→ on its header fold and open it; ↑/↓ reach it and its rows', async () => {
    await setup(sample());
    act(() => useListStore.getState().select(idOf('Beta')));
    // The last row: Upcoming's header (after the default groups, the last named "Upcoming" too).
    key('End');
    expect(useListStore.getState().cursor).toBe(upcomingRowId);
    key('ArrowRight');
    await waitFor(() => expect(header().getAttribute('aria-expanded')).toBe('true'));
    key('ArrowDown');
    expect(useListStore.getState().cursor).toBe(idOf('Bins'));
    key('ArrowUp');
    key('ArrowLeft');
    await waitFor(() => expect(header().getAttribute('aria-expanded')).toBe('false'));
    expect(titles()).toEqual(['Alpha', 'Beta']);
  });

  test('its rows do not move, add rows or take new rows; Enter in Edit only commits', async () => {
    localStorage.setItem(storageKey, '1');
    const { sent } = await setup(sample());
    await waitFor(() => expect(titles()).toContain('Bins'));
    const bins = idOf('Bins');
    act(() => useListStore.getState().select(bins));

    key('ArrowUp', { ctrlKey: true });
    expect(lastAnnouncement()).toBe(
      'Tasks in Recurring can’t be moved. Change the date to bring one back.',
    );
    key('n');
    expect(useListStore.getState().drafts).toEqual([]);
    expect(lastAnnouncement()).toBe('New tasks can’t be added to Recurring');
    key('s');
    expect(useListStore.getState().drafts).toEqual([]);
    key('m');
    expect(useListStore.getState().popover).toBeNull();

    key('Enter');
    const input = document.activeElement as HTMLInputElement;
    input.value = 'Bins out';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(titles()).toContain('Bins out'));
    expect(useListStore.getState().drafts).toEqual([]);
    expect(useListStore.getState().mode).toBe('navigate');
    expect(moves(sent)).toEqual([]);
  });

  test('a date of today brings a task back to its group, at its own place, without a move', async () => {
    localStorage.setItem(storageKey, '1');
    const { sent } = await setup(sample());
    await waitFor(() => expect(titles()).toContain('Water plants'));
    fireEvent.click(row('Water plants').querySelector('[data-focus-target]') as HTMLElement);
    const input = document.activeElement as HTMLInputElement;
    input.value = 'Water plants today';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(titles()).toEqual(['Alpha', 'Water plants', 'Beta', 'Bins']));
    expect(row('Water plants').dataset.upcoming).toBeUndefined();
    expect(moves(sent)).toEqual([]);
  });

  test('a later date sends a repeating task to Recurring: a toast says so, the cursor moves on', async () => {
    const { transport } = await setup({
      1: ['Alpha', { title: 'Standup', dueDate: today(), recurrence: 'FREQ=DAILY' }, 'Beta'],
    });
    expect(screen.queryByTestId('upcoming-header')).toBeNull();
    fireEvent.click(row('Standup').querySelector('[data-focus-target]') as HTMLElement);
    const input = document.activeElement as HTMLInputElement;
    input.value = 'Standup tomorrow';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(titles()).toEqual(['Alpha', 'Beta']));
    expect(await screen.findByText('“Standup” is in Recurring until tomorrow')).toBeTruthy();
    expect(header().getAttribute('aria-label')).toBe('Recurring, 1 task');
    // The folded row hands the cursor to its neighbour.
    expect(useListStore.getState().cursor).toBe(idOf('Beta'));
    const standup = Object.values(transport.state(orgId).tasks).find((t) => t.title === 'Standup');
    expect(standup?.recurrence).toMatch(/^FREQ=DAILY/);
  });

  test('a new task with a future repeat goes to Recurring, with a toast; the next row stays in place', async () => {
    await setup({ 1: ['Alpha', 'Beta'] });
    fireEvent.click(row('Alpha').querySelector('[data-focus-target]') as HTMLElement);
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Enter' });
    const input = document.activeElement as HTMLInputElement;
    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'][
      weekdayOf(addDays(today(), 1))
    ];
    input.value = `Gym every ${weekday}`;
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(screen.getByTestId('upcoming-header')).toBeTruthy());
    expect(await screen.findByText('“Gym” is in Recurring until tomorrow')).toBeTruthy();
    // The next new row opens where Gym was typed, not at the end of the group.
    expect(titles()).toEqual(['Alpha', '[]', 'Beta']);
  });

  test('the open state is per user and org, and forgotten when the session ends', async () => {
    await setup(sample());
    fireEvent.click(within(header()).getByRole('heading'));
    await waitFor(() => expect(header().getAttribute('aria-expanded')).toBe('true'));
    expect(
      Object.keys(localStorage).filter((k) => k.startsWith(`rooster.user.${userId}.`)),
    ).toEqual([storageKey]);
    act(() => {
      localStorage.clear();
      sessionDataCleared();
    });
    await waitFor(() => expect(header().getAttribute('aria-expanded')).toBe('false'));
  });
});
