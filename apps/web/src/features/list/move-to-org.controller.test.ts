import { childrenOf, type ListState, tasksInGroup } from '@rooster/core/reducers';
import type { Task } from '@rooster/core/schemas';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { ListPipeline, myListKey } from '../../data/pipeline/pipeline';
import { createListStore } from '../../state/list-store';
import { useUndoStore } from '../../state/undo-store';
import type { ToastOptions } from '../../ui/toast';
import { sampleDateContext } from '../dates/fixtures';
import { ListController, type Translate } from './controller';
import { buildRows } from './model/rows';

/** ADR 0072 §20–22: `ListController.moveToOrg` and its undo across orgs. */

const toasts: ToastOptions[] = [];
vi.mock('../../ui/toast', () => ({
  toast: (options: ToastOptions) => {
    toasts.push(options);
    return 'toast';
  },
}));

const userId = '01900000-0000-7000-8000-000000000001';
const src = '01900000-0000-7000-8000-0000000000aa';
const dst = '01900000-0000-7000-8000-0000000000bb';
const t: Translate = (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key);

async function setup() {
  const transport = createFixtureTransport({
    userId,
    tasks: { 1: ['A', { title: 'P', subtasks: ['S1', 'S2'], expanded: true }, 'B'] },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pipeline = new ListPipeline({ transport, queryClient, clientId: 'c', backoffMs: () => 0 });
  for (const org of [src, dst]) {
    new QueryObserver(queryClient, {
      queryKey: myListKey(org),
      queryFn: () => pipeline.fetch(org),
      staleTime: 30_000,
    }).subscribe(() => {});
    await vi.waitFor(() => expect(pipeline.view(org)).toBeDefined());
  }
  const store = createListStore();
  const controller = (orgId: string) =>
    new ListController({
      orgId,
      userId,
      pipeline,
      t,
      store,
      rows: () =>
        buildRows(pipeline.view(orgId) as ListState, {
          drafts: [],
          showCompleted: false,
          hiding: {},
          dragCollapsed: false,
          hoverExpanded: {},
          draftTask: () => ({}) as Task,
        }),
      dateContext: () => sampleDateContext('en'),
    });
  const view = (org: string) => pipeline.view(org) as ListState;
  const byTitle = (org: string, title: string) =>
    Object.values(view(org).tasks).find((x) => x.title === title) as Task;
  const today = (org: string) =>
    Object.values(view(org).groups).find((g) => g.name === 'Today')?.id as string;
  const titles = (org: string) => tasksInGroup(view(org), today(org)).map((x) => x.title);
  return { transport, pipeline, store, controller, view, byTitle, today, titles };
}

beforeEach(() => {
  toasts.length = 0;
  useUndoStore.getState().clear();
});

describe('ListController.moveToOrg', () => {
  test('moves the selection with one undo entry, a toast with Undo, and the cursor on', async () => {
    const { pipeline, store, controller, byTitle, today, titles, transport } = await setup();
    const list = controller(src);
    const p = byTitle(src, 'P');
    const s1 = byTitle(src, 'S1');
    store.getState().select(p.id);
    store.getState().toggleSelected(s1.id);
    const target = { orgId: dst, orgName: 'Riverside', groupId: today(dst) };
    expect(list.moveToOrg(target, [s1.id, p.id])).toBe(true);
    // S1 travels with its selected parent: one root.
    const [op] = pipeline.pendingOps(src);
    expect(op).toMatchObject({
      kind: 'task.moveToOrg',
      entityId: src,
      payload: { ids: [p.id], orgId: dst, groupId: today(dst) },
    });
    expect(titles(src)).toEqual(['A', 'B']);
    expect(store.getState().cursor).toBe(byTitle(src, 'B').id);
    expect(toasts.at(-1)?.message).toBe('moveToOrg.toast {"org":"Riverside"}');
    expect(useUndoStore.getState().undo.at(-1)?.label).toBe(
      'undo.movedToOrg {"count":1,"org":"Riverside"}',
    );
    await pipeline.idle();
    await vi.waitFor(() => expect(titles(dst)).toEqual(['P', 'A', 'P', 'B']));

    // Undo from the toast, then redo from the stack.
    toasts.at(-1)?.action?.onAction();
    expect(titles(src)).toEqual(['A', 'P', 'B']);
    expect(pipeline.pendingOps(dst).map((x) => x.kind)).toEqual(['task.moveToOrg']);
    await pipeline.idle();
    expect(tasksInGroup(transport.state(src), today(src)).map((x) => x.title)).toEqual([
      'A',
      'P',
      'B',
    ]);
    expect(childrenOf(transport.state(src), p.id).map((x) => x.title)).toEqual(['S1', 'S2']);

    expect(controller(dst).redo()).toBe(true);
    expect(titles(src)).toEqual(['A', 'B']);
    await pipeline.idle();
    expect(transport.state(dst).tasks[p.id]?.orgId).toBe(dst);
    expect(list.undo()).toBe(true);
    await pipeline.idle();
    expect(transport.state(src).tasks[p.id]?.seq).toBe(p.seq);
  });

  test('nothing to move: no op, no undo entry', async () => {
    const { pipeline, controller, byTitle } = await setup();
    const list = controller(src);
    const target = { orgId: dst, orgName: 'Riverside', groupId: null };
    expect(list.moveToOrg(target, [])).toBe(false);
    expect(list.moveToOrg(target, ['nope'])).toBe(false);
    expect(list.moveToOrg({ ...target, orgId: src }, [byTitle(src, 'A').id])).toBe(false);
    expect(pipeline.pending).toBe(0);
    expect(useUndoStore.getState().undo).toHaveLength(0);
  });

  test("a task the server doesn't have yet waits", async () => {
    const { pipeline, controller, byTitle } = await setup();
    const list = controller(src);
    const a = byTitle(src, 'A');
    list.duplicate([a.id]);
    const copy = Object.values(pipeline.view(src)?.tasks ?? {}).find(
      (x) => x.title === 'A' && x.id !== a.id,
    ) as Task;
    expect(list.movableToOrg([a.id, copy.id, a.id])).toEqual([a.id]);
    await pipeline.idle();
    expect(list.movableToOrg([copy.id])).toEqual([copy.id]);
  });
});
