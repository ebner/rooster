// Security audit of Phase 11 (AC-11.1), boundary 3: grants and service authorisation.
// Each `it` names the finding it covers.
import type { Grant, Group, Tag, Task } from '@rooster/core/schemas';
import { describe, expect, it } from 'vitest';
import { ALL, bearer, deviceCode, deviceNonce, pat, pollToken } from './grant-helpers.ts';
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

describe('boundary 3, round 3', () => {
  it('P2 a grant matches @person on names, never on a colleague’s email prefix', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const quinn = ctx.user('q7@x.test', 'Robin Seven');
    const org = await sharedOrg(owner, [quinn]);
    await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'Quarterly plan', assigneeId: quinn.userId },
      201,
    );
    const api = bearer(ctx, (await pat(owner, ['tasks:read'])).token);
    const titles = async (caller: { ok: <T>(m: string, p: string) => Promise<T> }, q: string) => {
      const hits = await caller.ok<{ task: Task }[]>(
        'GET',
        `/api/v1/search?orgId=${org.id}&q=${encodeURIComponent(q)}`,
      );
      const page = await caller.ok<{ items: Task[] }>(
        'GET',
        `/api/v1/orgs/${org.id}/tasks?view=everyone&q=${encodeURIComponent(q)}`,
      );
      return [hits.map((h) => h.task.title), page.items.map((t) => t.title)];
    };
    for (const q of ['@q', '@q7', '@q7@x']) {
      expect(await titles(api, q), q).toEqual([[], []]);
    }
    expect(await titles(api, '@robin')).toEqual([['Quarterly plan'], ['Quarterly plan']]);
    // The browser still matches emails.
    expect(await titles(owner, '@q7')).toEqual([['Quarterly plan'], ['Quarterly plan']]);
  });

  it('P2 a device approval needs the nonce its own session was shown', async () => {
    const ctx = listCtx();
    const alice = ctx.user('alice@example.com');
    const bob = ctx.user('bob@example.com');
    const code = await deviceCode(ctx, 'tasks:read');
    // Bob's session once looked at the code too; the page shows it to Alice.
    await deviceNonce(bob, code.user_code);
    const decisionNonce = await deviceNonce(alice, code.user_code);
    // The browser's cookie changes to Bob's; the page posts Alice's decision.
    const approve = await bob.call('POST', `/api/v1/device/${code.user_code}/approve`, {
      decisionNonce,
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
    });
    expect(approve.status).toBe(404);
    const deny = await bob.call('POST', `/api/v1/device/${code.user_code}/deny`, {
      decisionNonce,
    });
    expect(deny.status).toBe(404);
    const forged = await alice.call('POST', `/api/v1/device/${code.user_code}/approve`, {
      decisionNonce: 'forged',
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
    });
    expect(forged.status).toBe(404);
    const grant = await alice.ok<Grant>('POST', `/api/v1/device/${code.user_code}/approve`, {
      decisionNonce,
      scopes: ['tasks:read'],
      constraints: { orgs: 'all' },
    });
    const token = await pollToken(ctx, code.device_code);
    expect(token.status).toBe(200);
    const me = await bearer(ctx, token.body.access_token as string).ok<{ id: string }>(
      'GET',
      '/api/v1/me',
    );
    expect(me.id).toBe(alice.userId);
    expect(grant.kind).toBe('device');
  });

  it('P3 activity cursors are built from visible entries only', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const bob = ctx.user('bob@example.com');
    const org = await sharedOrg(owner, [bob]);
    const prio = await groupNamed(owner, 'Prio', org.id);
    const today = await groupNamed(owner, 'Today', org.id);
    const t = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'T', groupId: prio.id },
      201,
    );
    // Bob's subtask S shows under T; the owner's G under S sits in Today, outside the grant.
    const s = await bob.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'S', parentId: t.id, assigneeId: bob.userId },
      201,
    );
    const g = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'G', parentId: s.id, assigneeId: owner.userId },
      201,
    );
    await owner.ok('POST', `/api/v1/tasks/${g.id}/move`, { groupId: today.id });
    const constraints = {
      orgs: [{ orgId: org.id, read: { groups: [prio.id] }, write: 'none' as const }],
    };
    const api = bearer(ctx, (await pat(owner, ['tasks:read'], constraints)).token);
    const page = await api.ok<{ items: unknown[]; nextCursor: string | null }>(
      'GET',
      `/api/v1/tasks/${s.id}/activity?limit=1`,
    );
    expect(page.items).toHaveLength(1);
    expect(JSON.stringify(page)).not.toContain(g.id);
    if (page.nextCursor !== null) {
      expect(Buffer.from(page.nextCursor, 'base64url').toString()).not.toContain(g.id);
    }
    // The browser sees the hidden entry and pages past it.
    const browser = await owner.ok<{ items: unknown[]; nextCursor: string | null }>(
      'GET',
      `/api/v1/tasks/${s.id}/activity?limit=1`,
    );
    expect(JSON.stringify(browser.items)).toContain(g.id);
    expect(browser.nextCursor).not.toBeNull();
  });

  it('P3 a group the grant cannot read is 404 for PATCH, move, delete and restore', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const prio = await groupNamed(owner, 'Prio');
    const today = await groupNamed(owner, 'Today');
    const gone = await owner.ok<{ group: Group }>(
      'POST',
      '/api/v1/orgs/personal/groups',
      { name: 'Gone' },
      201,
    );
    await owner.ok('DELETE', `/api/v1/groups/${gone.group.id}`, {}, 204);
    const constraints = {
      orgs: [{ orgId: prio.orgId, read: { groups: [prio.id] }, write: 'all' as const }],
    };
    const api = bearer(ctx, (await pat(owner, ALL, constraints)).token);
    const unknown = '0199a1b2-0000-7000-8000-00000000dead';
    for (const id of [today.id, unknown]) {
      for (const [method, path, body] of [
        ['PATCH', `/api/v1/groups/${id}`, { name: 'X' }],
        ['POST', `/api/v1/groups/${id}/move`, { afterId: prio.id }],
        ['DELETE', `/api/v1/groups/${id}`, {}],
      ] as const) {
        const res = await api.call(method, path, body);
        expect(res.status, `${method} ${path}`).toBe(404);
        expect(await res.text()).not.toContain('Today');
      }
    }
    expect((await api.call('POST', `/api/v1/groups/${gone.group.id}/restore`)).status).toBe(404);
    expect((await api.call('POST', `/api/v1/groups/${unknown}/restore`)).status).toBe(404);
  });
});

