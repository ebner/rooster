// Security audit of Phase 11 (AC-11.1), boundary 3: grants and service authorisation.
// Each `it` names the finding it covers.
import type { Grant, Group, Tag, Task } from '@rooster/core/schemas';
import { describe, expect, it } from 'vitest';
import { ALL, bearer, pat } from './grant-helpers.ts';
import { groupNamed, listCtx, sharedOrg } from './list-helpers.ts';
import { API_RESOURCE, connect, oauthCtx, withToken } from './oauth-helpers.ts';

const code = async (res: Response) => ((await res.json()) as { code: string }).code;

/** The owner's personal org with a task in Prio and one in Today; a PAT limited to Prio. */
async function prioOnlySetup(scopes = ALL, read: 'all' | 'prio' = 'prio') {
  const ctx = listCtx();
  const owner = ctx.user('owner@example.com');
  const prio = await groupNamed(owner, 'Prio');
  const today = await groupNamed(owner, 'Today');
  const orgId = prio.orgId;
  const inPrio = await owner.ok<Task>(
    'POST',
    '/api/v1/orgs/personal/tasks',
    { title: 'In Prio', groupId: prio.id },
    201,
  );
  const constraints = {
    orgs: [
      {
        orgId,
        read: read === 'all' ? ('all' as const) : { groups: [prio.id] },
        write: { groups: [prio.id] },
      },
    ],
  };
  const api = bearer(ctx, (await pat(owner, scopes, constraints)).token);
  return { ctx, owner, prio, today, orgId, inPrio, api };
}

