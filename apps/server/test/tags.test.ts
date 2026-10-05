import {
  type BulkResult,
  TAG_COLORS,
  type Tag,
  type Task,
  type TaskPage,
} from '@rooster/core/schemas';
import { describe, expect, it } from 'vitest';
import { type Caller, createTask, listCtx, myList, sharedOrg } from './list-helpers.ts';

const newTag = (c: Caller, body: Record<string, unknown>, org = 'personal') =>
  c.ok<Tag>('POST', `/api/v1/orgs/${org}/tags`, body, 201);

const listTags = (c: Caller, org = 'personal') => c.ok<Tag[]>('GET', `/api/v1/orgs/${org}/tags`);

const tagIdsOf = async (c: Caller, taskId: string) =>
  (await c.ok<Task>('GET', `/api/v1/tasks/${taskId}`)).tagIds;

describe('tag CRUD', () => {
  it('creates tags with round-robin colours unless one is given; lists by name', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const created: Tag[] = [];
    for (let i = 0; i < 11; i++) created.push(await newTag(a, { name: `t${i}` }));
    expect(created.map((t) => t.color)).toEqual([...TAG_COLORS, TAG_COLORS[0]]);
    const picked = await newTag(a, { name: 'Zed', color: 'pink' });
    expect(picked.color).toBe('pink');
    // The 13th tag continues the cycle.
    expect((await newTag(a, { name: 'another' })).color).toBe(TAG_COLORS[2]);
    const names = (await listTags(a)).map((t) => t.name);
    expect(names.slice(0, 2)).toEqual(['another', 't0']);
    expect(names.at(-1)).toBe('Zed');
  });

  it('names are unique per org, case-insensitively (Unicode too); other orgs are separate', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, [b]);
    await newTag(a, { name: 'Urgent' });
    await newTag(a, { name: 'Ärende' });
    for (const name of ['urgent', 'URGENT', ' Urgent ', 'ärende']) {
      const res = await a.call('POST', '/api/v1/orgs/personal/tags', { name });
      expect(res.status, name).toBe(409);
      expect(await res.json()).toMatchObject({ code: 'tag_name_taken' });
    }
    expect((await newTag(a, { name: 'urgent' }, org.id)).orgId).toBe(org.id);
  });

  it('a repeated create with the same id returns the tag; another name is 409', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const id = '019a0000-0000-7000-8000-0000000000f1';
    const first = await newTag(a, { id, name: 'Home' });
    expect(await newTag(a, { id, name: 'Home' })).toEqual(first);
    const res = await a.call('POST', '/api/v1/orgs/personal/tags', { id, name: 'Work' });
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ code: 'id_conflict' });
  });

  it('renames and recolours; a clashing rename is 409; a case-only rename is fine', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const home = await newTag(a, { name: 'home' });
    await newTag(a, { name: 'work' });
    const renamed = await a.ok<Tag>('PATCH', `/api/v1/tags/${home.id}`, {
      name: 'Home',
      color: 'teal',
    });
    expect(renamed).toMatchObject({ id: home.id, name: 'Home', color: 'teal' });
    const res = await a.call('PATCH', `/api/v1/tags/${home.id}`, { name: 'WORK' });
    expect(res.status).toBe(409);
  });

  it('delete removes the tag from every task', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const t = await createTask(a, { title: 'x', tagNames: ['one', 'two'] });
    const [one, two] = t.tagIds;
    await a.ok('DELETE', `/api/v1/tags/${one}`, undefined, 204);
    expect(await tagIdsOf(a, t.id)).toEqual([two]);
    expect((await listTags(a)).map((tag) => tag.id)).toEqual([two]);
    expect((await a.call('DELETE', `/api/v1/tags/${one}`)).status).toBe(404);
  });
});

describe('tag merge', () => {
  it('moves tasks onto the target (keeping chip order), then deletes the source', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const [first, from, into] = [
      await newTag(a, { name: 'first' }),
      await newTag(a, { name: 'from' }),
      await newTag(a, { name: 'into' }),
    ];
    const onlyFrom = await createTask(a, { title: 'only from', tagIds: [first.id, from.id] });
    await a.ok(
      'PUT',
      `/api/v1/tasks/${onlyFrom.id}/tags/${(await newTag(a, { name: 'last' })).id}`,
    );
    const both = await createTask(a, { title: 'both', tagIds: [into.id, from.id] });
    const merged = await a.ok<Tag>('POST', `/api/v1/tags/${from.id}/merge`, { intoId: into.id });
    expect(merged).toEqual(into);
    const onlyFromTags = await tagIdsOf(a, onlyFrom.id);
    expect(onlyFromTags.slice(0, 2)).toEqual([first.id, into.id]);
    expect(onlyFromTags).toHaveLength(3);
    expect(await tagIdsOf(a, both.id)).toEqual([into.id]);
    expect((await listTags(a)).map((t) => t.name)).toEqual(['first', 'into', 'last']);
  });

  it('merging into itself is 422; into another org’s tag is 404', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, [b]);
    const mine = await newTag(a, { name: 'mine' });
    const shared = await newTag(a, { name: 'shared' }, org.id);
    expect(
      (await a.call('POST', `/api/v1/tags/${mine.id}/merge`, { intoId: mine.id })).status,
    ).toBe(422);
    expect(
      (await a.call('POST', `/api/v1/tags/${mine.id}/merge`, { intoId: shared.id })).status,
    ).toBe(404);
    // b cannot see a's personal tags at all.
    expect((await b.call('PATCH', `/api/v1/tags/${mine.id}`, { name: 'x' })).status).toBe(404);
  });
});