describe('boundary 3, round 5', () => {
  /**
   * The owner's T sits in `tGroup`; Bob's subtask S shows under it; the owner's G under S has its
   * own placement in `gGroup`. A grant reading only Prio sees whichever sits in Prio.
   */
  async function family(tIn: 'Prio' | 'Today', gIn: 'Prio' | 'Today') {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const bob = ctx.user('bob@example.com');
    const org = await sharedOrg(owner, [bob]);
    const prio = await groupNamed(owner, 'Prio', org.id);
    const today = await groupNamed(owner, 'Today', org.id);
    const groupOf = (name: 'Prio' | 'Today') => (name === 'Prio' ? prio : today);
    const t = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'T', groupId: groupOf(tIn).id },
      201,
    );
    const s = await bob.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'S', parentId: t.id, assigneeId: bob.userId },
      201,
    );
    const g = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'G', parentId: s.id, assigneeId: owner.userId },
      201,
    );
    await owner.ok('POST', `/api/v1/tasks/${g.id}/move`, { groupId: groupOf(gIn).id });
    const readPrio = (write: 'none' | 'all') => ({
      orgs: [{ orgId: org.id, read: { groups: [prio.id] }, write }],
    });
    return { ctx, owner, bob, org, prio, today, t, s, g, readPrio };
  }

  it('P2 a group delete or restore must reach every task it cascades to', async () => {
    const { ctx, owner, org, prio, t, g, readPrio } = await family('Prio', 'Today');
    const api = bearer(ctx, (await pat(owner, ALL, readPrio('all'))).token);
    const del = await api.call('DELETE', `/api/v1/groups/${prio.id}`, { deleteTasks: true });
    expect(del.status).toBe(404);
    expect((await owner.ok<Task>('GET', `/api/v1/tasks/${g.id}`)).deletedAt).toBeUndefined();
    expect((await owner.ok<Task>('GET', `/api/v1/tasks/${t.id}`)).deletedAt).toBeUndefined();
    // The browser deletes it with everything; the grant cannot restore what it cannot see.
    await owner.ok('DELETE', `/api/v1/groups/${prio.id}`, { deleteTasks: true }, 204);
    const restore = await api.call('POST', `/api/v1/groups/${prio.id}/restore`);
    expect(restore.status).toBe(404);
    const trash = await owner.ok<{ items: Task[] }>('GET', `/api/v1/orgs/${org.id}/trash`);
    expect(trash.items.map((i) => i.id)).toContain(t.id);
  });

  it('P3 a create naming a hidden group’s ID is just "in use", whatever the name', async () => {
    const { ctx, owner, org, today, readPrio } = await family('Prio', 'Today');
    const api = bearer(ctx, (await pat(owner, ['groups:write'], readPrio('all'))).token);
    for (const name of ['Today', 'Wrong']) {
      const res = await api.call('POST', `/api/v1/orgs/${org.id}/groups`, { id: today.id, name });
      expect(res.status, name).toBe(409);
      const text = await res.text();
      expect(text).toContain('id_conflict');
      expect(text).not.toContain('Today');
    }
  });

  it('P3 subtask counts include only subtasks the grant can read', async () => {
    const { ctx, owner, s, g, readPrio } = await family('Prio', 'Today');
    const api = bearer(ctx, (await pat(owner, ['tasks:read'], readPrio('none'))).token);
    const seen = await api.ok<Task & { subtasks: Task[] }>('GET', `/api/v1/tasks/${s.id}`);
    expect(seen.subtasks).toEqual([]);
    expect(seen.counts.subtasks).toBe(0);
    await owner.ok('POST', `/api/v1/tasks/${g.id}/complete`, { completed: true });
    const again = await api.ok<Task>('GET', `/api/v1/tasks/${s.id}`);
    expect(again.counts).toMatchObject({ subtasks: 0, subtasksDone: 0 });
    const browser = await owner.ok<Task>('GET', `/api/v1/tasks/${s.id}`);
    expect(browser.counts).toMatchObject({ subtasks: 1, subtasksDone: 1 });
  });

  it('P3 a parent the grant cannot read is not named in parentId', async () => {
    const { ctx, owner, org, s, g, readPrio } = await family('Today', 'Prio');
    const api = bearer(ctx, (await pat(owner, ['tasks:read'], readPrio('none'))).token);
    expect((await api.call('GET', `/api/v1/tasks/${s.id}`)).status).toBe(404);
    const detail = await api.ok<Task>('GET', `/api/v1/tasks/${g.id}`);
    expect(detail.parentId).toBeNull();
    const list = await api.ok<{ items: Task[] }>('GET', `/api/v1/orgs/${org.id}/tasks?view=my`);
    expect(JSON.stringify(list)).not.toContain(s.id);
    expect((await owner.ok<Task>('GET', `/api/v1/tasks/${g.id}`)).parentId).toBe(s.id);
  });

  it('P3 an outside_grant explanation never names a group the grant cannot read', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const prio = await groupNamed(owner, 'Prio');
    const secret = await owner.ok<{ group: Group }>(
      'POST',
      '/api/v1/orgs/personal/groups',
      { name: 'ConfidentialAcquisition' },
      201,
    );
    const t = await owner.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'In Prio', groupId: prio.id },
      201,
    );
    const constraints = {
      orgs: [
        { orgId: prio.orgId, read: { groups: [prio.id] }, write: { groups: [secret.group.id] } },
      ],
    };
    const api = bearer(ctx, (await pat(owner, ['tasks:write'], constraints)).token);
    const res = await api.call('PATCH', `/api/v1/tasks/${t.id}`, { title: 'X' });
    expect(res.status).toBe(403);
    const body = (await res.json()) as { code: string; detail: string };
    expect(body.code).toBe('outside_grant');
    expect(body.detail).not.toContain('ConfidentialAcquisition');
    expect(body.detail).toContain('one other group');
  });
});

