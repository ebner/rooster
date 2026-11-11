import { addDays, todayIn, weekdayOf } from '@rooster/core/dates';
import type { ListOp } from '@rooster/core/reducers';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ListTransportContext } from '../../data/list';
import { createFixtureTransport, type FixtureTask } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import { useListStore } from '../../state/list-store';
import { useUndoStore } from '../../state/undo-store';
import { clearToasts, ToastRegion } from '../../ui/toast';
import { useKeymap } from '../../use-keymap';
import { fixtureMe } from '../shell/fixtures';
import { MyListView } from './my-list-view';

const userId = fixtureMe.user.id;
const orgId = '01900000-0000-7000-8000-0000000000aa';
const zone = fixtureMe.user.timezone;
const today = () => todayIn(zone, Date.now());
const weekdayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

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
const row = (title: string, index = 0) =>
  rows().filter((r) => r.querySelector('[data-focus-target]')?.textContent === title)[
    index
  ] as HTMLElement;

function select(title: string) {
  fireEvent.click(row(title).querySelector('[data-focus-target]')?.parentElement as HTMLElement);
  fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
}

beforeEach(() => {
  useListStore.getState().reset();
  useUndoStore.getState().clear();
});

afterEach(() => {
  clearToasts();
});

describe('recurring tasks (FR-REC)', () => {
  test('AC-10.1, ADR 0068 completing a weekly task makes the next instance, in Recurring until its day; undo removes it', async () => {
    const { sent, transport } = await setup({
      1: [{ title: 'Water plants', dueDate: today(), recurrence: 'FREQ=WEEKLY' }, 'Other'],
    });
    const checkbox = within(row('Water plants')).getByRole('checkbox');
    fireEvent.click(checkbox);
    await waitFor(() => expect(sent.some((op) => op.kind === 'task.complete')).toBe(true));
    const complete = sent.find((op) => op.kind === 'task.complete');
    expect(complete?.kind === 'task.complete' && complete.payload.nextId).toBeTruthy();
    // The held original, then the rest: the next instance (due in a week) waits in Upcoming,
    // folded at the end, and the toast says so.
    expect(titles()).toEqual(['Water plants', 'Other']);
    const upcoming = screen.getByTestId('upcoming-header');
    expect(upcoming.getAttribute('aria-expanded')).toBe('false');
    expect(upcoming.getAttribute('aria-label')).toBe('Recurring, 1 task');
    expect(
      await screen.findByText(/^Completed “Water plants” · Next: \S.* · in Recurring$/),
    ).toBeTruthy();
    const nextId = complete?.kind === 'task.complete' ? complete.payload.nextId : undefined;
    const next = transport.state(orgId).tasks[nextId as string];
    expect(next?.dueDate).toBe(addDays(today(), 7));
    expect(next?.completedAt).toBeNull();
    // Its place is still directly below the completed one (ADR 0049 §1.4).
    const original = Object.values(transport.state(orgId).tasks).find(
      (t) => t.title === 'Water plants' && t.id !== nextId,
    );
    expect((next?.placement?.position ?? '') > (original?.placement?.position ?? '')).toBe(true);

    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(transport.state(orgId).tasks[nextId as string]).toBeUndefined());
    expect(titles()).toEqual(['Water plants', 'Other']);
    expect(screen.queryByTestId('upcoming-header')).toBeNull();
  });

  test('FR-REC-4 Delete asks; "this task" skips, so the series goes on', async () => {
    const { sent } = await setup({
      1: [{ title: 'Standup', dueDate: today(), recurrence: 'FREQ=DAILY' }, 'Other'],
    });
    select('Standup');
    fireEvent.keyDown(document.body, { key: 'Delete' });
    const prompt = await screen.findByTestId('recurring-delete');
    expect(within(prompt).getByTestId('recurring-delete-this')).toBe(document.activeElement);
    fireEvent.click(within(prompt).getByTestId('recurring-delete-this'));
    await waitFor(() => expect(sent.some((op) => op.kind === 'task.skip')).toBe(true));
    expect(sent.some((op) => op.kind === 'task.delete')).toBe(false);
    // Tomorrow's instance waits in Upcoming (ADR 0068).
    expect(titles()).toEqual(['Other']);
    expect(screen.getByTestId('upcoming-header').getAttribute('aria-label')).toBe(
      'Recurring, 1 task',
    );
    expect(
      await screen.findByText(
        'Task deleted · the series continues · Next: Tomorrow · in Recurring',
      ),
    ).toBeTruthy();
  });

  test('FR-REC-4 "this and following" is a plain delete; Esc cancels', async () => {
    const { sent } = await setup({
      1: [{ title: 'Standup', dueDate: today(), recurrence: 'FREQ=DAILY' }, 'Other'],
    });
    select('Standup');
    fireEvent.keyDown(document.body, { key: 'Delete' });
    await screen.findByTestId('recurring-delete');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByTestId('recurring-delete')).toBeNull());
    expect(titles()).toEqual(['Standup', 'Other']);

    select('Standup');
    fireEvent.keyDown(document.body, { key: 'Delete' });
    fireEvent.click(await screen.findByTestId('recurring-delete-following'));
    await waitFor(() => expect(sent.some((op) => op.kind === 'task.delete')).toBe(true));
    expect(titles()).toEqual(['Other']);
  });

  test('02 §8.1 "after done" in an edited title changes only the basis of the same rule', async () => {
    const { sent, transport } = await setup({
      1: [{ title: 'Standup', dueDate: today(), recurrence: 'FREQ=DAILY' }],
    });
    fireEvent.click(screen.getByText('Standup', { selector: '[data-focus-target]' }));
    const input = document.activeElement as HTMLInputElement;
    input.value = 'Standup every day after done';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sent.some((op) => op.kind === 'task.patch')).toBe(true));
    const patch = sent.find((op) => op.kind === 'task.patch');
    expect(patch?.payload).toMatchObject({
      recurrence: 'FREQ=DAILY',
      recurrenceBasis: 'completion',
    });
    const task = Object.values(transport.state(orgId).tasks).find((t) => t.title === 'Standup');
    expect(task?.recurrenceBasis).toBe('completion');
  });

  test('the row shows the repeat icon with the rule as its tooltip', async () => {
    await setup({ 1: [{ title: 'Review', dueDate: today(), recurrence: 'FREQ=WEEKLY' }] });
    const icon = within(row('Review')).getByTestId('repeat-indicator');
    expect(icon.getAttribute('title')).toBe(
      `Repeats: Weekly on ${weekdayNames[weekdayOf(today())]}`,
    );
  });
});

