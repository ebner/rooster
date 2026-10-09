import type { ListOp } from '@rooster/core/reducers';
import type { Task } from '@rooster/core/schemas';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, test } from 'vitest';
import { seedEveryone } from '../../data/everyone';
import { ListTransportContext } from '../../data/list';
import { createFixtureTransport, type FixtureTask } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import type { OrgMember } from '../../data/types';
import { useListStore } from '../../state/list-store';
import { useUndoStore } from '../../state/undo-store';
import { clearToasts, ToastRegion } from '../../ui/toast';
import { useKeymap } from '../../use-keymap';
import { memberSectionId } from '../people/everyone-model';
import { fixtureMe } from '../shell/fixtures';
import { MyListView } from './my-list-view';

const userId = fixtureMe.user.id;
const orgId = '01900000-0000-7000-8000-0000000000aa';
const anna = '01900000-0000-7000-8000-0000000000b1';

const members: OrgMember[] = [
  { userId, name: 'Jannik Lunde', email: 'jannik@example.com', image: null, role: 'owner' },
  { userId: anna, name: 'Anna Lindqvist', email: 'anna@example.com', image: null, role: 'member' },
];

function KeymapRoot() {
  useKeymap();
  return null;
}

async function setup(
  options: {
    tasks?: Record<number, FixtureTask[]>;
    shared?: boolean;
    everyone?: readonly Task[];
  } = {},
) {
  const { tasks = { 1: ['Alpha', 'Beta'] }, shared = true } = options;
  const transport = createFixtureTransport({ userId, tasks, members });
  const sent: ListOp[] = [];
  const send = transport.send;
  transport.send = (op, org) => {
    sent.push(op);
    return send(op, org);
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.me, fixtureMe);
  queryClient.setQueryData(queryKeys.orgMembers(orgId), members);
  if (options.everyone) seedEveryone(queryClient, orgId, options.everyone);
  render(
    <QueryClientProvider client={queryClient}>
      <ListTransportContext.Provider value={transport}>
        <KeymapRoot />
        <MyListView
          orgId={orgId}
          userId={userId}
          label="My tasks"
          shared={shared}
          everyone={options.everyone !== undefined}
        />
        <ToastRegion />
      </ListTransportContext.Provider>
    </QueryClientProvider>,
  );
  await screen.findByRole('treegrid');
  return { transport, sent, queryClient };
}

function titles(): string[] {
  return screen
    .queryAllByTestId('task-row')
    .map((row) => row.querySelector('[data-focus-target]')?.textContent ?? '');
}

function selectRow(title: string) {
  const row = screen.getByText(title, { selector: '[data-focus-target]' }).closest('[data-row-id]');
  act(() => useListStore.getState().select((row as HTMLElement).dataset.rowId as string));
}

function activeInput(): HTMLInputElement {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement)) throw new Error('no input focused');
  return el;
}

beforeEach(() => {
  useListStore.getState().reset();
  useUndoStore.getState().clear();
  clearToasts();
});

describe('assigning (FR-COL-1)', () => {
  test('AC-6.1 A opens the picker; Anna takes the task out of My tasks; Ctrl+Z brings it back', async () => {
    const { sent } = await setup();
    selectRow('Alpha');
    fireEvent.keyDown(document.activeElement as Element, { key: 'a' });
    const picker = await screen.findByTestId('assignee-picker');
    const filter = within(picker).getByRole('combobox', { name: 'Filter people' });
    fireEvent.change(filter, { target: { value: 'anna' } });
    fireEvent.keyDown(filter, { key: 'Enter' });
    await waitFor(() => expect(titles()).toEqual(['Beta']));
    expect(
      await screen.findByText('Assigned to Anna Lindqvist · moved to their Inbox'),
    ).toBeTruthy();
    expect(sent.find((op) => op.kind === 'task.patch')?.payload).toEqual({ assigneeId: anna });
    // The selection moves on, as after a delete.
    expect(useListStore.getState().cursor).toBe(
      screen.getByText('Beta').closest('[data-row-id]')?.getAttribute('data-row-id'),
    );
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(titles()).toEqual(['Alpha', 'Beta']));
  });

  test('Tab+A on a multi-selection sends one bulk assign; Unassigned is a choice', async () => {
    const { sent } = await setup();
    selectRow('Alpha');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown', shiftKey: true });
    const target = document.activeElement as Element;
    fireEvent.keyDown(target, { key: 'Tab' });
    fireEvent.keyDown(target, { key: 'a' });
    fireEvent.keyUp(target, { key: 'Tab' });
    const picker = await screen.findByTestId('assignee-picker');
    fireEvent.click(within(picker).getByRole('option', { name: /Unassigned/ }));
    await waitFor(() => expect(titles()).toEqual([]));
    const bulk = sent.find((op) => op.kind === 'task.bulk');
    expect(bulk?.payload).toMatchObject({ op: 'assign', args: { assigneeId: null } });
    expect(screen.getByText('2 tasks unassigned')).toBeTruthy();
  });

  test('the bulk bar has Assign in a shared org', async () => {
    await setup();
    selectRow('Alpha');
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown', shiftKey: true });
    const bar = await screen.findByRole('toolbar', { name: 'Bulk actions for 2 tasks' });
    fireEvent.click(within(bar).getByRole('button', { name: 'Assign' }));
    expect(await screen.findByTestId('assignee-picker')).toBeTruthy();
  });

  test('@name on a new task assigns it on create: "Added to Anna’s Inbox"', async () => {
    const { sent } = await setup();
    fireEvent.click(screen.getAllByRole('button', { name: 'Add task' })[0] as Element);
    const input = activeInput();
    input.value = 'Call the bank @an';
    input.setSelectionRange(17, 17);
    fireEvent.input(input);
    const suggest = await screen.findByTestId('member-suggest');
    expect(within(suggest).getByRole('option', { name: 'Anna Lindqvist' })).toBeTruthy();
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('Call the bank @Anna ');
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(sent.some((op) => op.kind === 'task.create')).toBe(true));
    const create = sent.find((op) => op.kind === 'task.create');
    expect(create?.payload).toMatchObject({ title: 'Call the bank', assigneeId: anna });
    expect(await screen.findByText('Added to Anna Lindqvist’s Inbox')).toBeTruthy();
    expect(titles()).toEqual(['Alpha', 'Beta']);
  });
});