describe('tags on tasks', () => {
  it('PUT/DELETE are idempotent set operations; tagIds keep the add order', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const [x, y, z] = [
      await newTag(a, { name: 'x' }),
      await newTag(a, { name: 'y' }),
      await newTag(a, { name: 'z' }),
    ];
    const t = await createTask(a, { title: 't' });
    for (const tag of [z, x, z, y]) await a.ok('PUT', `/api/v1/tasks/${t.id}/tags/${tag.id}`);
    expect(await tagIdsOf(a, t.id)).toEqual([z.id, x.id, y.id]);
    const removed = await a.ok<Task>('DELETE', `/api/v1/tasks/${t.id}/tags/${x.id}`);
    expect(removed.tagIds).toEqual([z.id, y.id]);
    await a.ok('DELETE', `/api/v1/tasks/${t.id}/tags/${x.id}`);
    // Re-adding puts it last.
    await a.ok('PUT', `/api/v1/tasks/${t.id}/tags/${x.id}`);
    expect((await myList(a)).tasks[0]?.tagIds).toEqual([z.id, y.id, x.id]);
  });

  it('a tag of another org is 404; a deleted task is 410', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, [b]);
    const shared = await newTag(a, { name: 'shared' }, org.id);
    const t = await createTask(a, { title: 't' });
    expect((await a.call('PUT', `/api/v1/tasks/${t.id}/tags/${shared.id}`)).status).toBe(404);
    const mine = await newTag(a, { name: 'mine' });
    await a.ok('DELETE', `/api/v1/tasks/${t.id}`, undefined, 204);
    expect((await a.call('PUT', `/api/v1/tasks/${t.id}/tags/${mine.id}`)).status).toBe(410);
  });

  it('create attaches tagIds then tagNames, matching names case-insensitively', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const b = ctx.user('b@example.com');
    const org = await sharedOrg(a, [b]);
    const urgent = await newTag(a, { name: 'Urgent' });
    const home = await newTag(a, { name: 'home' });
    const t = await createTask(a, {
      title: 't',
      tagIds: [home.id],
      tagNames: ['urgent', '#new', 'HOME', 'new'],
    });
    const fresh = (await listTags(a)).find((tag) => tag.name === 'new');
    expect(t.tagIds).toEqual([home.id, urgent.id, fresh?.id]);
    const foreign = await newTag(a, { name: 'foreign' }, org.id);
    const res = await a.call('POST', '/api/v1/orgs/personal/tasks', {
      title: 'x',
      tagIds: [foreign.id],
    });
    expect(res.status).toBe(422);
  });

  it('bulk addTag / removeTag report per-task results', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const tag = await newTag(a, { name: 'bulk' });
    const t1 = await createTask(a, { title: '1' });
    const t2 = await createTask(a, { title: '2' });
    const missing = '019a0000-0000-7000-8000-0000000000ee';
    const added = await a.ok<BulkResult>('POST', '/api/v1/tasks/bulk', {
      op: 'addTag',
      ids: [t1.id, t2.id, missing],
      args: { tagId: tag.id },
    });
    expect(added.results).toEqual([
      { id: t1.id, ok: true },
      { id: t2.id, ok: true },
      { id: missing, ok: false, code: 'not_found' },
    ]);
    expect(await tagIdsOf(a, t2.id)).toEqual([tag.id]);
    await a.ok('POST', '/api/v1/tasks/bulk', {
      op: 'removeTag',
      ids: [t1.id],
      args: { tagId: tag.id },
    });
    expect(await tagIdsOf(a, t1.id)).toEqual([]);
    expect(await tagIdsOf(a, t2.id)).toEqual([tag.id]);
  });
});

describe('AC-3.4 tag filter', () => {
  it('GET /orgs/:orgId/tasks?tag= filters by every given tag (ID or name)', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    await createTask(a, { title: 'urgent', tagNames: ['urgent'] });
    await createTask(a, { title: 'both', tagNames: ['urgent', 'home'] });
    await createTask(a, { title: 'none' });
    const urgent = (await listTags(a)).find((t) => t.name === 'urgent') as Tag;
    const titles = async (query: string) =>
      (await a.ok<TaskPage>('GET', `/api/v1/orgs/personal/tasks?${query}`)).items
        .map((t) => t.title)
        .sort();
    expect(await titles(`tag=${urgent.id}`)).toEqual(['both', 'urgent']);
    expect(await titles('tag=URGENT&tag=home')).toEqual(['both']);
    expect(await titles('tag=nope')).toEqual([]);
    expect(await titles('')).toEqual(['both', 'none', 'urgent']);
  });
});
