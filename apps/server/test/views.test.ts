// Phase 13 (ADR 0073 B, WP 13.3): views, saved queries in one org. AC-13.3 (shared and private
// views, per-member order, open/done counts, archive) and AC-13.4 (tag delete and merge, grants).
import { selectSavedView } from '@rooster/core/saved-views';
import type { SavedView, SavedViewTasks, Tag, Task } from '@rooster/core/schemas';
import { and, eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { savedView, savedViewPref } from '../src/db/schema/index.ts';
import type { DomainEvent } from '../src/events/bus.ts';
import { ALL, actorOf, bearer, pat } from './grant-helpers.ts';
import { type Caller, createTask, type ListCtx, listCtx, sharedOrg } from './list-helpers.ts';

/** 2026-10-09T08:00:00Z. */
const NOW = 1_791_532_800_000;

const views = (c: Caller, org: string, archived = false) =>
  c.ok<SavedView[]>('GET', `/api/v1/orgs/${org}/views${archived ? '?archived=true' : ''}`);

const newView = (c: Caller, org: string, body: Record<string, unknown>) =>
  c.ok<SavedView>('POST', `/api/v1/orgs/${org}/views`, body, 201);

const rows = (c: Caller, viewId: string, completed = false) =>
  c.ok<SavedViewTasks>('GET', `/api/v1/views/${viewId}/tasks${completed ? '?completed=true' : ''}`);

const newTag = (c: Caller, org: string, name: string) =>
  c.ok<Tag>('POST', `/api/v1/orgs/${org}/tags`, { name }, 201);

const names = (list: readonly SavedView[]) => list.map((v) => v.name);
const titles = (page: SavedViewTasks) => page.items.map((t) => t.title);

function capture(ctx: ListCtx): DomainEvent[] {
  const events: DomainEvent[] = [];
  ctx.app.services.events.on((e) => events.push(e));
  return events;
}

/** Kestrel: Amara (owner), Bea and Cy; the #juniper tag. */
async function team() {
  const ctx = listCtx({ clock: () => NOW });
  const amara = ctx.user('amara@example.com', 'Amara');
  const bea = ctx.user('bea@example.com', 'Bea');
  const cy = ctx.user('cy@example.com', 'Cy');
  const org = await sharedOrg(amara, [bea, cy], 'Kestrel');
  const juniper = await newTag(amara, org.id, 'juniper');
  return { ctx, amara, bea, cy, org, juniper };
}

describe('AC-13.3 views', () => {
  it('a shared project view lists every member’s open matches, with open and done counts', async () => {
    const { amara, bea, cy, org, juniper } = await team();
    const mine = await createTask(amara, { title: 'Brief', tagIds: [juniper.id] }, org.id);
    await createTask(bea, { title: 'Sketch', tagIds: [juniper.id] }, org.id);
    await createTask(cy, { title: 'Untagged' }, org.id);
    const done = await createTask(cy, { title: 'Kickoff', tagIds: [juniper.id] }, org.id);
    await cy.ok('POST', `/api/v1/tasks/${done.id}/complete`, { completed: true });
    // A tagged subtask is a row of its own; its untagged sibling is not.
    await createTask(amara, { title: 'Sub', parentId: mine.id, tagIds: [juniper.id] }, org.id);
    await createTask(amara, { title: 'Plain sub', parentId: mine.id }, org.id);

    const view = await newView(bea, org.id, {
      name: 'Juniper',
      query: { tags: [juniper.id] },
      shared: true,
    });
    expect(view).toMatchObject({
      orgId: org.id,
      createdBy: bea.userId,
      shared: true,
      archivedAt: null,
      openCount: 3,
      query: { tags: [juniper.id], tagMode: 'any', assignee: 'anyone', due: 'any', status: 'open' },
    });
    for (const c of [amara, bea, cy]) {
      expect(names(await views(c, org.id))).toEqual(['Juniper']);
      const page = await rows(c, view.id);
      expect(titles(page).sort()).toEqual(['Brief', 'Sketch', 'Sub']);
      expect(page.counts).toEqual({ open: 3, done: 1 });
    }
    expect(titles(await rows(amara, view.id, true)).sort()).toEqual([
      'Brief',
      'Kickoff',
      'Sketch',
      'Sub',
    ]);
    // A matching subtask of a non-matching parent brings its parent chain (breadcrumbs), after
    // the rows; not counted, and core's selector drops it again.
    const plainParent = await createTask(bea, { title: 'Plain parent' }, org.id);
    const middle = await createTask(bea, { title: 'Middle', parentId: plainParent.id }, org.id);
    await createTask(bea, { title: 'Deep', parentId: middle.id, tagIds: [juniper.id] }, org.id);
    const withChain = await rows(amara, view.id);
    expect(titles(withChain).slice(0, 4).sort()).toEqual(['Brief', 'Deep', 'Sketch', 'Sub']);
    expect(titles(withChain).slice(4)).toEqual(['Middle', 'Plain parent']);
    expect(withChain.counts).toEqual({ open: 4, done: 1 });
    const sections = selectSavedView(withChain.items, view.query, {
      viewerId: amara.userId,
      due: { today: '2026-10-09', nowMs: NOW, viewerTz: 'UTC' },
      members: [],
      locale: 'en',
      isPersonal: false,
    });
    expect(sections.flatMap((x) => x.taskIds)).toHaveLength(4);
    // Each row carries the viewer's own placement.
    const brief = (await rows(amara, view.id)).items.find((t) => t.title === 'Brief');
    expect(brief?.placement).not.toBeNull();
    expect((await rows(bea, view.id)).items.find((t) => t.title === 'Brief')?.placement).toBeNull();
  });

  it('a private view is its creator’s only: everyone else gets 404', async () => {
    const { amara, bea, org } = await team();
    const view = await newView(amara, org.id, { name: 'Mine', query: { assignee: 'me' } });
    expect(view.shared).toBe(false);
    expect(names(await views(bea, org.id))).toEqual([]);
    expect(names(await views(bea, org.id, true))).toEqual([]);
    for (const [method, path, body] of [
      ['GET', `/api/v1/views/${view.id}/tasks`, undefined],
      ['PATCH', `/api/v1/views/${view.id}`, { name: 'Taken' }],
      ['POST', `/api/v1/views/${view.id}/move`, {}],
      ['POST', `/api/v1/views/${view.id}/archive`, undefined],
      ['POST', `/api/v1/views/${view.id}/restore`, undefined],
      ['DELETE', `/api/v1/views/${view.id}`, undefined],
    ] as const) {
      const res = await bea.call(method, path, body);
      expect(res.status, `${method} ${path}`).toBe(404);
      expect(await res.json()).toMatchObject({ code: 'not_found' });
    }
    // Not as a neighbour in a move either: an unknown neighbour means the end.
    const shared = await newView(bea, org.id, { name: 'Shared', query: {}, shared: true });
    const second = await newView(bea, org.id, { name: 'Second', query: {}, shared: true });
    const moved = await bea.ok<SavedView>('POST', `/api/v1/views/${shared.id}/move`, {
      beforeId: view.id,
    });
    expect(moved.position > second.position).toBe(true);
    // Nor is its ID usable for a create.
    const res = await bea.call('POST', `/api/v1/orgs/${org.id}/views`, {
      id: view.id,
      name: 'Mine',
      query: { assignee: 'me' },
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'id_conflict' });
    // Nor from outside the org, as with every org resource.
    const outsider = listCtx().user('x@example.com');
    expect((await outsider.call('GET', `/api/v1/orgs/${org.id}/views`)).status).toBe(404);
  });

  it('each member orders the views they see; new ones go to the end', async () => {
    const { amara, bea, org } = await team();
    const a = await newView(amara, org.id, { name: 'A', query: {}, shared: true });
    await newView(amara, org.id, { name: 'B', query: {}, shared: true });
    const c = await newView(amara, org.id, { name: 'C', query: {}, shared: true });
    expect(names(await views(bea, org.id))).toEqual(['A', 'B', 'C']);
    await bea.ok('POST', `/api/v1/views/${c.id}/move`, { beforeId: a.id });
    expect(names(await views(bea, org.id))).toEqual(['C', 'A', 'B']);
    expect(names(await views(amara, org.id))).toEqual(['A', 'B', 'C']);
    await newView(bea, org.id, { name: 'D (Bea’s)', query: {} });
    await newView(amara, org.id, { name: 'E', query: {}, shared: true });
    expect(names(await views(bea, org.id))).toEqual(['C', 'A', 'B', 'D (Bea’s)', 'E']);
    expect(names(await views(amara, org.id))).toEqual(['A', 'B', 'C', 'E']);
    // Positions are the viewer's own and ascend in the listed order.
    const list = await views(bea, org.id);
    expect(list.map((v) => v.position)).toEqual(list.map((v) => v.position).sort());
    await bea.ok('POST', `/api/v1/views/${a.id}/move`, { afterId: c.id, beforeId: null });
    expect(names(await views(bea, org.id))).toEqual(['C', 'A', 'B', 'D (Bea’s)', 'E']);
    await bea.ok('POST', `/api/v1/views/${a.id}/move`, {});
    expect(names(await views(bea, org.id))).toEqual(['C', 'B', 'D (Bea’s)', 'E', 'A']);
  });

  it('archive hides a view from everyone; restore brings it back at the end; both idempotent', async () => {
    const { amara, bea, org, juniper } = await team();
    const first = await newView(amara, org.id, {
      name: 'Juniper',
      query: { tags: [juniper.id] },
      shared: true,
    });
    await newView(amara, org.id, { name: 'Other', query: {}, shared: true });
    await bea.ok('POST', `/api/v1/views/${first.id}/move`, {});
    const archived = await bea.ok<SavedView>('POST', `/api/v1/views/${first.id}/archive`);
    expect(archived.archivedAt).toBe(NOW);
    expect(await bea.ok<SavedView>('POST', `/api/v1/views/${first.id}/archive`)).toMatchObject({
      archivedAt: NOW,
    });
    for (const c of [amara, bea]) {
      expect(names(await views(c, org.id))).toEqual(['Other']);
      expect(names(await views(c, org.id, true))).toEqual(['Juniper']);
    }
    // Its rows stay readable (Org settings → Views), and a move is a no-op.
    expect((await rows(amara, first.id)).counts).toEqual({ open: 0, done: 0 });
    await amara.ok('POST', `/api/v1/views/${first.id}/move`, {});
    expect(names(await views(amara, org.id))).toEqual(['Other']);
    const restored = await amara.ok<SavedView>('POST', `/api/v1/views/${first.id}/restore`);
    expect(restored.archivedAt).toBeNull();
    expect(await amara.ok<SavedView>('POST', `/api/v1/views/${first.id}/restore`)).toMatchObject({
      archivedAt: null,
      position: restored.position,
    });
    expect(names(await views(amara, org.id))).toEqual(['Other', 'Juniper']);
    expect(names(await views(bea, org.id))).toEqual(['Other', 'Juniper']);
    expect(names(await views(bea, org.id, true))).toEqual([]);
  });

  it('a repeated create with the same id returns the view; other content is 409', async () => {
    const { amara, org } = await team();
    const id = '019a0000-0000-7000-8000-0000000000a1';
    const body = { id, name: 'Today', query: { due: 'today', tags: [] }, shared: true };
    const first = await newView(amara, org.id, body);
    expect(await newView(amara, org.id, body)).toEqual(first);
    for (const other of [
      { ...body, name: 'Tomorrow' },
      { ...body, shared: false },
      { ...body, query: { due: 'week' } },
    ]) {
      const res = await amara.call('POST', `/api/v1/orgs/${org.id}/views`, other);
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'id_conflict' });
    }
    // The same ID in another org is someone else's.
    const res = await amara.call('POST', '/api/v1/orgs/personal/views', body);
    expect(res.status).toBe(409);
    expect(names(await views(amara, org.id))).toEqual(['Today']);
  });

  it('validates the query: the org’s tags, a member as assignee', async () => {
    const { ctx, amara, bea, org, juniper } = await team();
    const foreign = await newTag(amara, 'personal', 'home');
    const stranger = ctx.user('s@example.com');
    const bad = async (query: Record<string, unknown>, path: string) => {
      const res = await amara.call('POST', `/api/v1/orgs/${org.id}/views`, { name: 'X', query });
      expect(res.status, JSON.stringify(query)).toBe(422);
      const problem = (await res.json()) as { code: string; errors: { path: string }[] };
      expect(problem.code).toBe('validation_failed');
      expect(problem.errors.map((e) => e.path)).toEqual([path]);
    };
    await bad({ tags: [juniper.id, foreign.id] }, 'query.tags.1');
    await bad({ tags: ['019a0000-0000-7000-8000-0000000000ff'] }, 'query.tags.0');
    await bad({ assignee: stranger.userId }, 'query.assignee');
    const view = await newView(amara, org.id, {
      name: 'Bea’s',
      query: { assignee: bea.userId, tags: [juniper.id, juniper.id] },
    });
    // Duplicate tags are dropped.
    expect(view.query.tags).toEqual([juniper.id]);
    const res = await amara.call('PATCH', `/api/v1/views/${view.id}`, {
      query: { tags: [foreign.id] },
    });
    expect(res.status).toBe(422);
    // Unknown fields and bad values are schema errors.
    expect(
      (
        await amara.call('POST', `/api/v1/orgs/${org.id}/views`, {
          name: 'X',
          query: { due: 'someday' },
        })
      ).status,
    ).toBe(422);
    expect(
      (await amara.call('POST', `/api/v1/orgs/${org.id}/views`, { name: '', query: {} })).status,
    ).toBe(422);
  });

  it('updates name and query; any member may change a shared view, only its creator a private one', async () => {
    const { ctx, amara, bea, cy, org, juniper } = await team();
    const view = await newView(amara, org.id, { name: 'Juniper', query: {}, shared: true });
    const renamed = await bea.ok<SavedView>('PATCH', `/api/v1/views/${view.id}`, {
      name: 'Juniper launch',
      query: { tags: [juniper.id], status: 'any' },
    });
    expect(renamed).toMatchObject({
      name: 'Juniper launch',
      createdBy: amara.userId,
      query: { tags: [juniper.id], status: 'any' },
    });
    expect(renamed.updatedAt).toBe(NOW);
    // A patch without changes returns the view as it is.
    expect(
      await cy.ok<SavedView>('PATCH', `/api/v1/views/${view.id}`, { name: 'Juniper launch' }),
    ).toMatchObject({ name: 'Juniper launch' });
    expect((await amara.call('PATCH', `/api/v1/views/${view.id}`, {})).status).toBe(422);
    // Bea unshares it: private to Amara, gone for Bea and Cy (and their order of it).
    await cy.ok('POST', `/api/v1/views/${view.id}/move`, {});
    const unshared = await bea.ok<SavedView>('PATCH', `/api/v1/views/${view.id}`, {
      shared: false,
    });
    expect(unshared.shared).toBe(false);
    expect(names(await views(amara, org.id))).toEqual(['Juniper launch']);
    expect(names(await views(cy, org.id))).toEqual([]);
    expect((await bea.call('GET', `/api/v1/views/${view.id}/tasks`)).status).toBe(404);
    const cyPrefs = ctx.db.orm
      .select()
      .from(savedViewPref)
      .where(and(eq(savedViewPref.userId, cy.userId), eq(savedViewPref.viewId, view.id)))
      .all();
    expect(cyPrefs, 'the other members’ keys go with the share').toEqual([]);
    // Amara shares it again: at the end of Cy’s order.
    await newView(cy, org.id, { name: 'Cy’s', query: {} });
    await amara.ok('PATCH', `/api/v1/views/${view.id}`, { shared: true });
    expect(names(await views(cy, org.id))).toEqual(['Cy’s', 'Juniper launch']);
  });

  it('deletes a view for everyone; the tag and the tasks stay', async () => {
    const { ctx, amara, bea, org, juniper } = await team();
    const task = await createTask(amara, { title: 'T', tagIds: [juniper.id] }, org.id);
    const view = await newView(amara, org.id, {
      name: 'Juniper',
      query: { tags: [juniper.id] },
      shared: true,
    });
    await bea.ok('POST', `/api/v1/views/${view.id}/move`, {});
    await bea.ok('DELETE', `/api/v1/views/${view.id}`, undefined, 204);
    expect(names(await views(amara, org.id))).toEqual([]);
    expect((await amara.call('DELETE', `/api/v1/views/${view.id}`)).status).toBe(404);
    expect((await amara.ok<Task>('GET', `/api/v1/tasks/${task.id}`)).tagIds).toEqual([juniper.id]);
    expect(ctx.db.orm.select().from(savedViewPref).all()).toEqual([]);
  });

  it('in a personal org every view is private', async () => {
    const ctx = listCtx({ clock: () => NOW });
    const a = ctx.user('a@example.com');
    const view = await newView(a, 'personal', { name: 'Mine', query: {}, shared: true });
    expect(view.shared).toBe(false);
    const patched = await a.ok<SavedView>('PATCH', `/api/v1/views/${view.id}`, { shared: true });
    expect(patched.shared).toBe(false);
  });

  it('filters by assignee (me is the viewer), due in the viewer’s timezone, and status', async () => {
    const { amara, bea, org } = await team();
    await createTask(amara, { title: 'Mine today', dueDate: '2026-10-09' }, org.id);
    await createTask(amara, { title: 'Mine overdue', dueDate: '2026-10-01' }, org.id);
    await createTask(amara, { title: 'Mine next week', dueDate: '2026-10-20' }, org.id);
    await createTask(bea, { title: 'Bea’s today', dueDate: '2026-10-09' }, org.id);
    const none = await createTask(amara, { title: 'Unassigned', assigneeId: null }, org.id);
    expect(none.assigneeId).toBeNull();
    const done = await createTask(amara, { title: 'Done today', dueDate: '2026-10-09' }, org.id);
    await amara.ok('POST', `/api/v1/tasks/${done.id}/complete`, { completed: true });

    const mineToday = await newView(amara, org.id, {
      name: 'Mine today',
      query: { assignee: 'me', due: 'today' },
      shared: true,
    });
    // By due date: overdue first.
    expect(titles(await rows(amara, mineToday.id))).toEqual(['Mine overdue', 'Mine today']);
    expect(titles(await rows(bea, mineToday.id))).toEqual(['Bea’s today']);
    expect((await rows(amara, mineToday.id)).counts).toEqual({ open: 2, done: 1 });
    const unassigned = await newView(amara, org.id, {
      name: 'Nobody',
      query: { assignee: 'unassigned', due: 'none' },
    });
    expect(titles(await rows(amara, unassigned.id))).toEqual(['Unassigned']);
    const beas = await newView(amara, org.id, { name: 'Bea', query: { assignee: bea.userId } });
    expect(titles(await rows(amara, beas.id))).toEqual(['Bea’s today']);
    const doneView = await newView(amara, org.id, { name: 'Done', query: { status: 'done' } });
    expect(titles(await rows(amara, doneView.id))).toEqual(['Done today']);
    expect((await views(amara, org.id)).map((v) => [v.name, v.openCount])).toEqual([
      ['Mine today', 2],
      ['Nobody', 1],
      ['Bea', 1],
      ['Done', 5],
    ]);
    // UTC−10: 08:00Z is still the 8th, so the 9th is not today yet.
    await amara.ok('PATCH', '/api/v1/me', { timezone: 'Pacific/Honolulu' });
    expect(titles(await rows(amara, mineToday.id))).toEqual(['Mine overdue']);
  });
});

