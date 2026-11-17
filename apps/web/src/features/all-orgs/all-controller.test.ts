import { inboxOf, type ListState, normalGroups } from '@rooster/core/reducers';
import type { Task } from '@rooster/core/schemas';
import { selectAllView, type ViewSection } from '@rooster/core/views';
import { QueryClient, QueryObserver } from '@tanstack/react-query';
import { beforeEach, describe, expect, test, vi } from 'vitest';
import { allViewSources, mergeOrgLists } from '../../data/all-views';
import { createFixtureTransport } from '../../data/pipeline/fixture-transport';
import { ListPipeline, myListKey } from '../../data/pipeline/pipeline';
import { createListStore } from '../../state/list-store';
import { useUndoStore } from '../../state/undo-store';
import type { ToastOptions } from '../../ui/toast';
import { sampleDateContext, sampleToday } from '../dates/fixtures';
import { ListController, type Translate, type ViewModel } from '../list/controller';
import { buildViewRows } from '../list/model/view-rows';
import { draftPlaceholder } from '../list/my-list-view';
import { fixtureIds, fixtureMe } from '../shell/fixtures';
import { AllListController } from './all-controller';

/** ADR 0073 A3–A4: All organisations queues each op under its task's org. */

const toasts: ToastOptions[] = [];
vi.mock('../../ui/toast', () => ({
  toast: (options: ToastOptions) => {
    toasts.push(options);
    return 'toast';
  },
}));

const userId = fixtureMe.user.id;
const personal = fixtureIds.personalOrg;
const north = fixtureIds.companyOrg;
const club = fixtureIds.clubOrg;
const orgIds = [personal, north, club];
const t: Translate = (key, options) => (options ? `${key} ${JSON.stringify(options)}` : key);

