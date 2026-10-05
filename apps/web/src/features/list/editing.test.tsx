import type { ListOp } from '@rooster/core/reducers';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ListTransportContext } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import { useListStore } from '../../state/list-store';
import { useUndoStore } from '../../state/undo-store';
import { clearToasts, ToastRegion } from '../../ui/toast';
import { useKeymap } from '../../use-keymap';
import { fixtureMe } from '../shell/fixtures';
import { MyListView } from './my-list-view';

const userId = fixtureMe.user.id;
const orgId = '01900000-0000-7000-8000-0000000000aa';

function KeymapRoot() {
  useKeymap();
  return null;
}

async function setup(tasks: Record<number, string[]> = { 1: ['Alpha', 'Beta'] }) {
  const transport = createFixtureTransport({ userId, tasks });
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

/** Visible titles in list order (inputs show their current value). */
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

function type(text: string) {
  const input = activeInput();
  input.value = text;
  fireEvent.input(input);
}

function press(key: string, init: KeyboardEventInit = {}) {
  return fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });
}

function editTitle(title: string) {
  fireEvent.click(screen.getByText(title, { selector: '[data-focus-target]' }));
}

beforeEach(() => {
  useListStore.getState().reset();
  useUndoStore.getState().clear();
});

afterEach(() => {
  clearToasts();
});

describe('editing model (02 §3.4–3.5)', () => {
  test('Enter commits the draft below and opens the next one; empty drafts are never sent', async () => {
    const { sent } = await setup();
    fireEvent.click(screen.getAllByRole('button', { name: 'Add task' })[0] as HTMLElement);
    expect(titles()).toEqual(['Alpha', 'Beta', '[]']);
    type('Gamma');
    press('Enter');
    await waitFor(() => expect(titles()).toEqual(['Alpha', 'Beta', 'Gamma', '[]']));
    // Enter on the new, empty draft is a no-op.
    press('Enter');
    expect(titles()).toEqual(['Alpha', 'Beta', 'Gamma', '[]']);
    press('Escape');
    await waitFor(() => expect(titles()).toEqual(['Alpha', 'Beta', 'Gamma']));
    await waitFor(() => expect(sent.map((op) => op.kind)).toEqual(['task.create']));
    expect(sent[0]?.payload).toMatchObject({ title: 'Gamma', afterId: expect.any(String) });
  });

  test('Shift+Enter opens the new row above', async () => {
    await setup();
    editTitle('Beta');
    press('Enter', { shiftKey: true });
    expect(titles()).toEqual(['Alpha', '[]', 'Beta']);
    type('Between');
    press('Enter');
    await waitFor(() => expect(titles()).toEqual(['Alpha', 'Between', '[]', 'Beta']));
  });

  test('Backspace on an empty draft removes only that row, even with auto-repeat', async () => {
    await setup();
    editTitle('Beta');
    press('Enter');
    expect(titles()).toEqual(['Alpha', 'Beta', '[]']);
    press('Backspace');
    await waitFor(() => expect(titles()).toEqual(['Alpha', '[Beta]']));
    // The held key keeps repeating on the previous row: nothing more is deleted.
    for (let i = 0; i < 5; i++) expect(press('Backspace', { repeat: true })).toBe(false);
    expect(titles()).toEqual(['Alpha', '[Beta]']);
  });

  test('Backspace on an emptied task with unknown content keeps it and hints Tab+Delete', async () => {
    const { sent } = await setup();
    editTitle('Alpha');
    type('');
    press('Backspace');
    expect(await screen.findByText('Use Tab+Delete to delete tasks with content')).toBeTruthy();
    expect(titles()).toEqual(['[]', 'Beta']);
    expect(sent).toEqual([]);
  });

  test('a task created here and emptied is deleted by Backspace, with an undo toast', async () => {
    await setup();
    editTitle('Beta');
    press('Enter');
    type('Short-lived');
    press('Enter');
    await waitFor(() => expect(titles()).toEqual(['Alpha', 'Beta', 'Short-lived', '[]']));
    press('ArrowUp');
    await waitFor(() => expect(titles()).toEqual(['Alpha', 'Beta', '[Short-lived]']));
    type('');
    press('Backspace');
    await waitFor(() => expect(titles()).toEqual(['Alpha', '[Beta]']));
    const toast = await screen.findByText('Task deleted');
    fireEvent.click(
      within(toast.parentElement as HTMLElement).getByRole('button', { name: 'Undo' }),
    );
    await waitFor(() => expect(titles()).toContain('Short-lived'));
  });

  test('Enter on an emptied existing title restores it with a hint', async () => {
    await setup();
    editTitle('Alpha');
    type('');
    press('Enter');
    expect(activeInput().value).toBe('Alpha');
    expect(await screen.findByText('Title can’t be empty')).toBeTruthy();
  });

  test('a title ending in ":" and Enter twice becomes a group (colon-to-group)', async () => {
    const { sent } = await setup();
    editTitle('Beta');
    press('Enter');
    type('Later:');
    press('Enter');
    expect(screen.getByText('↵ again to turn into group “Later”')).toBeTruthy();
    press('Enter');
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toContain(
        'Later',
      ),
    );
    await waitFor(() => expect(sent.map((op) => op.kind)).toEqual(['group.create']));
    expect(sent[0]?.payload).toMatchObject({ name: 'Later', splitAfterTaskId: expect.any(String) });
  });

  test('a multi-line paste into an empty title offers to create one task per line', async () => {
    await setup();
    fireEvent.click(screen.getAllByRole('button', { name: 'Add task' })[0] as HTMLElement);
    fireEvent.paste(activeInput(), {
      clipboardData: { getData: () => 'One\n\nTwo\nThree fri' },
    });
    expect(screen.getByText('Create 3 tasks? ↵')).toBeTruthy();
    press('Enter');
    await waitFor(() => expect(titles()).toEqual(['Alpha', 'Beta', 'One', 'Two', 'Three']));
  });

  test('Tab+N on a task splits its group below it; Ctrl+Z undoes the split', async () => {
    await setup({ 1: ['T1', 'T2', 'T3'] });
    const row = screen.getByText('T1').closest('[data-row-id]') as HTMLElement;
    act(() => useListStore.getState().select(row.dataset.rowId as string));
    const target = screen.getByText('T1');
    fireEvent.keyDown(target, { key: 'Tab' });
    fireEvent.keyDown(target, { key: 'n' });
    fireEvent.keyUp(target, { key: 'Tab' });
    const name = await screen.findByRole('textbox', { name: 'Group name' });
    expect((name as HTMLInputElement).value).toBe('New group');
    fireEvent.keyDown(name, { key: 'Escape' });
    expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
      'Today',
      'New group',
      'Prio',
      'Upcoming',
    ]);
    expect(titles()).toEqual(['T1', 'T2', 'T3']);
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() =>
      expect(screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent)).toEqual([
        'Today',
        'Prio',
        'Upcoming',
      ]),
    );
  });
});