describe('AC-13.4 tags, grants and members', () => {
  it('deleting a tag removes it from every view’s query; merging remaps it', async () => {
    const { ctx, amara, bea, cy, org, juniper } = await team();
    const events = capture(ctx);
    const launch = await newTag(amara, org.id, 'launch');
    const other = await newTag(amara, org.id, 'other');
    const project = await newView(amara, org.id, {
      name: 'Juniper',
      query: { tags: [juniper.id] },
      shared: true,
    });
    const both = await newView(bea, org.id, {
      name: 'Both',
      query: { tags: [juniper.id, launch.id], tagMode: 'all' },
    });
    const untouched = await newView(bea, org.id, { name: 'Other', query: { tags: [other.id] } });
    await amara.ok('POST', `/api/v1/views/${project.id}/archive`);

    events.length = 0;
    await amara.ok('POST', `/api/v1/tags/${launch.id}/merge`, { intoId: juniper.id });
    const byName = async () =>
      new Map(
        [...(await views(bea, org.id)), ...(await views(amara, org.id, true))].map((v) => [
          v.name,
          v,
        ]),
      );
    let all = await byName();
    expect(all.get('Both')?.query.tags).toEqual([juniper.id]);
    expect(all.get('Juniper')?.query.tags).toEqual([juniper.id]);
    // Only Bea's private view changed: only Bea hears about views.
    const merged = events.find((e) => e.type === 'tag.merged');
    const viewAudience = merged?.audiences.find((a) => a.keys.some((k) => k[0] === 'views'));
    expect(viewAudience?.userIds).toEqual([bea.userId]);

    events.length = 0;
    await amara.ok('DELETE', `/api/v1/tags/${juniper.id}`, undefined, 204);
    all = await byName();
    expect(all.get('Both')?.query.tags).toEqual([]);
    expect(all.get('Juniper')?.query.tags).toEqual([]);
    expect(all.get('Other')?.query.tags).toEqual([other.id]);
    expect(untouched.updatedAt).toBe(all.get('Other')?.updatedAt);
    expect(both.id).toBe(all.get('Both')?.id);
    // The archived project view is shared: every member hears about it.
    const deleted = events.find((e) => e.type === 'tag.deleted');
    expect(
      deleted?.audiences
        .find((a) => a.keys.some((k) => k[0] === 'views'))
        ?.userIds.slice()
        .sort(),
    ).toEqual([amara.userId, bea.userId, cy.userId].sort());
  });

  it('a removed member’s private views and their order go; shared views they made stay', async () => {
    const { ctx, amara, bea, org } = await team();
    const shared = await newView(bea, org.id, { name: 'Bea shared', query: {}, shared: true });
    const priv = await newView(bea, org.id, { name: 'Bea private', query: {} });
    const amaras = await newView(amara, org.id, { name: 'Amara shared', query: {}, shared: true });
    await bea.ok('POST', `/api/v1/views/${amaras.id}/move`, { beforeId: shared.id });
    const personal = await newView(bea, 'personal', { name: 'Bea at home', query: {} });
    await amara.ok('DELETE', `/api/v1/orgs/${org.id}/members/${bea.userId}`, undefined, 204);
    const db = ctx.db.orm;
    expect(db.select().from(savedView).where(eq(savedView.id, priv.id)).all()).toEqual([]);
    expect(
      db.select().from(savedViewPref).where(eq(savedViewPref.userId, bea.userId)).all(),
    ).toEqual([{ userId: bea.userId, viewId: personal.id, position: personal.position }]);
    expect(names(await views(amara, org.id))).toEqual(['Bea shared', 'Amara shared']);
    expect((await views(amara, org.id))[0]?.createdBy).toBe(bea.userId);
    // Unshared, it would be nobody's: refused.
    const res = await amara.call('PATCH', `/api/v1/views/${shared.id}`, { shared: false });
    expect(res.status).toBe(422);
    expect(await res.json()).toMatchObject({ errors: [{ path: 'shared' }] });
    await amara.ok('PATCH', `/api/v1/views/${shared.id}`, { name: 'Renamed' });
    await amara.ok('DELETE', `/api/v1/views/${shared.id}`, undefined, 204);
  });

  it('reading needs tasks:read, managing groups:write with write access to the whole org', async () => {
    const { ctx, amara, org, juniper } = await team();
    const view = await newView(amara, org.id, {
      name: 'Juniper',
      query: { tags: [juniper.id] },
      shared: true,
    });
    const reader = bearer(ctx, (await pat(amara, ['tasks:read'])).token);
    expect((await reader.ok<SavedView[]>('GET', `/api/v1/orgs/${org.id}/views`)).length).toBe(1);
    await reader.ok('GET', `/api/v1/views/${view.id}/tasks`);
    const scope = await reader.problem(
      'POST',
      `/api/v1/orgs/${org.id}/views`,
      {
        name: 'X',
        query: {},
      },
      403,
    );
    expect(scope.code).toBe('forbidden_scope');
    expect(
      (await reader.problem('POST', `/api/v1/views/${view.id}/archive`, undefined, 403)).code,
    ).toBe('forbidden_scope');
    const writerNoRead = bearer(ctx, (await pat(amara, ['notifications:read'])).token);
    expect((await writerNoRead.call('GET', `/api/v1/orgs/${org.id}/views`)).status).toBe(403);
    expect((await writerNoRead.call('GET', `/api/v1/views/${view.id}/tasks`)).status).toBe(403);

    const { group: prio } = await amara.ok<{ group: { id: string } }>(
      'POST',
      `/api/v1/orgs/${org.id}/groups`,
      { name: 'P' },
      201,
    );
    const limited = bearer(
      ctx,
      (
        await pat(amara, ALL, {
          orgs: [{ orgId: org.id, read: 'all', write: { groups: [prio.id] } }],
        })
      ).token,
    );
    expect(
      (await limited.problem('POST', `/api/v1/orgs/${org.id}/views`, { name: 'X', query: {} }, 403))
        .code,
    ).toBe('outside_grant');
    expect(
      (await limited.problem('PATCH', `/api/v1/views/${view.id}`, { name: 'Y' }, 403)).code,
    ).toBe('outside_grant');
    const writer = bearer(ctx, (await pat(amara, ['groups:write'])).token);
    const made = await writer.ok<SavedView>(
      'POST',
      `/api/v1/orgs/${org.id}/views`,
      { name: 'Agent’s', query: {} },
      201,
    );
    await writer.ok('POST', `/api/v1/views/${made.id}/move`, { beforeId: view.id });
    await writer.ok('DELETE', `/api/v1/views/${made.id}`, undefined, 204);
    // An org the grant doesn't reach is 404, as for every org resource.
    const elsewhere = bearer(
      ctx,
      (
        await pat(amara, ALL, {
          orgs: [{ orgId: await personal(amara), read: 'all', write: 'all' }],
        })
      ).token,
    );
    expect((await elsewhere.call('GET', `/api/v1/orgs/${org.id}/views`)).status).toBe(404);
    expect((await elsewhere.call('GET', `/api/v1/views/${view.id}/tasks`)).status).toBe(404);
    expect((await elsewhere.call('DELETE', `/api/v1/views/${view.id}`)).status).toBe(404);
  });

  it('a grant limited to one group sees only the rows it may read, in rows and counts', async () => {
    const { ctx, amara, bea, org, juniper } = await team();
    const prio = await amara.ok<{ group: { id: string } }>(
      'POST',
      `/api/v1/orgs/${org.id}/groups`,
      { name: 'Prio' },
      201,
    );
    const inPrio = await createTask(
      amara,
      { title: 'In Prio', tagIds: [juniper.id], groupId: prio.group.id },
      org.id,
    );
    await createTask(amara, { title: 'Elsewhere', tagIds: [juniper.id] }, org.id);
    await createTask(bea, { title: 'Bea’s', tagIds: [juniper.id] }, org.id);
    // A subtask placed in Prio under a hidden parent: a row, but its parent stays hidden.
    // (Bea's parent is not in Amara's list; Amara's subtask of it is, placed on its own.)
    const hiddenParent = await createTask(bea, { title: 'Hidden parent' }, org.id);
    const placedSub = await createTask(
      amara,
      {
        title: 'Placed sub',
        parentId: hiddenParent.id,
        tagIds: [juniper.id],
        assigneeId: amara.userId,
      },
      org.id,
    );
    await amara.ok('POST', `/api/v1/tasks/${placedSub.id}/move`, { groupId: prio.group.id });
    // A subtask of a readable task is readable too; one of a hidden one is not.
    await createTask(
      amara,
      { title: 'Prio sub', parentId: inPrio.id, tagIds: [juniper.id] },
      org.id,
    );
    const done = await createTask(
      amara,
      { title: 'Prio done', tagIds: [juniper.id], groupId: prio.group.id },
      org.id,
    );
    await amara.ok('POST', `/api/v1/tasks/${done.id}/complete`, { completed: true });
    const view = await newView(bea, org.id, {
      name: 'Juniper',
      query: { tags: [juniper.id] },
      shared: true,
    });
    const full = await rows(amara, view.id);
    expect(full.counts).toEqual({ open: 5, done: 1 });
    // The browser gets the hidden parent as a breadcrumb.
    expect(titles(full)).toContain('Hidden parent');
    const limited = bearer(
      ctx,
      (
        await pat(amara, ['tasks:read'], {
          orgs: [{ orgId: org.id, read: { groups: [prio.group.id] }, write: 'none' }],
        })
      ).token,
    );
    const page = await limited.ok<SavedViewTasks>(
      'GET',
      `/api/v1/views/${view.id}/tasks?completed=true`,
    );
    // A parent the grant cannot read is neither sent as a breadcrumb nor named.
    expect(page.items.map((t) => t.title).sort()).toEqual([
      'In Prio',
      'Placed sub',
      'Prio done',
      'Prio sub',
    ]);
    expect(page.items.find((t) => t.title === 'Placed sub')?.parentId).toBeNull();
    expect(page.items.find((t) => t.title === 'Prio sub')?.parentId).toBe(inPrio.id);
    expect(page.counts).toEqual({ open: 3, done: 1 });
    const listed = await limited.ok<SavedView[]>('GET', `/api/v1/orgs/${org.id}/views`);
    expect(listed.map((v) => v.openCount)).toEqual([3]);
  });

  it('task moves between orgs leave views alone', async () => {
    const { amara, org, juniper } = await team();
    const task = await createTask(amara, { title: 'Travels', tagIds: [juniper.id] }, org.id);
    const view = await newView(amara, org.id, {
      name: 'Juniper',
      query: { tags: [juniper.id] },
      shared: true,
    });
    expect((await rows(amara, view.id)).counts.open).toBe(1);
    await amara.ok('POST', '/api/v1/tasks/move-to-org', {
      ids: [task.id],
      orgId: await personal(amara),
    });
    expect((await rows(amara, view.id)).counts.open).toBe(0);
    expect((await views(amara, org.id))[0]?.query.tags).toEqual([juniper.id]);
  });
});

