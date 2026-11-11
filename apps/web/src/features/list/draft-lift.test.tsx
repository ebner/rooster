import type { ListOp } from '@rooster/core/reducers';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ListTransportContext } from '../../data/list';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import { useListStore } from '../../state/list-store';
import { useUndoStore } from '../../state/undo-store';
import { clearToasts, ToastRegion } from '../../ui/toast';
import { fixtureMe } from '../shell/fixtures';
import { lastAnnouncement } from './announcer';
import { longPressMs } from './gestures';
import { MyListView } from './my-list-view';
import { pressedRow } from './use-list-dnd';

/** ADR 0069: a long-press on a new row's title lifts it on touch screens. */

const userId = fixtureMe.user.id;
const orgId = '01900000-0000-7000-8000-0000000000aa';

/** A row as the list renders it, for the press gating alone. */
function rowFixture(html: string): HTMLElement {
  const host = document.createElement('div');
  host.innerHTML = html;
  document.body.append(host);
  return host;
}

describe('ADR 0069 pressedRow: which presses start a drag', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  const draft = (value: string) =>
    rowFixture(
      `<div data-row-id="d1" data-testid="task-row" data-draft="true">
         <button data-drag-handle>⋮</button><input data-list-input value="${value}">
       </div>`,
    );
  const lifts = () => true;
  const never = () => false;

  test('a touch on a new row’s title lifts it once its title makes a task', () => {
    const input = draft('Buy milk').querySelector('input') as HTMLInputElement;
    expect(pressedRow(input, 'touch', lifts)).toBe('d1');
    // A title that parses to nothing makes no task, so no drag.
    expect(pressedRow(input, 'touch', never)).toBeNull();
    // Where rows don't reorder (smart views, Everyone's tasks, a pen) there is no lift.
    expect(pressedRow(input, 'touch')).toBeNull();
  });

  test('a mouse or pen press in the title places the caret; the handle drags (ADR 0067)', () => {
    const host = draft('Buy milk');
    expect(pressedRow(host.querySelector('input'), 'pointer', lifts)).toBeNull();
    expect(pressedRow(host.querySelector('[data-drag-handle]'), 'pointer')).toBe('d1');
    const empty = draft('');
    expect(pressedRow(empty.querySelectorAll('[data-drag-handle]')[1] ?? null, 'pointer')).toBe(
      null,
    );
  });

  test('a task row drags from its body, never from its checkbox; Upcoming rows only select', () => {
    const host = rowFixture(
      `<div data-row-id="t1" data-testid="task-row">
         <span role="checkbox"></span><span data-focus-target>Title</span>
       </div>
       <div data-row-id="u1" data-testid="task-row" data-upcoming="true">
         <span data-focus-target>Water the plants</span>
       </div>
       <div data-row-id="group:g" data-testid="group-header" data-inbox="true"><h2>Inbox</h2></div>`,
    );
    const [title, upcoming] = host.querySelectorAll('[data-focus-target]');
    expect(pressedRow(title ?? null, 'pointer')).toBe('t1');
    expect(pressedRow(title ?? null, 'touch')).toBe('t1');
    expect(pressedRow(host.querySelector('[role="checkbox"]'), 'touch')).toBeNull();
    // ADR 0068: no mouse drag from Upcoming; a long-press there still selects (02 §13.2).
    expect(pressedRow(upcoming ?? null, 'pointer')).toBeNull();
    expect(pressedRow(upcoming ?? null, 'touch')).toBe('u1');
    expect(pressedRow(host.querySelector('h2'), 'touch')).toBeNull();
  });
});

async function setup() {
  const transport = createFixtureTransport({ userId, tasks: { 1: ['Alpha'], 2: ['Gamma'] } });
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
        <MyListView orgId={orgId} userId={userId} label="My tasks" />
        <ToastRegion />
      </ListTransportContext.Provider>
    </QueryClientProvider>,
  );
  await screen.findByRole('treegrid');
  return { transport, sent };
}

