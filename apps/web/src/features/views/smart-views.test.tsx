import { addDays, todayIn } from '@rooster/core/dates';
import { inboxOf, type ListOp, normalGroups } from '@rooster/core/reducers';
import type { SmartView } from '@rooster/core/views';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ListTransportContext } from '../../data/list';
import { createFixtureTransport, type FixtureTask } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import { useListStore } from '../../state/list-store';
import { useUndoStore } from '../../state/undo-store';
import { clearToasts, ToastRegion } from '../../ui/toast';
import { useKeymap } from '../../use-keymap';
import { MyListView } from '../list/my-list-view';
import { currentPaletteCommands } from '../palette/commands';
import type { PaneControls } from '../pane/pane-controls';
import { fixtureMe } from '../shell/fixtures';

const userId = fixtureMe.user.id;
const orgId = '01900000-0000-7000-8000-0000000000aa';
const today = todayIn(fixtureMe.user.timezone, Date.now());

function KeymapRoot() {
  useKeymap();
  return null;
}

const pane: PaneControls = {
  taskId: () => null,
  open: () => undefined,
  close: () => undefined,
  toggleFullScreen: () => undefined,
};

/** Groups: 0 Inbox, 1 Today, 2 Prio, 3 Upcoming (the fixture's defaults). */
async function setup(view: SmartView | undefined, tasks: Record<number, FixtureTask[]>) {
  const transport = createFixtureTransport({ userId, tasks });
  const sent: ListOp[] = [];
  const send = transport.send;
  transport.send = (op, org) => {
    sent.push(op);
    return send(op, org);
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.me, fixtureMe);
  const ui = (v: SmartView | undefined) => (
    <QueryClientProvider client={queryClient}>
      <ListTransportContext.Provider value={transport}>
        <KeymapRoot />
        <MyListView orgId={orgId} userId={userId} label="List" pane={pane} view={v} />
        <ToastRegion />
      </ListTransportContext.Provider>
    </QueryClientProvider>
  );
  const result = render(ui(view));
  await screen.findByRole('treegrid');
  const state = () => transport.state(orgId);
  const groupNamed = (name: string) =>
    [...normalGroups(state()), inboxOf(state())].find((g) => g?.name === name)?.id;
  const taskNamed = (title: string) => Object.values(state().tasks).find((t) => t.title === title);
  return {
    transport,
    sent,
    state,
    groupNamed,
    taskNamed,
    rerender: (v?: SmartView) => result.rerender(ui(v)),
  };
}

function titles(): string[] {
  return screen.queryAllByTestId('task-row').map((row) => {
    const input = row.querySelector('input[data-list-input]') as HTMLInputElement | null;
    return input
      ? `[${input.value}]`
      : (row.querySelector('[data-focus-target]')?.textContent ?? '');
  });
}

function activeInput(): HTMLInputElement {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement)) throw new Error('no input focused');
  return el;
}

function typeAndEnter(text: string) {
  const input = activeInput();
  input.value = text;
  fireEvent.input(input);
  fireEvent.keyDown(input, { key: 'Enter' });
}

const sections = () =>
  screen.queryAllByTestId('section-header').map((h) => h.querySelector('h2')?.textContent);

beforeEach(() => {
  useListStore.getState().reset();
  useUndoStore.getState().clear();
});

afterEach(() => {
  clearToasts();
});

const mixed: Record<number, FixtureTask[]> = {
  0: [{ title: 'Inbox today', dueDate: today }],
  1: [{ title: 'No date task' }, { title: 'Later task', dueDate: addDays(today, 3) }],
  2: [
    { title: 'Late task', dueDate: addDays(today, -2) },
    { title: 'Parent', dueDate: today, subtasks: [{ title: 'Child due', dueDate: today }] },
  ],
  3: [{ title: 'Done today', dueDate: today, completed: true }],
};