describe('views over SSE', () => {
  it('shared changes reach every member, private ones and moves only their owner', async () => {
    const { ctx, amara, bea, cy, org } = await team();
    const events = capture(ctx);
    const audienceOf = (type: string) => {
      const event = events.find((e) => e.type === type);
      expect(event, type).toBeDefined();
      expect(event?.audiences.flatMap((a) => a.keys)).toEqual([['views', org.id]]);
      return event?.audiences
        .flatMap((a) => a.userIds)
        .slice()
        .sort();
    };
    const everyone = [amara.userId, bea.userId, cy.userId].sort();
    const shared = await newView(amara, org.id, { name: 'Shared', query: {}, shared: true });
    expect(audienceOf('view.created')).toEqual(everyone);
    events.length = 0;
    const priv = await newView(bea, org.id, { name: 'Private', query: {} });
    expect(audienceOf('view.created')).toEqual([bea.userId]);
    events.length = 0;
    await bea.ok('PATCH', `/api/v1/views/${priv.id}`, { name: 'Still private' });
    expect(audienceOf('view.updated')).toEqual([bea.userId]);
    events.length = 0;
    await bea.ok('PATCH', `/api/v1/views/${priv.id}`, { shared: true });
    expect(audienceOf('view.updated')).toEqual(everyone);
    events.length = 0;
    await cy.ok('PATCH', `/api/v1/views/${priv.id}`, { shared: false });
    expect(audienceOf('view.updated')).toEqual(everyone);
    events.length = 0;
    await cy.ok('POST', `/api/v1/views/${shared.id}/move`, {});
    expect(audienceOf('view.moved')).toEqual([cy.userId]);
    events.length = 0;
    await cy.ok('POST', `/api/v1/views/${shared.id}/archive`);
    expect(audienceOf('view.archived')).toEqual(everyone);
    events.length = 0;
    await cy.ok('POST', `/api/v1/views/${shared.id}/restore`);
    expect(audienceOf('view.restored')).toEqual(everyone);
    events.length = 0;
    await bea.ok('DELETE', `/api/v1/views/${priv.id}`, undefined, 204);
    expect(audienceOf('view.deleted')).toEqual([bea.userId]);
  });

  it('a grant stream gets the views key only with tasks:read', async () => {
    const { ctx, amara, org } = await team();
    const { visibleKeys } = await import('../src/services/grant-access.ts');
    const reader = await actorOf(ctx, (await pat(amara, ['tasks:read'])).token);
    const notifier = await actorOf(ctx, (await pat(amara, ['notifications:read'])).token);
    const keys = [['views', org.id]];
    const run = (actor: typeof reader) =>
      ctx.db.orm.transaction((tx) => visibleKeys(tx, actor, org.id, keys));
    expect(run(reader)).toEqual(keys);
    expect(run(notifier)).toEqual([]);
  });
});

async function personal(c: Caller): Promise<string> {
  const me = await c.ok<{ orgs: { id: string; isPersonal: boolean }[] }>('GET', '/api/v1/me');
  return me.orgs.find((o) => o.isPersonal)?.id ?? '';
}