describe('reminders (FR-REM)', () => {
  test('FR-REM-4 the bell names the next reminder; attachments show their count', async () => {
    await setup({
      1: [
        {
          title: 'Call Bob',
          dueDate: addDays(today(), 1),
          dueTime: '14:00',
          dueTz: zone,
          reminders: [60],
        },
        { title: 'Files', attachments: 2 },
        'Plain',
      ],
    });
    const bell = within(row('Call Bob')).getByTestId('reminder-indicator');
    expect(bell.getAttribute('title')).toMatch(/^Reminder: Tomorrow 1(3:00|:00 PM)$/);
    expect(within(bell).getByText(/^Reminder:/).className).toContain('sr-only');
    expect(within(row('Files')).getByTestId('attachment-count').textContent).toContain('2');
    expect(within(row('Plain')).queryByTestId('reminder-indicator')).toBeNull();
    expect(within(row('Plain')).queryByTestId('attachment-count')).toBeNull();
  });

  test('02 §8.1 a new task reads a recurrence phrase and `!1d`', async () => {
    const { sent } = await setup({ 1: ['Alpha'] });
    fireEvent.click(screen.getAllByRole('button', { name: 'Add task' })[0] as HTMLElement);
    const input = document.activeElement as HTMLInputElement;
    input.value = 'Pay rent every month !1d';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sent.some((op) => op.kind === 'task.create')).toBe(true));
    const create = sent.find((op) => op.kind === 'task.create');
    if (create?.kind !== 'task.create') throw new Error('no create');
    expect(create.payload.title).toBe('Pay rent');
    expect(create.payload.recurrence).toMatch(/^FREQ=MONTHLY/);
    expect(create.payload.reminders).toEqual([{ offsetMinutes: 1440 }]);
    await waitFor(() =>
      expect(within(row('Pay rent')).getByTestId('reminder-indicator')).toBeTruthy(),
    );
  });

  test('02 §8.1 `!1h` on a task with a due date adds a reminder; without one it stays text', async () => {
    const { sent } = await setup({ 1: [{ title: 'Dated', dueDate: today() }, 'Undated'] });
    fireEvent.click(screen.getByText('Dated', { selector: '[data-focus-target]' }));
    let input = document.activeElement as HTMLInputElement;
    input.value = 'Dated !1h';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(sent.some((op) => op.kind === 'reminder.create')).toBe(true));
    const create = sent.find((op) => op.kind === 'reminder.create');
    expect(create?.kind === 'reminder.create' && create.payload).toMatchObject({
      offsetMinutes: 60,
    });
    expect(titles()).toContain('Dated');
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: 'Escape' });

    fireEvent.click(screen.getByText('Undated', { selector: '[data-focus-target]' }));
    input = document.activeElement as HTMLInputElement;
    input.value = 'Undated !1h';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(titles()).toContain('Undated !1h'));
  });

  test('ADR 0049 §2.2 clearing the date says the reminders are paused', async () => {
    await setup({ 1: [{ title: 'Call Bob', dueDate: addDays(today(), 2), reminders: [60] }] });
    const cell = within(row('Call Bob')).getByRole('button', { name: /^Due date/ });
    fireEvent.keyDown(cell, { key: 'Delete' });
    expect(await screen.findByText('Date cleared · reminders paused')).toBeTruthy();
  });
});
