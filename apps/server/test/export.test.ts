import { type OrgExport, orgExportSchema } from '@rooster/core/schemas';
import { describe, expect, it } from 'vitest';
import { renderExportMarkdown } from '../src/services/export-service.ts';
import { createTask, groupNamed, listCtx, sharedOrg } from './list-helpers.ts';

describe('export (FR-SET-5, 06 §2.8)', () => {
  /** 2026-10-05 22:30 UTC is already 6 Oct in Stockholm. */
  async function fixture() {
    const now = Date.UTC(2026, 9, 5, 22, 30);
    const ctx = listCtx({ clock: () => now });
    const a = ctx.user('a@example.com', 'Ada');
    const b = ctx.user('b@example.com', 'Bob');
    await a.ok('PATCH', '/api/v1/me', { timezone: 'Europe/Stockholm' });
    const org = await sharedOrg(a, [b], 'Team');
    const prio = await groupNamed(a, 'Prio', org.id);
    const today = await groupNamed(a, 'Today', org.id);
    const report = await createTask(
      a,
      {
        title: 'Write report',
        groupId: prio.id,
        dueDate: '2026-10-12',
        dueTime: '14:00',
        dueTz: 'Europe/Stockholm',
        tagNames: ['work', 'Q4'],
        description: 'Cover **sales**.\n\nAnd costs.',
      },
      org.id,
    );
    const outline = await createTask(a, { title: 'Outline', parentId: report.id }, org.id);
    await createTask(a, { title: 'Sources', parentId: outline.id }, org.id);
    const done = await createTask(a, { title: 'Book room', groupId: prio.id }, org.id);
    await a.ok('POST', `/api/v1/tasks/${done.id}/complete`, { completed: true });
    await createTask(
      a,
      { title: 'Inbox item', startDate: '2026-10-01', dueDate: '2026-10-03' },
      org.id,
    );
    const gone = await createTask(a, { title: 'Deleted', groupId: today.id }, org.id);
    await a.ok('DELETE', `/api/v1/tasks/${gone.id}`, undefined, 204);
    // Someone else's task and an unused tag stay out.
    await createTask(b, { title: 'Bob task', tagNames: ['unused'] }, org.id);
    return { ctx, a, b, org };
  }

  it('JSON: a lossless, schema-valid attachment of my groups, tasks and their tags', async () => {
    const { a, org } = await fixture();
    const res = await a.call('GET', `/api/v1/orgs/${org.slug}/export`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toMatch(/^application\/json/);
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="rooster-${org.slug}-2026-10-06.json"`,
    );
    const data = (await res.json()) as OrgExport;
    expect(orgExportSchema.safeParse(data).success).toBe(true);
    expect(data).toMatchObject({
      format: 'rooster-export',
      version: 1,
      org: { id: org.id, slug: org.slug, name: 'Team' },
      user: { id: a.userId, email: 'a@example.com', name: 'Ada' },
      comments: [],
    });
    expect(data.groups.map((g) => g.name)).toEqual(['Inbox', 'Today', 'Prio', 'Upcoming']);
    // Group order, then position; subtasks right after their parent, depth first.
    expect(data.tasks.map((t) => t.title)).toEqual([
      'Inbox item',
      'Write report',
      'Outline',
      'Sources',
      'Book room',
    ]);
    expect(data.tasks[1]?.description).toBe('Cover **sales**.\n\nAnd costs.');
    expect(data.tasks[2]?.placement).toBeNull();
    expect(data.tags.map((t) => t.name).sort()).toEqual(['Q4', 'work']);
  });

  it('Markdown: a readable, deterministic rendering', async () => {
    const { a, org } = await fixture();
    const res = await a.call('GET', `/api/v1/orgs/${org.id}/export?format=markdown`);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/markdown; charset=utf-8');
    expect(res.headers.get('content-disposition')).toBe(
      `attachment; filename="rooster-${org.slug}-2026-10-06.md"`,
    );
    const text = await res.text();
    expect(text).toBe(
      [
        '# Team',
        '',
        '## Inbox',
        '',
        '- [ ] Inbox item — start 2026-10-01, due 2026-10-03',
        '',
        '## Today',
        '',
        '## Prio',
        '',
        '- [ ] Write report — due 2026-10-12 14:00 #work #Q4',
        '',
        '  Cover **sales**.',
        '',
        '  And costs.',
        '',
        '  - [ ] Outline',
        '    - [ ] Sources',
        '- [x] Book room',
        '',
        '## Upcoming',
        '',
      ].join('\n'),
    );
    // The same data always renders the same text.
    const json = (await (
      await a.call('GET', `/api/v1/orgs/${org.id}/export?format=json`)
    ).json()) as OrgExport;
    expect(renderExportMarkdown(json)).toBe(text);
  });

  it('each member exports only their own list; outsiders get 404', async () => {
    const { ctx, b, org } = await fixture();
    const data = await b.ok<OrgExport>('GET', `/api/v1/orgs/${org.id}/export`);
    expect(data.tasks.map((t) => t.title)).toEqual(['Bob task']);
    expect(data.tags.map((t) => t.name)).toEqual(['unused']);
    const c = ctx.user('c@example.com');
    expect((await c.call('GET', `/api/v1/orgs/${org.id}/export`)).status).toBe(404);
    expect((await c.call('GET', `/api/v1/orgs/${org.id}/export?format=pdf`)).status).toBe(422);
  });
});