describe('boundary 3, round 6', () => {
  async function family() {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const bob = ctx.user('bob@example.com');
    const org = await sharedOrg(owner, [bob]);
    const prio = await groupNamed(owner, 'Prio', org.id);
    const today = await groupNamed(owner, 'Today', org.id);
    const t = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'T', groupId: prio.id },
      201,
    );
    const s = await bob.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'S', parentId: t.id, assigneeId: bob.userId },
      201,
    );
    const g = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'G secret', description: 'hidden text', parentId: s.id, assigneeId: owner.userId },
      201,
    );
    await owner.ok('POST', `/api/v1/tasks/${g.id}/move`, { groupId: today.id });
    const constraints = {
      orgs: [{ orgId: org.id, read: { groups: [prio.id] }, write: 'all' as const }],
    };
    return { ctx, owner, bob, org, prio, today, t, s, g, constraints };
  }

  it('P2 a reassignment that would move a hidden subtask into view is refused', async () => {
    const { ctx, owner, s, g, constraints } = await family();
    const api = bearer(ctx, (await pat(owner, ['tasks:write', 'tasks:assign'], constraints)).token);
    expect((await api.call('GET', `/api/v1/tasks/${g.id}`)).status).toBe(404);
    const patch = await api.call('PATCH', `/api/v1/tasks/${s.id}`, { assigneeId: owner.userId });
    expect(patch.status).toBe(404);
    const bulk = await api.ok<{ results: { id: string; ok: boolean }[] }>(
      'POST',
      '/api/v1/tasks/bulk',
      { op: 'assign', ids: [s.id], args: { assigneeId: owner.userId } },
    );
    expect(JSON.stringify(bulk)).not.toContain('"ok":true');
    // G is still placed in Today, out of the grant's view.
    expect((await api.call('GET', `/api/v1/tasks/${g.id}`)).status).toBe(404);
    expect((await owner.ok<Task>('GET', `/api/v1/tasks/${s.id}`)).assigneeId).not.toBe(
      owner.userId,
    );
  });

  it('P3 a retried create or duplicate naming a hidden task is "in use", whatever its content', async () => {
    const { ctx, owner, org, prio, today, constraints } = await family();
    // The owner's top-level task H, in Today: hidden from the grant.
    const g = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'G secret', groupId: today.id },
      201,
    );
    const api = bearer(ctx, (await pat(owner, ['tasks:write'], constraints)).token);
    const source = await api.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'G secret', groupId: prio.id },
      201,
    );
    for (const title of ['G secret', 'wrong guess']) {
      const create = await api.call('POST', `/api/v1/orgs/${org.id}/tasks`, {
        id: g.id,
        title,
        groupId: prio.id,
      });
      expect(create.status, title).toBe(409);
    }
    const other = await api.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'wrong guess', groupId: prio.id },
      201,
    );
    for (const from of [source, other]) {
      const dup = await api.call('POST', `/api/v1/tasks/${from.id}/duplicate`, { id: g.id });
      expect(dup.status, from.title).toBe(409);
    }
  });

  it('P3 a split names a hidden task 404, deleted or not', async () => {
    const { ctx, owner, org, g, constraints } = await family();
    const api = bearer(ctx, (await pat(owner, ['groups:write', 'tasks:write'], constraints)).token);
    const split = (id: string) =>
      api.call('POST', `/api/v1/orgs/${org.id}/groups`, { name: 'X', splitAfterTaskId: id });
    expect((await split(g.id)).status).toBe(404);
    await owner.ok('DELETE', `/api/v1/tasks/${g.id}`, undefined, 204);
    expect((await split(g.id)).status).toBe(404);
    expect((await split('0199a1b2-0000-7000-8000-00000000dead')).status).toBe(404);
  });
});

