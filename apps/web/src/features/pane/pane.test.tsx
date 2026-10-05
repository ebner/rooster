import type { ListOp } from '@rooster/core/reducers';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { useMemo, useRef, useState } from 'react';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';
import { ListTransportContext } from '../../data/list';
import { createFixtureTransport, type FixtureOptions } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import { useListStore } from '../../state/list-store';
import { usePaneStore } from '../../state/pane-store';
import { useUndoStore } from '../../state/undo-store';
import { clearToasts, ToastRegion } from '../../ui/toast';
import { useKeymap } from '../../use-keymap';
import { MyListView } from '../list/my-list-view';
import { fixtureMe } from '../shell/fixtures';
import { DetailPane } from './detail-pane';
import { SplitView } from './split-view';
import { createPaneControls, focusListCursor } from './tasks-screen';

const userId = fixtureMe.user.id;
const orgId = '01900000-0000-7000-8000-0000000000aa';

function KeymapRoot() {
  useKeymap();
  return null;
}

interface Nav {
  href: string;
  replace: boolean;
}

/** TasksScreen without the router: the URL is a recorded list of navigations. */
function Harness({ navs }: { navs: Nav[] }) {
  const [taskId, setTaskId] = useState<string | null>(null);
  const ref = useRef<string | null>(null);
  ref.current = taskId;
  const pane = useMemo(
    () =>
      createPaneControls({
        current: () => ref.current,
        setCurrent: (id) => {
          ref.current = id;
          setTaskId(id);
        },
        go: (href, replace) => navs.push({ href, replace }),
        orgSlug: 'personal',
        focusList: focusListCursor,
      }),
    [navs],
  );
  return (
    <SplitView
      label="Task details"
      list={<MyListView orgId={orgId} userId={userId} label="My tasks" pane={pane} />}
      pane={
        taskId ? (
          <DetailPane
            orgId={orgId}
            orgSlug="personal"
            userId={userId}
            taskId={taskId}
            pane={pane}
            fullScreen={false}
            onFocusList={focusListCursor}
          />
        ) : null
      }
    />
  );
}

async function setup(options: Partial<FixtureOptions> = {}) {
  const transport = createFixtureTransport({
    userId,
    tasks: { 1: ['Alpha', 'Beta'] },
    ...options,
  });
  const sent: ListOp[] = [];
  const send = transport.send;
  transport.send = (op, org) => {
    sent.push(op);
    return send(op, org);
  };
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  queryClient.setQueryData(queryKeys.me, fixtureMe);
  queryClient.setQueryData(queryKeys.orgMembers(orgId), []);
  const navs: Nav[] = [];
  render(
    <QueryClientProvider client={queryClient}>
      <ListTransportContext.Provider value={transport}>
        <KeymapRoot />
        <Harness navs={navs} />
        <ToastRegion />
      </ListTransportContext.Provider>
    </QueryClientProvider>,
  );
  await screen.findByRole('treegrid', { name: 'My tasks' });
  return { transport, sent, navs };
}

const list = () => screen.getByRole('treegrid', { name: 'My tasks' });
const rowOf = (title: string) =>
  within(list())
    .getAllByTestId('task-row')
    .find((r) => r.querySelector('[data-focus-target]')?.textContent === title) as HTMLElement;
const titleOf = (title: string) => rowOf(title).querySelector('[data-focus-target]') as HTMLElement;
const press = (key: string, init: KeyboardEventInit = {}) =>
  fireEvent.keyDown(document.activeElement ?? document.body, { key, ...init });

function activeInput(): HTMLInputElement {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement)) throw new Error('no input focused');
  return el;
}

function type(text: string) {
  const input = activeInput();
  input.value = text;
  input.setSelectionRange(text.length, text.length);
  fireEvent.input(input);
}

beforeEach(() => {
  useListStore.getState().reset();
  useUndoStore.getState().clear();
  usePaneStore.setState({ fullScreen: false, focus: null });
});

afterEach(() => clearToasts());

