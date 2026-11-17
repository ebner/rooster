import type { ListOp } from '@rooster/core/reducers';
import { listOps } from '@rooster/core/reducers';
import type { SavedView, SavedViewQuery } from '@rooster/core/schemas';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  act,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
  within,
} from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { ApiError } from '../../data/errors';
import { getListPipeline, ListTransportContext } from '../../data/list';
import { createFixtureTransport, type FixtureTask } from '../../data/pipeline/fixture-transport';
import { queryKeys } from '../../data/query-keys';
import { sessionDataCleared } from '../../data/session-events';
import type { Org, OrgMember } from '../../data/types';
import { viewTasksKey } from '../../data/view-tasks';
import { useListStore } from '../../state/list-store';
import { useUndoStore } from '../../state/undo-store';
import { clearToasts, ToastRegion } from '../../ui/toast';
import { useKeymap } from '../../use-keymap';
import { fixtureMe } from '../shell/fixtures';
import { emptyViewQuery } from './query';
import { useSaveAsView } from './save-as-view';
import { SavedViewContent } from './saved-view-screen';

/** ADR 0073 B4–B7 (AC-13.3 in the component): a view's rows, header, inline add. */

const env = vi.hoisted(() => ({
  navigate: vi.fn(),
  update: vi.fn(async (vars: { id: string; patch: unknown }): Promise<unknown> => vars),
  create: vi.fn(async (input: { id: string; name: string }) => input),
  archive: vi.fn(async (vars: unknown) => vars),
  remove: vi.fn(async (id: string) => id),
}));

vi.mock('@tanstack/react-router', async (actual) => ({
  ...(await actual<typeof import('@tanstack/react-router')>()),
  useNavigate: () => env.navigate,
  useLocation: () => ({ pathname: '/o/kestrel/v/gone' }),
}));

vi.mock('../../data/views', async (actual) => ({
  ...(await actual<typeof import('../../data/views')>()),
  useUpdateView: () => ({ mutateAsync: env.update, isPending: false }),
  useCreateView: () => ({ mutateAsync: env.create, isPending: false }),
  useArchiveView: () => ({ mutateAsync: env.archive, isPending: false }),
  useDeleteView: () => ({ mutateAsync: env.remove, isPending: false }),
}));

const userId = fixtureMe.user.id;
const orgId = '01900000-0000-7000-8000-0000000000aa';
const anna = '01900000-0000-7000-8000-0000000000b1';
const markus = '01900000-0000-7000-8000-0000000000b2';
const viewId = '01900000-0000-7000-8000-0000000000c1';

const members: OrgMember[] = [
  { userId, name: 'Jannik Lunde', email: 'jannik@example.com', image: null, role: 'owner' },
  { userId: anna, name: 'Anna Lindqvist', email: 'anna@example.com', image: null, role: 'member' },
  { userId: markus, name: 'Markus Berg', email: 'markus@example.com', image: null, role: 'member' },
];

const sharedOrg: Org = {
  id: orgId,
  slug: 'kestrel',
  name: 'Kestrel Lane',
  isPersonal: false,
  avatarEmoji: null,
  color: 'blue',
  role: 'member',
  collapsed: false,
};

/** The viewer, a member of the shared org (late answers check the membership). */
const meIn = { ...fixtureMe, orgs: [...fixtureMe.orgs, sharedOrg] };

function KeymapRoot() {
  useKeymap();
  return null;
}

const defaultTasks: Record<number, FixtureTask[]> = {
  0: [
    { title: 'Mine juniper', tags: ['juniper'], dueDate: '2030-01-10' },
    { title: 'Anna juniper', tags: ['juniper'], assignee: anna },
    { title: 'Untagged' },
    { title: 'Fika plan', tags: ['fika'] },
    { title: 'Shipped juniper', tags: ['juniper'], completed: true },
    {
      title: 'Parent without tag',
      subtasks: [{ title: 'Tagged subtask', tags: ['juniper'] }],
    },
  ],
};