describe('systematic pass: ordering intents naming hidden neighbours', () => {
  it('a subtask placed after a hidden sibling lands as if the sibling were unknown (the end)', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const bob = ctx.user('bob@example.com');
    const org = await sharedOrg(owner, [bob]);
    const prio = await groupNamed(owner, 'Prio', org.id);
    const today = await groupNamed(owner, 'Today', org.id);
    const t = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'T', groupId: prio.id },
      201,
    );
    const s = await bob.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'S', parentId: t.id, assigneeId: bob.userId },
      201,
    );
    const sub = (title: string, assigneeId: string, by = bob) =>
      by.ok<Task>(
        'POST',
        `/api/v1/orgs/${org.id}/tasks`,
        { title, parentId: s.id, assigneeId },
        201,
      );
    const v = await sub('V', bob.userId);
    const g = await sub('G', owner.userId, owner);
    await owner.ok('POST', `/api/v1/tasks/${g.id}/move`, { groupId: today.id });
    const w = await sub('W', bob.userId);
    const constraints = {
      orgs: [{ orgId: org.id, read: { groups: [prio.id] }, write: 'all' as const }],
    };
    const api = bearer(ctx, (await pat(owner, ['tasks:write'], constraints)).token);
    const wPos = (await owner.ok<Task>('GET', `/api/v1/tasks/${w.id}`)).subtaskPosition as string;
    const moved = await api.ok<{ subtaskPosition: string }>(
      'POST',
      `/api/v1/tasks/${v.id}/reorder`,
      { afterId: g.id },
    );
    // Not between G and W, but at the end, as for an unknown neighbour.
    expect(moved.subtaskPosition > wPos).toBe(true);
    const created = await api.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'X', parentId: s.id, afterId: g.id },
      201,
    );
    expect((created.subtaskPosition as string) > moved.subtaskPosition).toBe(true);
  });

  it('a group placed after a hidden group lands as if that group were unknown (the end)', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const groups = (await owner.ok<{ groups: Group[] }>('GET', '/api/v1/orgs/personal/my-list'))
      .groups;
    const normal = groups.filter((g) => g.kind === 'normal');
    const first = normal[0] as Group;
    const readable = normal.filter((g) => g.id !== first.id);
    const constraints = {
      orgs: [
        {
          orgId: first.orgId,
          read: { groups: readable.map((g) => g.id) },
          write: 'all' as const,
        },
      ],
    };
    const api = bearer(ctx, (await pat(owner, ['groups:write'], constraints)).token);
    const target = readable[readable.length - 1] as Group;
    const maxPos = normal
      .map((g) => g.position)
      .sort()
      .at(-1) as string;
    const created = await api.ok<{ group: Group }>(
      'POST',
      '/api/v1/orgs/personal/groups',
      { name: 'New', afterId: first.id },
      201,
    );
    expect(created.group.position > maxPos).toBe(true);
    const moved = await api.ok<{ position: string }>(
      'POST',
      `/api/v1/groups/${readable[0]?.id}/move`,
      { afterId: first.id },
    );
    expect(moved.position > created.group.position).toBe(true);
    expect(target).toBeDefined();
  });
});