describe('boundary 3: grants and service authorisation', () => {
  it('P1 a grant with tasks:delete soft-deletes but cannot delete permanently', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const t = await owner.ok<Task>('POST', '/api/v1/orgs/personal/tasks', { title: 'T' }, 201);
    const api = bearer(ctx, (await pat(owner, ALL)).token);
    await api.ok('DELETE', `/api/v1/tasks/${t.id}`, undefined, 204);
    const purge = await api.call('DELETE', `/api/v1/tasks/${t.id}/permanent`);
    expect(purge.status).toBe(403);
    expect(await code(purge)).toBe('forbidden_scope');
    // Still in Trash, so the user can restore it; the browser may purge it.
    await owner.ok('POST', `/api/v1/tasks/${t.id}/restore`);
    await owner.ok('DELETE', `/api/v1/tasks/${t.id}`, undefined, 204);
    await owner.ok('DELETE', `/api/v1/tasks/${t.id}/permanent`, undefined, 204);
  });

  it('P2 splitting a group moves tasks, so it needs tasks:write beyond groups:write', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const prio = await groupNamed(owner, 'Prio');
    const a = await owner.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'A', groupId: prio.id },
      201,
    );
    await owner.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'B', groupId: prio.id, afterId: a.id },
      201,
    );
    const groupsOnly = bearer(ctx, (await pat(owner, ['groups:write'])).token);
    const split = await groupsOnly.call('POST', '/api/v1/orgs/personal/groups', {
      name: 'Below A',
      splitAfterTaskId: a.id,
    });
    expect(split.status).toBe(403);
    expect(await code(split)).toBe('forbidden_scope');
    // A plain group create still works with groups:write.
    await groupsOnly.ok<{ group: Group }>(
      'POST',
      '/api/v1/orgs/personal/groups',
      { name: 'Plain' },
      201,
    );
    const both = bearer(ctx, (await pat(owner, ['groups:write', 'tasks:write'])).token);
    const ok = await both.ok<{ moved: unknown[] }>(
      'POST',
      '/api/v1/orgs/personal/groups',
      { name: 'Below A', splitAfterTaskId: a.id },
      201,
    );
    expect(ok.moved).toHaveLength(1);
  });

  it('P2 creating a task with a new tag name needs org-wide write; existing tags attach', async () => {
    const { owner, prio, api } = await prioOnlySetup();
    const res = await api.call('POST', '/api/v1/orgs/personal/tasks', {
      title: 'Tagged',
      groupId: prio.id,
      tagNames: ['NewTag'],
    });
    expect(res.status).toBe(403);
    expect(await code(res)).toBe('outside_grant');
    const tags = await owner.ok<Tag[]>('GET', '/api/v1/orgs/personal/tags');
    expect(tags.map((t) => t.name)).not.toContain('NewTag');
    // The same through the `#tag` token of `parse: true`.
    const parsed = await api.call('POST', '/api/v1/orgs/personal/tasks', {
      title: 'Parsed #Fresh',
      groupId: prio.id,
      parse: true,
    });
    expect(parsed.status).toBe(403);
    await owner.ok<Tag>('POST', '/api/v1/orgs/personal/tags', { name: 'Existing' }, 201);
    const attached = await api.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'Tagged', groupId: prio.id, tagNames: ['existing'] },
      201,
    );
    expect(attached.tagIds).toHaveLength(1);
  });

  it('P2 an OAuth app lists only its own grant', async () => {
    const ctx = oauthCtx();
    const owner = ctx.user('owner@example.com');
    const other = await pat(owner, ['tasks:read'], { orgs: 'all' });
    const app = await connect(ctx, owner, { resource: API_RESOURCE });
    const res = await withToken(ctx, app.access, 'GET', '/api/v1/me/grants');
    expect(res.status).toBe(200);
    const listed = (await res.json()) as Grant[];
    expect(listed.map((g) => g.id)).toEqual([app.grantId]);
    expect(listed[0]?.current).toBe(true);
    expect(JSON.stringify(listed)).not.toContain(other.grant.id);
    // A PAT and the browser still see every grant.
    const all = await owner.ok<Grant[]>('GET', '/api/v1/me/grants');
    expect(all.map((g) => g.id).sort()).toEqual([app.grantId, other.grant.id].sort());
  });

  it('P3 Trash cursors are built from readable rows only', async () => {
    const { owner, today, orgId, api } = await prioOnlySetup(['tasks:read'], 'prio');
    for (const title of ['Hidden 1', 'Hidden 2']) {
      const t = await owner.ok<Task>(
        'POST',
        '/api/v1/orgs/personal/tasks',
        { title, groupId: today.id },
        201,
      );
      await owner.ok('DELETE', `/api/v1/tasks/${t.id}`, undefined, 204);
    }
    const page = await api.ok<{ items: Task[]; nextCursor: string | null }>(
      'GET',
      `/api/v1/orgs/${orgId}/trash?limit=1`,
    );
    expect(page.items).toEqual([]);
    expect(page.nextCursor).toBeNull();
    // The browser pages through both.
    const browser = await owner.ok<{ items: Task[]; nextCursor: string | null }>(
      'GET',
      `/api/v1/orgs/${orgId}/trash?limit=1`,
    );
    expect(browser.items).toHaveLength(1);
    expect(browser.nextCursor).not.toBeNull();
  });

  it('P3 notification cursors are built from readable rows only', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const bob = ctx.user('bob@example.com');
    const org = await sharedOrg(owner, [bob]);
    const prio = await groupNamed(owner, 'Prio', org.id);
    // Bob gives the owner two tasks: they land in the owner's Inbox, outside Prio.
    for (const title of ['For you 1', 'For you 2']) {
      await bob.ok<Task>(
        'POST',
        `/api/v1/orgs/${org.id}/tasks`,
        { title, assigneeId: owner.userId },
        201,
      );
    }
    const browser = await owner.ok<{ items: unknown[]; nextCursor: string | null }>(
      'GET',
      '/api/v1/notifications?limit=1',
    );
    expect(browser.nextCursor).not.toBeNull();
    const constraints = {
      orgs: [{ orgId: org.id, read: { groups: [prio.id] }, write: 'none' as const }],
    };
    const api = bearer(
      ctx,
      (await pat(owner, ['tasks:read', 'notifications:read'], constraints)).token,
    );
    const page = await api.ok<{ items: { type: string }[]; nextCursor: string | null }>(
      'GET',
      '/api/v1/notifications?limit=1',
    );
    // Only the org-level "Bob joined" is readable: the hidden assignments neither fill the page
    // nor end up in a cursor.
    expect(page.items.map((n) => n.type)).toEqual(['invite_accepted']);
    expect(page.nextCursor).toBeNull();
  });

  it('P3 a destination group the grant cannot read is 404, without its name', async () => {
    const { owner, inPrio, api } = await prioOnlySetup(['tasks:write'], 'prio');
    const secret = await owner.ok<{ group: Group }>(
      'POST',
      '/api/v1/orgs/personal/groups',
      { name: 'ConfidentialAcquisition' },
      201,
    );
    const move = await api.call('POST', `/api/v1/tasks/${inPrio.id}/move`, {
      groupId: secret.group.id,
    });
    expect(move.status).toBe(404);
    expect(await move.text()).not.toContain('ConfidentialAcquisition');
    const bulk = await api.call('POST', '/api/v1/tasks/bulk', {
      op: 'move',
      ids: [inPrio.id],
      args: { groupId: secret.group.id },
    });
    expect(await bulk.text()).not.toContain('ConfidentialAcquisition');
    const create = await api.call('POST', '/api/v1/orgs/personal/tasks', {
      title: 'Sneaky',
      groupId: secret.group.id,
    });
    expect(create.status).toBe(404);
    expect(await create.text()).not.toContain('ConfidentialAcquisition');
    // A `>group` token does not match a hidden group either: it stays in the title, and the
    // task lands where the grant may write... or is refused without naming the group.
    const parsed = await api.call('POST', '/api/v1/orgs/personal/tasks', {
      title: 'Probe >Confidential',
      parse: true,
    });
    expect(await parsed.text()).not.toContain('ConfidentialAcquisition');
  });

  it('P3 a readable destination outside the write constraint is still explained', async () => {
    const { inPrio, today, api } = await prioOnlySetup(['tasks:write'], 'all');
    const move = await api.call('POST', `/api/v1/tasks/${inPrio.id}/move`, {
      groupId: today.id,
    });
    expect(move.status).toBe(403);
    const body = (await move.json()) as { code: string; detail: string };
    expect(body.code).toBe('outside_grant');
    expect(body.detail).toContain('"Today"');
  });
});