/** Opens a new row at the end of Today and types `title` into it. */
function typeDraft(title: string): HTMLInputElement {
  fireEvent.click(screen.getAllByRole('button', { name: 'Add task' })[0] as HTMLElement);
  const input = document.activeElement;
  if (!(input instanceof HTMLInputElement)) throw new Error('no new row');
  input.value = title;
  fireEvent.input(input);
  return input;
}

/** A touch held past the long-press on `target`; returns the release. */
async function hold(target: Element) {
  const point = { identifier: 1, target, clientX: 40, clientY: 20 };
  fireEvent.touchStart(target, { touches: [point], changedTouches: [point] });
  await act(() => new Promise((resolve) => setTimeout(resolve, longPressMs + 60)));
  return () => fireEvent.touchEnd(target, { touches: [], changedTouches: [point] });
}

describe('ADR 0069 a long-press on a new row’s title', () => {
  beforeEach(() => {
    useListStore.getState().reset();
    useUndoStore.getState().clear();
  });
  afterEach(() => {
    clearToasts();
  });

  test('creates the task as a blur would (same id, title parsed, edit over) and lifts it', async () => {
    const { sent } = await setup();
    const input = typeDraft('Buy milk #home');
    const id = input.closest<HTMLElement>('[data-row-id]')?.dataset.rowId;
    const release = await hold(input);
    // Committed once: the blur and the drag start never both create it.
    const creates = sent.filter((op) => op.kind === 'task.create');
    await waitFor(() => expect(sent.filter((op) => op.kind === 'task.create')).toHaveLength(1));
    const create = creates[0] ?? sent.find((op) => op.kind === 'task.create');
    expect(create?.kind === 'task.create' && create.payload.id).toBe(id);
    expect(create?.kind === 'task.create' && create.payload.title).toBe('Buy milk');
    expect(document.activeElement).not.toBe(input);
    expect(useListStore.getState().editing).toBeNull();
    expect(useListStore.getState().drafts).toEqual([]);
    expect(screen.getByTestId('drag-layer')).toBeTruthy();
    expect(useListStore.getState().dragging).toEqual([id]);
    // Its later touch events go to the removed input; the drag still ends with them.
    release();
    await waitFor(() => expect(screen.queryByTestId('drag-layer')).toBeNull());
    expect(lastAnnouncement()).toBe('Drop cancelled.');
    expect(sent.filter((op) => op.kind === 'task.create')).toHaveLength(1);
    expect(sent.some((op) => op.kind === 'task.move')).toBe(false);
    // dnd-kit swallows clicks for 50 ms after a drag; the next test's clicks come later.
    await act(() => new Promise((resolve) => setTimeout(resolve, 60)));
  });

  test('with an empty title, or one that parses to nothing, nothing happens', async () => {
    const { sent } = await setup();
    // Empty backticks are the escape hatch around nothing: no title, so no task (ADR 0067 §4).
    for (const title of ['', '   ', '``']) {
      const input = typeDraft(title);
      const release = await hold(input);
      expect(screen.queryByTestId('drag-layer'), JSON.stringify(title)).toBeNull();
      expect(useListStore.getState().dragging).toBeNull();
      release();
      expect(document.activeElement).toBe(input);
      expect(useListStore.getState().drafts, JSON.stringify(title)).toHaveLength(1);
      fireEvent.keyDown(input, { key: 'Escape' });
    }
    expect(sent.some((op) => op.kind === 'task.create')).toBe(false);
  });

  test('a tap in the title keeps the edit (no lift before the long-press)', async () => {
    const { sent } = await setup();
    const input = typeDraft('Buy milk');
    const point = { identifier: 1, target: input, clientX: 40, clientY: 20 };
    fireEvent.touchStart(input, { touches: [point], changedTouches: [point] });
    fireEvent.touchEnd(input, { touches: [], changedTouches: [point] });
    await act(() => new Promise((resolve) => setTimeout(resolve, longPressMs + 60)));
    expect(document.activeElement).toBe(input);
    expect(useListStore.getState().dragging).toBeNull();
    expect(sent.some((op) => op.kind === 'task.create')).toBe(false);
  });
});