describe('smart views (02 §10, AC-5.1)', () => {
  test('Today: Overdue then Today from every group, each row with its group chip', async () => {
    await setup('today', mixed);
    expect(sections()).toEqual(['Overdue', 'Today']);
    expect(titles()).toEqual(['Late task', 'Inbox today', 'Parent', 'Child due']);
    const late = screen.getAllByTestId('task-row')[0] as HTMLElement;
    expect(within(late).getByTestId('group-chip').textContent).toContain('Prio');
    // Subtasks are flat rows with a breadcrumb.
    const child = screen.getAllByTestId('task-row')[3] as HTMLElement;
    expect(within(child).getByTestId('row-breadcrumb')).toBeTruthy();
    // No drag handles: smart views are derived orders.
    expect(screen.queryAllByRole('button', { name: /^Drag/ })).toHaveLength(0);
  });

  test('AC-5.1 creating in Today sets due = today and lands in the Inbox', async () => {
    const { taskNamed, groupNamed, sent } = await setup('today', mixed);
    const todaySection = screen.getAllByRole('button', { name: 'Add task' });
    // Only the Today section takes adds (none under Overdue).
    expect(todaySection).toHaveLength(1);
    fireEvent.click(todaySection[0] as HTMLElement);
    typeAndEnter('Call the bank');
    await waitFor(() => expect(taskNamed('Call the bank')).toBeDefined());
    const task = taskNamed('Call the bank');
    expect(task?.dueDate).toBe(today);
    expect(task?.placement?.groupId).toBe(groupNamed('Inbox'));
    expect(sent.find((op) => op.kind === 'task.create')?.payload).toMatchObject({
      dueDate: today,
      groupId: groupNamed('Inbox'),
    });
    // Enter opened the next draft in the same section.
    expect(titles()).toContain('[]');
  });

  test('`>Group` places the task in that group (prefix match) and a date phrase still wins', async () => {
    const { taskNamed, groupNamed } = await setup('today', mixed);
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    typeAndEnter('Buy stamps >pri tomorrow');
    await waitFor(() => expect(taskNamed('Buy stamps')).toBeDefined());
    const task = taskNamed('Buy stamps');
    expect(task?.placement?.groupId).toBe(groupNamed('Prio'));
    expect(task?.dueDate).toBe(addDays(today, 1));
  });

  test('an unknown `>name` stays in the title', async () => {
    const { taskNamed, groupNamed } = await setup('nodate', mixed);
    fireEvent.click(screen.getByRole('button', { name: 'Add task' }));
    typeAndEnter('Compare a >nothing');
    await waitFor(() => expect(taskNamed('Compare a >nothing')).toBeDefined());
    expect(taskNamed('Compare a >nothing')?.placement?.groupId).toBe(groupNamed('Inbox'));
    expect(taskNamed('Compare a >nothing')?.dueDate).toBeNull();
  });

  test('Next 7 days lists every day; adding under a day gives it that date', async () => {
    const { taskNamed } = await setup('week', mixed);
    const names = sections();
    expect(names).toHaveLength(7);
    expect(names.slice(0, 2)).toEqual(['Today', 'Tomorrow']);
    const adds = screen.getAllByRole('button', { name: 'Add task' });
    expect(adds).toHaveLength(7);
    fireEvent.click(adds[4] as HTMLElement);
    typeAndEnter('Pack the bags');
    await waitFor(() => expect(taskNamed('Pack the bags')?.dueDate).toBe(addDays(today, 4)));
  });

  test('Overdue has no inline add; an empty view shows its empty state', async () => {
    await setup('overdue', { 1: [{ title: 'Undated' }] });
    expect(screen.getByTestId('view-empty').textContent).toContain('Nothing overdue');
    expect(screen.queryByRole('button', { name: 'Add task' })).toBeNull();
    // N and Q do nothing either.
    act(() => {
      fireEvent.keyDown(document.body, { key: 'q' });
    });
    expect(titles()).toEqual([]);
  });

  test('AC-5.1 completing in Today completes the task in My tasks too', async () => {
    const { taskNamed, rerender } = await setup('today', mixed);
    const row = screen.getAllByTestId('task-row')[1] as HTMLElement;
    fireEvent.click(within(row).getByRole('checkbox'));
    await waitFor(() => expect(taskNamed('Inbox today')?.completedAt).not.toBeNull());
    rerender(undefined);
    await waitFor(() => expect(screen.queryByText('Inbox today')).toBeNull());
  });

  test('Show completed adds completed tasks to their sections', async () => {
    await setup('today', mixed);
    expect(titles()).not.toContain('Done today');
    act(() => useListStore.getState().set({ showCompleted: true }));
    await waitFor(() => expect(titles()).toContain('Done today'));
  });
});

describe('Make subtask of… (ADR 0008)', () => {
  test('re-parents the selection through the pipeline with one undo step', async () => {
    const { taskNamed, sent } = await setup(undefined, {
      1: ['Alpha', 'Beta', 'Gamma'],
    });
    const beta = taskNamed('Beta')?.id as string;
    const gamma = taskNamed('Gamma')?.id as string;
    const alpha = taskNamed('Alpha')?.id as string;
    act(() => useListStore.getState().selectRange([beta, gamma], gamma));
    await waitFor(() => expect(currentPaletteCommands()?.selectedTaskIds).toHaveLength(2));
    act(() => currentPaletteCommands()?.makeSubtaskOf?.(alpha));
    await waitFor(() => expect(taskNamed('Beta')?.parentId).toBe(alpha));
    expect(taskNamed('Gamma')?.parentId).toBe(alpha);
    expect(sent.filter((op) => op.kind === 'task.patch').map((op) => op.payload)).toEqual([
      { parentId: alpha },
      { parentId: alpha },
    ]);
    expect(useUndoStore.getState().undo).toHaveLength(1);
  });

  test('a task never becomes a subtask of itself or of its own descendant', async () => {
    const { taskNamed, sent } = await setup(undefined, {
      1: [{ title: 'Root', expanded: true, subtasks: ['Leaf'] }],
    });
    const root = taskNamed('Root')?.id as string;
    const leaf = taskNamed('Leaf')?.id as string;
    act(() => useListStore.getState().select(root));
    await waitFor(() => expect(currentPaletteCommands()?.selectedTaskIds).toEqual([root]));
    act(() => currentPaletteCommands()?.makeSubtaskOf?.(leaf));
    act(() => currentPaletteCommands()?.makeSubtaskOf?.(root));
    expect(sent.filter((op) => op.kind === 'task.patch')).toEqual([]);
    expect(await screen.findAllByText(/can’t become a subtask of itself/)).toHaveLength(2);
  });
});