describe('boundary 3, final', () => {
  it('P2 duplicating a subtask needs the grant to read and write its parent', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const bob = ctx.user('bob@example.com');
    const org = await sharedOrg(owner, [bob]);
    const prio = await groupNamed(owner, 'Prio', org.id);
    const today = await groupNamed(owner, 'Today', org.id);
    const t = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'T', groupId: today.id },
      201,
    );
    const s = await bob.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'S', parentId: t.id, assigneeId: bob.userId },
      201,
    );
    const g = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'G', parentId: s.id, assigneeId: owner.userId },
      201,
    );
    await owner.ok('POST', `/api/v1/tasks/${g.id}/move`, { groupId: prio.id });
    const constraints = {
      orgs: [{ orgId: org.id, read: { groups: [prio.id] }, write: 'all' as const }],
    };
    const api = bearer(ctx, (await pat(owner, ['tasks:write'], constraints)).token);
    expect((await api.call('GET', `/api/v1/tasks/${s.id}`)).status).toBe(404);
    const dup = await api.call('POST', `/api/v1/tasks/${g.id}/duplicate`, {});
    expect(dup.status).toBe(404);
    expect((await owner.ok<Task>('GET', `/api/v1/tasks/${s.id}`)).counts.subtasks).toBe(1);
  });

  it('P2 restoring a group brings a subtask back top-level when its parent is in Trash', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const bob = ctx.user('bob@example.com');
    const org = await sharedOrg(owner, [bob]);
    const prio = await groupNamed(owner, 'Prio', org.id);
    const upcoming = await groupNamed(owner, 'Upcoming', org.id);
    const t = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'T', groupId: prio.id },
      201,
    );
    const s = await bob.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'S', parentId: t.id, assigneeId: bob.userId },
      201,
    );
    const g = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'G', parentId: s.id, assigneeId: owner.userId },
      201,
    );
    await owner.ok('POST', `/api/v1/tasks/${g.id}/move`, { groupId: upcoming.id });
    await owner.ok('DELETE', `/api/v1/groups/${upcoming.id}`, { deleteTasks: true }, 204);
    await bob.ok('DELETE', `/api/v1/tasks/${s.id}`, undefined, 204);
    await owner.ok('POST', `/api/v1/groups/${upcoming.id}/restore`);
    const restored = await owner.ok<Task>('GET', `/api/v1/tasks/${g.id}`);
    expect(restored.deletedAt).toBeUndefined();
    expect(restored.parentId).toBeNull();
    // The purge of the Trash (30 days on) takes S and T's history, never the restored G.
    ctx.app.services.retention.purge(Date.now() + 31 * 86_400_000);
    expect((await owner.call('GET', `/api/v1/tasks/${g.id}`)).status).toBe(200);
  });
});