async function setup(
  options: {
    org?: Org;
    query?: Partial<SavedViewQuery>;
    tasks?: Record<number, FixtureTask[]>;
    view?: Partial<SavedView>;
  } = {},
) {
  const org = options.org ?? sharedOrg;
  const transport = createFixtureTransport({
    userId,
    tasks: options.tasks ?? defaultTasks,
    members: org.isPersonal ? [] : members.filter((m) => m.userId !== userId),
    tags: [{ name: 'juniper', color: 'green' }, { name: 'fika' }],
  });
  // The fixture creates tags as tasks use them: look them up after its first read.
  await transport.fetchMyList(orgId);
  const juniper = transport.tags(orgId).find((tag) => tag.name === 'juniper')?.id as string;
  const fika = transport.tags(orgId).find((tag) => tag.name === 'fika')?.id as string;
  const view: SavedView = {
    id: viewId,
    orgId,
    createdBy: userId,
    shared: !org.isPersonal,
    name: 'Juniper',
    query: {
      tags: [juniper],
      tagMode: 'any',
      assignee: 'anyone',
      due: 'any',
      status: 'open',
      ...options.query,
    },
    archivedAt: null,
    position: 'a0',
    openCount: 0,
    createdAt: 1,
    updatedAt: 1,
    ...options.view,
  };
  transport.views.set(viewId, view);
  // The server answers with the changed view.
  env.update.mockImplementation(async ({ patch }) => ({ ...view, ...(patch as object) }));
  const sent: ListOp[] = [];
  const send = transport.send;
  transport.send = (op, org) => {
    sent.push(op);
    return send(op, org);
  };
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
  });
  queryClient.setQueryData(queryKeys.me, meIn);
  queryClient.setQueryData(queryKeys.orgMembers(orgId), members);
  queryClient.setQueryData(queryKeys.views(orgId, false), [view]);
  render(
    <QueryClientProvider client={queryClient}>
      <ListTransportContext.Provider value={transport}>
        <KeymapRoot />
        <SavedViewContent org={org} userId={userId} viewId={viewId} tabs={[]} />
        <ToastRegion />
      </ListTransportContext.Provider>
    </QueryClientProvider>,
  );
  await screen.findByRole('treegrid');
  await waitFor(() => expect(screen.getAllByTestId('task-row').length).toBeGreaterThan(0));
  const pipeline = getListPipeline(queryClient, transport);
  const taskId = (title: string) =>
    Object.values(transport.state(orgId).tasks).find((t) => t.title === title)?.id as string;
  return { transport, sent, queryClient, pipeline, view, juniper, fika, taskId };
}

/** Section headers (assignee) with the titles below each. */
function sections(): [string, string[]][] {
  const out: [string, string[]][] = [];
  for (const row of screen.getByRole('treegrid').querySelectorAll('[data-row-id]')) {
    const el = row as HTMLElement;
    if (el.dataset.testid === 'member-section') out.push([el.dataset.assignee as string, []]);
    else if (el.dataset.testid === 'task-row') {
      out.at(-1)?.[1].push(el.querySelector('[data-focus-target]')?.textContent ?? '');
    }
  }
  return out;
}

function activeInput(): HTMLInputElement {
  const el = document.activeElement;
  if (!(el instanceof HTMLInputElement)) throw new Error('no input focused');
  return el;
}

beforeEach(() => {
  useListStore.getState().reset();
  useUndoStore.getState().clear();
  for (const fn of Object.values(env)) fn.mockClear();
});

afterEach(() => clearToasts());