describe('navigate mode', () => {
  test('↑/↓ move the selection, Enter edits, Esc returns to Navigate', async () => {
    await setup();
    const alpha = screen.getByText('Alpha').closest('[data-row-id]') as HTMLElement;
    act(() => useListStore.getState().select(alpha.dataset.rowId as string));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown' });
    expect(screen.getByText('Beta').closest('[data-row-id]')?.getAttribute('aria-selected')).toBe(
      'true',
    );
    fireEvent.keyDown(document.activeElement as Element, { key: 'Enter' });
    expect(activeInput().value).toBe('Beta');
    press('Escape');
    expect(useListStore.getState().mode).toBe('navigate');
  });

  test('Delete removes the selected task with an undo toast; Ctrl+Z restores it', async () => {
    await setup();
    const alpha = screen.getByText('Alpha').closest('[data-row-id]') as HTMLElement;
    act(() => useListStore.getState().select(alpha.dataset.rowId as string));
    fireEvent.keyDown(document.activeElement as Element, { key: 'Delete' });
    await waitFor(() => expect(titles()).toEqual(['Beta']));
    expect(screen.getByText('Task deleted')).toBeTruthy();
    fireEvent.keyDown(document.body, { key: 'z', ctrlKey: true });
    await waitFor(() => expect(titles()).toEqual(['Alpha', 'Beta']));
  });

  test('Shift+↓ extends the selection and shows the bulk bar', async () => {
    await setup();
    const alpha = screen.getByText('Alpha').closest('[data-row-id]') as HTMLElement;
    act(() => useListStore.getState().select(alpha.dataset.rowId as string));
    fireEvent.keyDown(document.activeElement as Element, { key: 'ArrowDown', shiftKey: true });
    const bar = await screen.findByRole('toolbar', { name: 'Bulk actions for 2 tasks' });
    expect(within(bar).getByText('2 selected')).toBeTruthy();
    fireEvent.click(within(bar).getByRole('button', { name: 'Complete' }));
    await waitFor(() =>
      expect(screen.getAllByTestId('task-row').every((r) => r.dataset.done === 'true')).toBe(true),
    );
  });
});