async function setup(defaultOrgId: string = personal) {
  const transport = createFixtureTransport({
    userId,
    tasks: {
      0: [{ title: 'Due today', dueDate: sampleToday }],
      2: [{ title: 'Late', dueDate: '2026-10-01' }, 'Someday'],
    },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const pipeline = new ListPipeline({ transport, queryClient, clientId: 'c', backoffMs: () => 0 });
  for (const org of orgIds) {
    new QueryObserver(queryClient, {
      queryKey: myListKey(org),
      queryFn: () => pipeline.fetch(org),
      staleTime: 30_000,
    }).subscribe(() => {});
    await vi.waitFor(() => expect(pipeline.view(org)).toBeDefined());
  }
  const store = createListStore();
  const dateCtx = sampleDateContext('en');
  const states = () => orgIds.map((org) => pipeline.view(org));
  const viewModel = (): ViewModel => ({
    view: 'today',
    sections: selectAllView(allViewSources(orgIds, states()), 'today', {
      viewerId: userId,
      showCompleted: false,
      today: dateCtx.today,
      nowMs: dateCtx.nowMs,
      viewerTz: dateCtx.timezone,
    }).map(
      (s): ViewSection => ({
        id: s.id,
        kind: s.kind,
        date: s.date,
        taskIds: s.items.map((i) => i.taskId),
      }),
    ),
  });
  const rows = () => {
    const merged = mergeOrgLists(orgIds, states());
    return buildViewRows(merged.state, viewModel().sections, {
      view: 'today',
      drafts: store.getState().drafts,
      showCompleted: false,
      hiding: {},
      draftTask: (d) => draftPlaceholder(personal, userId, d),
      orgOf: (id) => merged.orgOfTask.get(id),
    });
  };
  const common = {
    userId,
    pipeline,
    t,
    store,
    rows,
    dateContext: () => dateCtx,
    view: viewModel,
  };
  const scopes = fixtureMe.orgs.map((org) => ({
    org,
    controller: new ListController({ ...common, orgId: org.id, tags: () => [] }),
  }));
  const all = new AllListController({
    ...common,
    scopes: () => scopes,
    defaultOrgId: () => defaultOrgId,
  });
  const view = (org: string) => pipeline.view(org) as ListState;
  const byTitle = (org: string, title: string) =>
    Object.values(view(org).tasks).find((x) => x.title === title) as Task;
  const ops = (org: string) => pipeline.pendingOps(org);
  return { transport, pipeline, store, all, view, byTitle, ops };
}

beforeEach(() => {
  toasts.length = 0;
  useUndoStore.getState().clear();
});

describe('AllListController', () => {
  test('reads every org as one list and names each task’s org', async () => {
    const { all, byTitle } = await setup();
    const late = byTitle(north, 'Late');
    expect(all.task(late.id)?.title).toBe('Late');
    expect(all.orgOfTask(late.id)).toBe(north);
    expect(all.orgIds()).toEqual(orgIds);
    const rows = all.rows().filter((r) => r.kind === 'task');
    // Overdue first (three orgs' "Late"), then today's three, each with its org.
    expect(rows.map((r) => (r.kind === 'task' ? [r.task.title, r.orgId] : null))).toEqual([
      ['Late', personal],
      ['Late', north],
      ['Late', club],
      ['Due today', personal],
      ['Due today', north],
      ['Due today', club],
    ]);
  });

  test('a bulk completion over two orgs queues each part in its org, with one undo step', async () => {
    const { all, byTitle, ops, pipeline, transport } = await setup();
    const a = byTitle(personal, 'Late');
    const b = byTitle(north, 'Late');
    const c = byTitle(north, 'Due today');
    all.toggleComplete([a.id, b.id, c.id]);
    // The bulk op is split by org: each part names its own org.
    expect(ops(personal)).toHaveLength(1);
    expect(ops(personal)[0]).toMatchObject({
      kind: 'task.bulk',
      entityId: personal,
      payload: { op: 'complete', ids: [a.id] },
    });
    expect(ops(north)).toHaveLength(1);
    expect(ops(north)[0]).toMatchObject({
      kind: 'task.bulk',
      entityId: north,
      payload: { op: 'complete', ids: [b.id, c.id] },
    });
    expect(ops(club)).toHaveLength(0);
    const entry = useUndoStore.getState().undo.at(-1);
    expect(useUndoStore.getState().undo).toHaveLength(1);
    expect(entry?.more).toHaveLength(1);
    await pipeline.idle();
    expect(transport.state(north).tasks[b.id]?.completedAt).not.toBeNull();

    // One undo reopens all three, each in its own org; redo completes them again.
    expect(all.undo()).toBe(true);
    expect(all.task(a.id)?.completedAt).toBeNull();
    expect(all.task(b.id)?.completedAt).toBeNull();
    expect(all.task(c.id)?.completedAt).toBeNull();
    await pipeline.idle();
    expect(transport.state(personal).tasks[a.id]?.completedAt).toBeNull();
    expect(transport.state(north).tasks[c.id]?.completedAt).toBeNull();
    expect(all.redo()).toBe(true);
    expect(all.task(a.id)?.completedAt).not.toBeNull();
    expect(all.task(c.id)?.completedAt).not.toBeNull();
    await pipeline.idle();
    expect(transport.state(north).tasks[c.id]?.completedAt).not.toBeNull();
  });

  test('a date and a delete on one task go to its org', async () => {
    const { all, byTitle, ops } = await setup();
    const task = byTitle(club, 'Due today');
    all.setDue([task.id], { dueDate: '2026-10-09', dueTime: null, dueTz: null });
    expect(ops(club).map((op) => op.kind)).toEqual(['task.patch']);
    all.deleteTasks([task.id]);
    expect(ops(club).map((op) => op.kind)).toEqual(['task.patch', 'task.delete']);
    expect(ops(personal)).toHaveLength(0);
    expect(ops(north)).toHaveLength(0);
  });

  test('a new row goes to the default org: its Inbox, the section’s date', async () => {
    const { all, store, byTitle, view, pipeline } = await setup(north);
    const draftId = all.newSectionDraft('today', null) as string;
    expect(store.getState().drafts[0]?.groupId).toBe(inboxOf(view(north))?.id);
    expect(all.titleScope(draftId, 'Pay rent', []).org?.id).toBe(north);
    all.commitTitle(draftId, 'Pay rent');
    const created = byTitle(north, 'Pay rent');
    expect(created.dueDate).toBe(sampleToday);
    expect(created.placement?.groupId).toBe(inboxOf(view(north))?.id);
    expect(pipeline.pendingOps(north).map((op) => op.kind)).toEqual(['task.create']);
    // One undo removes it again.
    expect(all.undo()).toBe(true);
    expect(all.task(created.id)).toBeUndefined();
  });

  test('`^org` picks another org; `>Group` and the date phrase resolve there', async () => {
    const { all, byTitle, view } = await setup();
    const draftId = all.newSectionDraft('today', null) as string;
    const raw = 'Book the venue ^North';
    const scope = all.titleScope(draftId, raw, []);
    expect(scope.org?.id).toBe(north);
    expect(scope.orgToken).toEqual({ start: 15, end: 21 });
    expect(scope.controller.orgId).toBe(north);
    all.commitTitle(draftId, raw);
    const venue = byTitle(north, 'Book the venue');
    expect(venue.dueDate).toBe(sampleToday);
    expect(venue.placement?.groupId).toBe(inboxOf(view(north))?.id);
    expect(byTitle(personal, 'Book the venue')).toBeUndefined();

    const second = all.newSectionDraft('today', null) as string;
    all.commitTitle(second, 'Read the minutes ^"Book club" >prio tomorrow');
    const minutes = byTitle(club, 'Read the minutes');
    const prio = normalGroups(view(club)).find((g) => g.name === 'Prio');
    expect(minutes.placement?.groupId).toBe(prio?.id);
    expect(minutes.dueDate).toBe('2026-10-09');
  });

  test('a token that names no org stays text, in the default org', async () => {
    const { all, byTitle } = await setup();
    const draftId = all.newSectionDraft('today', null) as string;
    expect(all.titleScope(draftId, 'Raise ^nothing', []).orgToken).toBeNull();
    all.commitTitle(draftId, 'Raise ^nothing');
    expect(byTitle(personal, 'Raise ^nothing')).toBeDefined();
  });

  test('tags, groups and people act on one org only', async () => {
    const { all, byTitle, ops, store } = await setup();
    const a = byTitle(personal, 'Late');
    const b = byTitle(north, 'Late');
    expect(all.scoped([a.id, b.id])).toBeNull();
    expect(all.scoped([b.id])?.orgId).toBe(north);
    expect(all.refuseAcrossOrgs([a.id, b.id])).toBe(true);
    expect(all.refuseAcrossOrgs([b.id])).toBe(false);
    all.createTagFor([a.id, b.id], 'urgent');
    expect(ops(personal)).toHaveLength(0);
    expect(ops(north)).toHaveLength(0);
    expect(toasts.at(-1)?.message).toBe('all.oneOrg');

    // One org: the tag is created in that org.
    all.createTagFor([b.id], 'urgent');
    expect(ops(north).map((op) => op.kind)).toEqual(['tag.create', 'task.addTag']);
    // A group of another org is never a target.
    const personalPrio = normalGroups(all.scoped([a.id])?.state() as ListState)[1]?.id as string;
    store.getState().set({ popover: { kind: 'moveTo', rowId: b.id } });
    all.moveToGroup(personalPrio, [b.id]);
    expect(ops(north).map((op) => op.kind)).toEqual(['tag.create', 'task.addTag']);
    expect(store.getState().popover).toBeNull();
  });

  test('`^` completes to the viewer’s orgs on new rows only', async () => {
    const { all, byTitle } = await setup();
    const draftId = all.newSectionDraft('today', null) as string;
    expect(all.orgChoices(draftId).map((o) => o.name)).toEqual([
      'Personal',
      'Northwind',
      'Book club',
    ]);
    expect(all.orgChoices(byTitle(north, 'Late').id)).toEqual([]);
  });
});