describe('a view (ADR 0073 B)', () => {
  test('AC-13.3 rows by person: me, members alphabetically, Unassigned; matches only', async () => {
    await setup();
    expect(sections()).toEqual([
      [userId, ['Mine juniper', 'Tagged subtask']],
      [anna, ['Anna juniper']],
      [markus, []],
      ['none', []],
    ]);
    // A tagged subtask shows its untagged parent as its breadcrumb (B5).
    const sub = screen.getByText('Tagged subtask').closest('[data-row-id]') as HTMLElement;
    expect(within(sub).getByTestId('row-breadcrumb').textContent).toContain('Parent without tag');
  });

  test('a personal org has one section and no person headers', async () => {
    await setup({ org: { ...sharedOrg, isPersonal: true, name: 'Personal' } });
    expect(screen.queryAllByTestId('member-section')).toHaveLength(0);
    expect(screen.queryByTestId('view-chip-assignee')).toBeNull();
    expect(screen.queryByTestId('view-chip-shared')).toBeNull();
  });

  test('a task that stops matching leaves at once (optimistic, before the server answers)', async () => {
    const { pipeline, taskId, juniper, transport } = await setup();
    const sent: unknown[] = [];
    transport.send = (op) => {
      sent.push(op);
      return new Promise(() => {});
    };
    act(() => {
      pipeline.enqueue(orgId, [listOps.removeTag(taskId('Anna juniper'), juniper)], {
        userId,
        timezone: 'UTC',
        allDayReminderTime: '09:00',
      });
    });
    // The request hangs: the row left on the optimistic op alone.
    await waitFor(() => expect(screen.queryByText('Anna juniper')).toBeNull());
    expect(sent).toHaveLength(1);
  });

  test('B6: a task typed under Anna gets the view’s tag and goes to her Inbox', async () => {
    const { sent, juniper } = await setup();
    const add = screen
      .getAllByRole('button', { name: 'Add task' })
      .find((b) => b.closest('[data-row-id]')?.getAttribute('data-row-id')?.includes(anna));
    fireEvent.click(add as Element);
    const input = activeInput();
    input.value = 'Order the banners';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(sent.some((op) => op.kind === 'task.create')).toBe(true));
    const create = sent.find((op) => op.kind === 'task.create');
    expect(create?.payload).toMatchObject({
      title: 'Order the banners',
      assigneeId: anna,
      tagIds: [juniper],
    });
    expect(create?.payload).not.toHaveProperty('groupId');
    expect(sections()[1]).toEqual([anna, ['Anna juniper', 'Order the banners']]);
  });

  test('B6: a task typed under me lands at the top of my Inbox with the tag; Unassigned stays so', async () => {
    const { sent, juniper, transport } = await setup();
    const addIn = (assignee: string) =>
      screen
        .getAllByRole('button', { name: 'Add task' })
        .find((b) =>
          b.closest('[data-row-id]')?.getAttribute('data-row-id')?.includes(`member:${assignee}`),
        ) as Element;
    fireEvent.click(addIn(userId));
    let input = activeInput();
    input.value = 'Book the venue';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    fireEvent.click(addIn('none'));
    input = activeInput();
    input.value = 'Someone call the printer';
    fireEvent.input(input);
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(sent.filter((op) => op.kind === 'task.create')).toHaveLength(2));
    const [mine, nobody] = sent.filter((op) => op.kind === 'task.create');
    const inbox = Object.values(transport.state(orgId).groups).find((g) => g.kind === 'inbox');
    expect(mine?.payload).toMatchObject({
      groupId: inbox?.id,
      tagIds: [juniper],
      beforeId: expect.any(String),
    });
    expect(nobody?.payload).toMatchObject({ assigneeId: null, tagIds: [juniper] });
  });

  test('header: a project view shows open and done counts; a chip edit re-filters at once and saves', async () => {
    await setup();
    expect(screen.getByTestId('view-counts').textContent).toContain('3 open · 1 done');
    fireEvent.click(screen.getByTestId('view-chip-due'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'No date' }));
    // "Mine juniper" has a date: it leaves without a refetch.
    await waitFor(() => expect(screen.queryByText('Mine juniper')).toBeNull());
    await waitFor(() => expect(env.update).toHaveBeenCalled());
    expect(env.update.mock.calls[0]?.[0]).toMatchObject({
      id: viewId,
      patch: { query: { due: 'none' } },
    });
  });

  test('header: renaming saves the name; sharing shows the B13 note', async () => {
    await setup();
    expect(screen.getByTestId('view-shared-note').textContent).toContain(
      'Everyone in Kestrel Lane',
    );
    const name = screen.getByTestId('view-name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Juniper launch' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() =>
      expect(env.update).toHaveBeenCalledWith({ id: viewId, patch: { name: 'Juniper launch' } }),
    );
  });

  test('Show completed fetches the completed matches too', async () => {
    const { queryClient } = await setup();
    expect(screen.queryByText('Shipped juniper')).toBeNull();
    act(() => useListStore.getState().set({ showCompleted: true }));
    expect(await screen.findByText('Shipped juniper')).toBeTruthy();
    expect(queryClient.getQueryData(viewTasksKey(viewId, true))).toBeTruthy();
  });

  test('⋯ → Delete asks inline, then deletes and goes back to My tasks', async () => {
    await setup();
    fireEvent.click(screen.getByTestId('view-menu'));
    fireEvent.click(await screen.findByTestId('view-menu-delete'));
    const confirm = await screen.findByTestId('view-delete-confirm');
    fireEvent.click(within(confirm).getByRole('button', { name: 'Delete view' }));
    await waitFor(() => expect(env.remove).toHaveBeenCalledWith(viewId));
    await waitFor(() => expect(env.navigate).toHaveBeenCalledWith({ href: '/o/kestrel/my' }));
  });

  test('B8: a shared view of someone else’s can’t be made private here (it would vanish)', async () => {
    await setup({ view: { createdBy: anna } });
    fireEvent.click(screen.getByTestId('view-chip-shared'));
    const item = await screen.findByRole('menuitemradio', { name: /Private/ });
    expect(item.getAttribute('aria-disabled')).toBe('true');
    expect(item.textContent).toContain('Only its creator can make it private');
    fireEvent.click(item);
    expect(env.update).not.toHaveBeenCalled();
  });
});