describe('FR-COL-6: a personal org shows no assignment', () => {
  test('A and Tab+A do nothing, @name stays text, the bulk bar has no Assign', async () => {
    const { sent } = await setup({ shared: false });
    selectRow('Alpha');
    fireEvent.keyDown(document.activeElement as Element, { key: 'a' });
    expect(screen.queryByTestId('assignee-picker')).toBeNull();
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown', shiftKey: true });
    const bar = await screen.findByRole('toolbar', { name: 'Bulk actions for 2 tasks' });
    expect(within(bar).queryByRole('button', { name: 'Assign' })).toBeNull();
    act(() => useListStore.getState().select(null));
    fireEvent.click(screen.getAllByRole('button', { name: 'Add task' })[0] as Element);
    const input = activeInput();
    input.value = 'Call @anna';
    fireEvent.input(input);
    expect(screen.queryByTestId('member-suggest')).toBeNull();
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(sent.some((op) => op.kind === 'task.create')).toBe(true));
    expect(sent.find((op) => op.kind === 'task.create')?.payload).toMatchObject({
      title: 'Call @anna',
    });
    expect(screen.queryAllByTestId('row-assignee')).toEqual([]);
  });
});

describe("Everyone's tasks (02 §11)", () => {
  function remote(id: string, title: string, overrides: Partial<Task> = {}): Task {
    return {
      id,
      orgId,
      seq: 9,
      parentId: null,
      subtaskPosition: null,
      title,
      assigneeId: anna,
      createdBy: anna,
      dueDate: null,
      dueTime: null,
      dueTz: null,
      startDate: null,
      completedAt: null,
      tagIds: [],
      hasDescription: false,
      counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
      placement: null,
      createdAt: 1,
      updatedAt: 1,
      ...overrides,
    };
  }
  const annaTask = remote('01900000-0000-7000-8000-0000000000c1', 'Anna writes');
  const loose = remote('01900000-0000-7000-8000-0000000000c2', 'Nobody yet', {
    assigneeId: null,
  });

  test('sections per assignee with avatars; A reassigns with undo', async () => {
    const { sent } = await setup({ tasks: { 1: [] }, everyone: [annaTask, loose] });
    const sections = screen.getAllByTestId('member-section');
    expect(sections.map((s) => s.dataset.assignee)).toEqual([userId, anna, 'none']);
    expect(sections.map((s) => s.querySelector('h2')?.textContent)).toEqual([
      'Jannik Lunde(you)',
      'Anna Lindqvist',
      'Unassigned',
    ]);
    expect(screen.getAllByTestId('row-assignee').map((a) => a.dataset.userId)).toEqual([anna]);
    selectRow('Nobody yet');
    fireEvent.keyDown(document.activeElement as Element, { key: 'a' });
    const picker = await screen.findByTestId('assignee-picker');
    fireEvent.click(within(picker).getByRole('option', { name: /Anna Lindqvist/ }));
    await waitFor(() =>
      expect(sent.find((op) => op.kind === 'task.patch')?.payload).toEqual({ assigneeId: anna }),
    );
    // Undo is computed from the Everyone rows, though the task was never in My tasks.
    const undo = useUndoStore.getState().undo.at(-1);
    expect(undo?.inverseOps).toEqual([
      expect.objectContaining({ kind: 'task.patch', payload: { assigneeId: null } }),
    ]);
  });

  test('inline add under a member creates the task for them', async () => {
    const { sent } = await setup({ tasks: { 1: [] }, everyone: [annaTask] });
    const add = screen
      .getAllByRole('button', { name: 'Add task' })
      .find((b) => b.closest('[data-row-id]')?.getAttribute('data-row-id')?.includes(anna));
    fireEvent.click(add as Element);
    const input = activeInput();
    input.value = 'Prepare the demo';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(sent.some((op) => op.kind === 'task.create')).toBe(true));
    const create = sent.find((op) => op.kind === 'task.create');
    expect(create?.payload).toMatchObject({ title: 'Prepare the demo', assigneeId: anna });
    expect(create?.payload).not.toHaveProperty('groupId');
    expect(await screen.findByText('Added to Anna Lindqvist’s Inbox')).toBeTruthy();
    expect(useListStore.getState().drafts).toEqual([]);
    expect(memberSectionId(anna)).toBe(`member:${anna}`);
  });
});