describe('boundary 3, final 2', () => {
  async function hiddenParentFamily() {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const bob = ctx.user('bob@example.com');
    const org = await sharedOrg(owner, [bob]);
    const prio = await groupNamed(owner, 'Prio', org.id);
    const today = await groupNamed(owner, 'Today', org.id);
    const upcoming = await groupNamed(owner, 'Upcoming', org.id);
    const t = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'T', groupId: today.id },
      201,
    );
    const s = await bob.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      { title: 'S', parentId: t.id, assigneeId: bob.userId },
      201,
    );
    const g = await owner.ok<Task>(
      'POST',
      `/api/v1/orgs/${org.id}/tasks`,
      {
        title: 'G',
        parentId: s.id,
        assigneeId: owner.userId,
        dueDate: '2026-10-12',
        recurrence: 'FREQ=DAILY',
      },
      201,
    );
    return { ctx, owner, bob, org, prio, today, upcoming, t, s, g };
  }

  it('P2 completing or skipping a repeating subtask under a hidden parent is refused', async () => {
    const { ctx, owner, org, prio, s, g } = await hiddenParentFamily();
    await owner.ok('POST', `/api/v1/tasks/${g.id}/move`, { groupId: prio.id });
    const constraints = {
      orgs: [{ orgId: org.id, read: { groups: [prio.id] }, write: 'all' as const }],
    };
    const api = bearer(ctx, (await pat(owner, ALL, constraints)).token);
    const complete = await api.call('POST', `/api/v1/tasks/${g.id}/complete`, { completed: true });
    expect(complete.status).toBe(403);
    const skip = await api.call('POST', `/api/v1/tasks/${g.id}/skip`, {});
    expect(skip.status).toBe(403);
    await api.ok('POST', '/api/v1/tasks/bulk', { op: 'complete', ids: [g.id] });
    const parent = await owner.ok<Task>('GET', `/api/v1/tasks/${s.id}`);
    expect(parent.counts.subtasks).toBe(1);
    expect((await owner.ok<Task>('GET', `/api/v1/tasks/${g.id}`)).completedAt).toBeNull();
  });

  it('P3 a group restore re-homes a task whose own group is still deleted', async () => {
    const { owner, org, prio, upcoming, g, t } = await hiddenParentFamily();
    await owner.ok('POST', `/api/v1/tasks/${t.id}/move`, { groupId: prio.id });
    await owner.ok('POST', `/api/v1/tasks/${g.id}/move`, { groupId: upcoming.id });
    await owner.ok('DELETE', `/api/v1/groups/${prio.id}`, { deleteTasks: true }, 204);
    await owner.ok('DELETE', `/api/v1/groups/${upcoming.id}`, {}, 204);
    await owner.ok('POST', `/api/v1/groups/${prio.id}/restore`);
    const list = await owner.ok<{ groups: Group[]; tasks: Task[] }>(
      'GET',
      `/api/v1/orgs/${org.id}/my-list`,
    );
    const inbox = list.groups.find((x) => x.kind === 'inbox');
    const restored = list.tasks.find((x) => x.id === g.id);
    expect(restored?.placement?.groupId).toBe(inbox?.id);
  });
});