describe('detail pane (02 §9)', () => {
  test('a row body click opens the pane with focus kept in the list; ↓ follows with replace', async () => {
    const { transport, navs } = await setup();
    const alpha = Object.values(transport.state(orgId).tasks).find((t) => t.title === 'Alpha');
    fireEvent.click(rowOf('Alpha'));
    const title = await screen.findByTestId('pane-title');
    expect(title).toHaveProperty('value', 'Alpha');
    expect(navs).toEqual([{ href: `/o/personal/t/${alpha?.id}`, replace: false }]);
    await waitFor(() => expect(document.activeElement).toBe(titleOf('Alpha')));
    press('ArrowDown');
    await waitFor(() => expect(screen.getByTestId('pane-title')).toHaveProperty('value', 'Beta'));
    expect(navs.at(-1)?.replace).toBe(true);
  });

  test('O focuses the pane title; Esc returns focus to the row; Esc again closes', async () => {
    const { navs } = await setup();
    fireEvent.click(rowOf('Beta'));
    await screen.findByTestId('pane-title');
    await waitFor(() => expect(document.activeElement).toBe(titleOf('Beta')));
    press('o');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('pane-title')));
    press('Escape');
    await waitFor(() => expect(document.activeElement).toBe(titleOf('Beta')));
    expect(screen.getByTestId('detail-pane')).toBeTruthy();
    press('Escape');
    await waitFor(() => expect(screen.queryByTestId('detail-pane')).toBeNull());
    expect(navs.at(-1)).toEqual({ href: '/o/personal/my', replace: true });
  });

  test('the pane title commits on Enter through the pipeline, with undo', async () => {
    const { sent } = await setup();
    fireEvent.click(rowOf('Alpha'));
    const title = (await screen.findByTestId('pane-title')) as HTMLTextAreaElement;
    title.focus();
    fireEvent.change(title, { target: { value: 'Alpha  renamed ' } });
    fireEvent.keyDown(title, { key: 'Enter' });
    await waitFor(() => expect(titleOf('Alpha renamed')).toBeTruthy());
    await waitFor(() => expect(sent.map((op) => op.kind)).toContain('task.patch'));
    expect(sent.find((op) => op.kind === 'task.patch')?.payload).toEqual({
      title: 'Alpha renamed',
    });
    expect(useUndoStore.getState().undo.at(-1)?.label).toBe('Task edited');
  });

  test('Enter in a pane subtask creates a sibling under the pane task', async () => {
    const { sent, transport } = await setup({
      tasks: { 1: [{ title: 'Parent', subtasks: ['First', 'Second'] }] },
    });
    const parent = Object.values(transport.state(orgId).tasks).find((t) => t.title === 'Parent');
    fireEvent.click(rowOf('Parent'));
    const subtasks = await screen.findByRole('treegrid', { name: 'Subtasks' });
    const first = within(subtasks).getByText('First');
    fireEvent.click(first);
    press('Enter');
    type('Between');
    press('Enter');
    press('Escape');
    await waitFor(() =>
      expect(
        within(subtasks)
          .getAllByTestId('task-row')
          .map((r) => r.textContent),
      ).toEqual(['First', 'Between', 'Second']),
    );
    const create = sent.find((op) => op.kind === 'task.create');
    expect(create?.payload).toMatchObject({ title: 'Between', parentId: parent?.id });
    await waitFor(() => expect(screen.getByTestId('pane-subtask-count').textContent).toBe('0/3'));
  });
});

describe('subtasks in the list (02 §3.1)', () => {
  test('Enter in an expanded subtask creates a sibling subtask, and → / ← walk the tree', async () => {
    const { sent, transport } = await setup({
      tasks: { 1: [{ title: 'Parent', expanded: true, subtasks: ['One', 'Two'] }, 'After'] },
    });
    const parent = Object.values(transport.state(orgId).tasks).find((t) => t.title === 'Parent');
    const one = Object.values(transport.state(orgId).tasks).find((t) => t.title === 'One');
    expect(rowOf('One').getAttribute('aria-level')).toBe('3');
    fireEvent.click(titleOf('One'));
    press('Enter');
    type('Sibling');
    press('Enter');
    press('Escape');
    await waitFor(() => expect(rowOf('Sibling').getAttribute('aria-level')).toBe('3'));
    expect(sent.find((op) => op.kind === 'task.create')?.payload).toMatchObject({
      parentId: parent?.id,
      afterId: one?.id,
    });
    act(() => useListStore.getState().select(parent?.id as string));
    press('ArrowLeft');
    await waitFor(() => expect(rowOf('Parent').getAttribute('aria-expanded')).toBe('false'));
    expect(sent.at(-1)).toMatchObject({ kind: 'task.expanded', payload: { expanded: false } });
    press('ArrowRight');
    await waitFor(() => expect(rowOf('Parent').getAttribute('aria-expanded')).toBe('true'));
    press('ArrowRight');
    await waitFor(() => expect(useListStore.getState().cursor).toBe(one?.id));
  });
});

describe('#tag tokens (02 §3.4)', () => {
  test('autocomplete completes a known tag; committing tags the task and creates new names', async () => {
    const { sent, transport } = await setup({ tags: [{ name: 'urgent' }] });
    const urgent = transport.tags(orgId)[0];
    fireEvent.click(screen.getAllByRole('button', { name: 'Add task' })[0] as HTMLElement);
    type('Fix login #ur');
    const options = await screen.findByRole('listbox', { name: 'Tag suggestions' });
    expect(within(options).getAllByRole('option')[0]?.textContent).toBe('urgent');
    press('Enter');
    expect(activeInput().value).toBe('Fix login #urgent ');
    type('Fix login #urgent #brandnew');
    // The suggestion for an unknown name is "Create …"; Escape dismisses it.
    press('Escape');
    press('Enter');
    press('Escape');
    await waitFor(() => expect(sent.some((op) => op.kind === 'task.create')).toBe(true));
    const create = sent.find((op) => op.kind === 'task.create');
    expect(create?.payload).toMatchObject({
      title: 'Fix login',
      tagIds: [urgent?.id],
      tagNames: ['brandnew'],
    });
    await waitFor(() =>
      expect(rowOf('Fix login').querySelector('[data-tag-chips]')?.textContent).toContain(
        'brandnew',
      ),
    );
  });
});