describe('a new view (/v/new)', () => {
  let queryClient: QueryClient;
  function renderNew() {
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
    });
    queryClient.setQueryData(queryKeys.me, meIn);
    queryClient.setQueryData(queryKeys.orgMembers(orgId), members);
    queryClient.setQueryData(queryKeys.views(orgId, false), []);
    const transport = createFixtureTransport({ userId, members: [] });
    render(
      <QueryClientProvider client={queryClient}>
        <ListTransportContext.Provider value={transport}>
          <SavedViewContent org={sharedOrg} userId={userId} viewId="new" tabs={[]} />
          <ToastRegion />
        </ListTransportContext.Provider>
      </QueryClientProvider>,
    );
    return screen.getByTestId('view-name') as HTMLInputElement;
  }

  test('a create that failed is tried again by Enter on the same name', async () => {
    env.create.mockRejectedValueOnce(new ApiError('network', 0));
    const name = renderNew();
    fireEvent.change(name, { target: { value: 'Launch' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(await screen.findByText("Couldn't save the view. Try again.")).toBeTruthy();
    expect(env.create).toHaveBeenCalledTimes(1);
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => expect(env.create).toHaveBeenCalledTimes(2));
    expect(env.create.mock.calls[1]?.[0]).toMatchObject({ name: 'Launch' });
    await waitFor(() =>
      expect(env.navigate).toHaveBeenCalledWith(
        expect.objectContaining({ href: expect.stringMatching(/^\/o\/kestrel\/v\//) }),
      ),
    );
  });

  test('after a failed create, Escape cancels: the blur creates nothing', async () => {
    env.create.mockRejectedValueOnce(new ApiError('network', 0));
    const name = renderNew();
    fireEvent.change(name, { target: { value: 'Launch' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(await screen.findByText("Couldn't save the view. Try again.")).toBeTruthy();
    fireEvent.focus(name);
    fireEvent.keyDown(name, { key: 'Escape' });
    fireEvent.blur(name);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(env.create).toHaveBeenCalledTimes(1);
  });

  test('the view limit (409 view_limit) says so', async () => {
    env.create.mockRejectedValueOnce(new ApiError('view_limit', 409));
    const name = renderNew();
    fireEvent.change(name, { target: { value: 'One too many' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(await screen.findByText(/as many views of this kind as it can \(100/)).toBeTruthy();
  });

  test('a create answered after the org was left (or the session ended) writes no caches', async () => {
    const name = renderNew();
    env.create.mockImplementationOnce(async (input) => {
      // Meanwhile a fresh /me without the org pruned its caches.
      queryClient.setQueryData(queryKeys.me, fixtureMe);
      queryClient.removeQueries({ queryKey: ['views', orgId] });
      return { ...input, orgId } as never;
    });
    fireEvent.change(name, { target: { value: 'Late' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => expect(env.create).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queryClient.getQueryData(queryKeys.views(orgId, false))).toBeUndefined();
    expect(env.navigate).not.toHaveBeenCalled();
  });

  test('Save as view answered after the org was left writes no caches either', async () => {
    const client = new QueryClient();
    client.setQueryData(queryKeys.me, meIn);
    client.setQueryData(queryKeys.views(orgId, false), []);
    env.create.mockImplementationOnce(async (input) => {
      client.setQueryData(queryKeys.me, fixtureMe);
      client.removeQueries({ queryKey: ['views', orgId] });
      return { ...input, orgId } as never;
    });
    const { result } = renderHook(() => useSaveAsView(sharedOrg), {
      wrapper: ({ children }) => (
        <QueryClientProvider client={client}>{children}</QueryClientProvider>
      ),
    });
    act(() => result.current({ ...emptyViewQuery, due: 'overdue' }));
    await waitFor(() => expect(env.create).toHaveBeenCalledTimes(1));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(client.getQueryData(queryKeys.views(orgId, false))).toBeUndefined();
    expect(env.navigate).not.toHaveBeenCalled();
  });
});

describe('a failed edit (online only, optimistic)', () => {
  test('a list fetched meanwhile is the truth: the rollback doesn’t overwrite it', async () => {
    const { queryClient, view } = await setup();
    const key = queryKeys.views(orgId, false);
    env.update.mockImplementationOnce(async () => {
      queryClient.setQueryData(key, [{ ...view, name: 'Renamed elsewhere' }]);
      throw new ApiError('conflict', 409);
    });
    const name = screen.getByTestId('view-name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Mine' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    expect(await screen.findByText("Couldn't save the view. Try again.")).toBeTruthy();
    expect(queryClient.getQueryData<SavedView[]>(key)?.[0]?.name).toBe('Renamed elsewhere');
  });

  test('nothing fetched (offline, failing): only this view’s entry goes back', async () => {
    const { queryClient } = await setup();
    const key = queryKeys.views(orgId, false);
    env.update.mockRejectedValueOnce(new ApiError('network', 0));
    const name = screen.getByTestId('view-name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Mine' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() =>
      expect(queryClient.getQueryData<SavedView[]>(key)?.[0]?.name).toBe('Juniper'),
    );
  });

  test('the cache only ever holds answers; a failure drops the local edit', async () => {
    const { queryClient } = await setup();
    const key = queryKeys.views(orgId, false);
    const seen: string[] = [];
    queryClient.getQueryCache().subscribe(() => {
      const name = queryClient.getQueryData<SavedView[]>(key)?.[0]?.name;
      if (name) seen.push(name);
    });
    let reject: (error: unknown) => void = () => {};
    env.update.mockImplementationOnce(
      () =>
        new Promise((_, no) => {
          reject = no;
        }),
    );
    const name = screen.getByTestId('view-name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Mine' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    // Shown at once, in the header only.
    await waitFor(() => expect(name.value).toBe('Mine'));
    act(() => reject(new ApiError('network', 0)));
    await waitFor(() => expect(name.value).toBe('Juniper'));
    expect(seen).not.toContain('Mine');
  });

  test('overlapping failures each drop their own edit, whatever order they answer in', async () => {
    await setup();
    const rejects: ((error: unknown) => void)[] = [];
    env.update.mockImplementation(
      () =>
        new Promise((_, no) => {
          rejects.push(no);
        }),
    );
    const name = screen.getByTestId('view-name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'One' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    fireEvent.click(screen.getByTestId('view-chip-due'));
    fireEvent.click(await screen.findByRole('menuitemradio', { name: 'No date' }));
    await waitFor(() => expect(rejects).toHaveLength(2));
    act(() => rejects[1]?.(new ApiError('network', 0)));
    act(() => rejects[0]?.(new ApiError('network', 0)));
    await waitFor(() => expect(name.value).toBe('Juniper'));
    expect(screen.getByTestId('view-chip-due').textContent).toContain('Any date');
  });

  test('a success writes the server’s view into the cache', async () => {
    const { queryClient, view } = await setup();
    env.update.mockImplementationOnce(async () => ({ ...view, name: 'As saved' }));
    const name = screen.getByTestId('view-name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'As typed' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() =>
      expect(queryClient.getQueryData<SavedView[]>(queryKeys.views(orgId, false))?.[0]?.name).toBe(
        'As saved',
      ),
    );
    await waitFor(() => expect(name.value).toBe('As saved'));
  });

  test('after a sign-out the old session’s views stay gone', async () => {
    const { queryClient } = await setup();
    const key = queryKeys.views(orgId, false);
    env.update.mockImplementationOnce(async () => {
      queryClient.removeQueries({ queryKey: ['views'] });
      sessionDataCleared();
      throw new ApiError('unauthenticated', 401);
    });
    const name = screen.getByTestId('view-name') as HTMLInputElement;
    fireEvent.change(name, { target: { value: 'Mine' } });
    fireEvent.keyDown(name, { key: 'Enter' });
    await waitFor(() => expect(env.update).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(queryClient.getQueryData(key)).toBeUndefined();
    expect(screen.queryByText("Couldn't save the view. Try again.")).toBeNull();
  });
});
