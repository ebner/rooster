// Phase 13 (ADR 0073 A9, WP 13.2): `GET /me/views/{view}`, the smart views of All organisations
// across every org the actor is a member of, grant-filtered.
import type { AllViewDto, Me, MyList, Org } from '@rooster/core/schemas';
import { type AllViewSource, selectAllView } from '@rooster/core/views';
import { describe, expect, it } from 'vitest';
import { bearer, pat, personalOrgId } from './grant-helpers.ts';
import { type Caller, createTask, groupNamed, listCtx, myList, sharedOrg } from './list-helpers.ts';
import { API_RESOURCE, connect, oauthCtx, withToken } from './oauth-helpers.ts';

// 2026-10-05 22:30 UTC is already Tuesday 6 Oct in Stockholm (UTC+2).
const NOW = Date.UTC(2026, 9, 5, 22, 30);
const TODAY = '2026-10-06';

type Row = { section: string; title: string; org: string };

function rows(view: AllViewDto, orgs: Record<string, string>): Row[] {
  return view.sections.flatMap((s) =>
    s.items.map((t) => ({ section: s.id, title: t.title, org: orgs[t.orgId] ?? t.orgId })),
  );
}

/**
 * A in Personal and two shared orgs (Kestrel, then Club in the sidebar); B is a member of both.
 * Every task assigned to someone else, or to nobody, must stay out of A's views.
 */
async function setup() {
  const ctx = listCtx({ clock: () => NOW });
  const a = ctx.user('a@example.com', 'Amara');
  const b = ctx.user('b@example.com', 'Bo');
  await a.ok('PATCH', '/api/v1/me', { timezone: 'Europe/Stockholm' });
  await b.ok('PATCH', '/api/v1/me', { timezone: 'Europe/Stockholm' });
  const kestrel = await sharedOrg(a, [b], 'Kestrel');
  const club = await sharedOrg(a, [b], 'Club');
  const personal = await personalOrgId(a);
  const names: Record<string, string> = {
    [personal]: 'personal',
    [kestrel.id]: 'kestrel',
    [club.id]: 'club',
  };
  const mk = (org: string, title: string, extra: Record<string, unknown> = {}, who: Caller = a) =>
    createTask(who, { title, ...extra }, org);
  return { ctx, a, b, kestrel, club, personal, names, mk };
}

describe('GET /me/views/{view} (ADR 0073 A9)', () => {
  it('mixes the orgs in date sections: by due, then sidebar order, then list order', async () => {
    const { a, b, kestrel, club, personal, names, mk } = await setup();
    await mk(club.id, 'club late', { dueDate: '2026-10-03' });
    await mk(personal, 'personal late', { dueDate: '2026-10-04' });
    await mk(kestrel.id, 'kestrel late', { dueDate: '2026-10-03' });
    await mk(personal, 'personal today', { dueDate: TODAY });
    await mk(club.id, 'club today', { dueDate: TODAY });
    await mk(kestrel.id, 'kestrel timed', {
      dueDate: TODAY,
      dueTime: '18:00',
      dueTz: 'Europe/Stockholm',
    });
    await mk(kestrel.id, 'kestrel today', { dueDate: TODAY });
    await mk(kestrel.id, 'kestrel tomorrow', { dueDate: '2026-10-07' });
    await mk(personal, 'personal undated');
    // Not mine: B's own, B's given to nobody, and mine given to B.
    await mk(kestrel.id, 'bo today', { dueDate: TODAY }, b);
    await mk(kestrel.id, 'nobody today', { dueDate: TODAY, assigneeId: null });
    await mk(club.id, 'given to bo', { dueDate: TODAY, assigneeId: b.userId });
    // B gives one to A: it is A's now.
    await mk(club.id, 'from bo', { dueDate: '2026-10-07', assigneeId: a.userId }, b);

    const today = await a.ok<AllViewDto>('GET', '/api/v1/me/views/today');
    expect(today).toMatchObject({ view: 'today', today: TODAY });
    expect(today.sections.map((s) => [s.id, s.kind, s.date])).toEqual([
      ['overdue', 'overdue', null],
      ['today', 'today', TODAY],
    ]);
    // Personal is first in the sidebar, then Kestrel, then Club; a new task goes to the top of
    // its Inbox, so the later one comes first within an org.
    expect(rows(today, names)).toEqual([
      { section: 'overdue', title: 'kestrel late', org: 'kestrel' },
      { section: 'overdue', title: 'club late', org: 'club' },
      { section: 'overdue', title: 'personal late', org: 'personal' },
      { section: 'today', title: 'kestrel timed', org: 'kestrel' },
      { section: 'today', title: 'personal today', org: 'personal' },
      { section: 'today', title: 'kestrel today', org: 'kestrel' },
      { section: 'today', title: 'club today', org: 'club' },
    ]);
    // The actor's placement is in every row.
    for (const t of today.sections.flatMap((s) => s.items)) {
      expect(t.assigneeId).toBe(a.userId);
      expect(t.placement).not.toBeNull();
    }

    // Moving Club to the top of the sidebar moves its rows up on the same due.
    await a.ok('PUT', '/api/v1/me/org-order', { orgId: club.id, beforeId: personal });
    const reordered = await a.ok<AllViewDto>('GET', '/api/v1/me/views/today');
    expect(rows(reordered, names).map((r) => r.title)).toEqual([
      'club late',
      'kestrel late',
      'personal late',
      'kestrel timed',
      'club today',
      'personal today',
      'kestrel today',
    ]);

    const week = await a.ok<AllViewDto>('GET', '/api/v1/me/views/week');
    expect(week.sections.map((s) => s.id)).toEqual([
      '2026-10-06',
      '2026-10-07',
      '2026-10-08',
      '2026-10-09',
      '2026-10-10',
      '2026-10-11',
      '2026-10-12',
    ]);
    expect(week.sections.every((s) => s.kind === 'day' && s.date === s.id)).toBe(true);
    expect(rows(week, names).filter((r) => r.section === '2026-10-07')).toEqual([
      { section: '2026-10-07', title: 'from bo', org: 'club' },
      { section: '2026-10-07', title: 'kestrel tomorrow', org: 'kestrel' },
    ]);

    const overdue = await a.ok<AllViewDto>('GET', '/api/v1/me/views/overdue');
    expect(overdue.sections.map((s) => s.id)).toEqual(['overdue']);
    expect(rows(overdue, names).map((r) => r.title)).toEqual([
      'club late',
      'kestrel late',
      'personal late',
    ]);

    // B sees only B's own.
    const theirs = await b.ok<AllViewDto>('GET', '/api/v1/me/views/today');
    expect(theirs.sections.flatMap((s) => s.items.map((t) => t.title)).sort()).toEqual([
      'bo today',
      'given to bo',
    ]);
  });

  it('matches core selectAllView over the my-list of every org (AC-13.5)', async () => {
    const { a, kestrel, club, personal, mk } = await setup();
    const prio = await groupNamed(a, 'Prio', kestrel.id);
    const parent = await mk(kestrel.id, 'parent', { dueDate: TODAY, groupId: prio.id });
    await mk(kestrel.id, 'sub', { dueDate: TODAY, parentId: parent.id });
    await mk(personal, 'p1', { dueDate: '2026-10-08' });
    await mk(club.id, 'c1', { dueDate: '2026-10-08' });
    await mk(club.id, 'late', { dueDate: '2026-10-01', dueTime: '09:00', dueTz: 'UTC' });
    await mk(personal, 'late too', { dueDate: '2026-10-01' });
    const me = await a.ok<Me>('GET', '/api/v1/me');
    const sources: AllViewSource[] = [];
    for (const org of me.orgs) {
      const list: MyList = await myList(a, org.id);
      sources.push({
        orgId: org.id,
        source: {
          groups: Object.fromEntries(list.groups.map((g) => [g.id, g])),
          tasks: Object.fromEntries(list.tasks.map((t) => [t.id, t])),
        },
      });
    }
    for (const view of ['today', 'week', 'overdue'] as const) {
      const expected = selectAllView(sources, view, {
        today: TODAY,
        nowMs: NOW,
        viewerTz: 'Europe/Stockholm',
        viewerId: a.userId,
        showCompleted: false,
      });
      const got = await a.ok<AllViewDto>('GET', `/api/v1/me/views/${view}`);
      expect(got.sections.map((s) => ({ id: s.id, ids: s.items.map((t) => t.id) }))).toEqual(
        expected.map((s) => ({ id: s.id, ids: s.items.map((i) => i.taskId) })),
      );
      expect(got.sections.flatMap((s) => s.items.map((t) => t.orgId))).toEqual(
        expected.flatMap((s) => s.items.map((i) => i.orgId)),
      );
    }
  });

  it('completed: false (default), any and true', async () => {
    const { a, kestrel, personal, mk } = await setup();
    await mk(personal, 'open', { dueDate: TODAY });
    const done = await mk(kestrel.id, 'done', { dueDate: TODAY });
    await a.ok('POST', `/api/v1/tasks/${done.id}/complete`, { completed: true });
    const lateDone = await mk(kestrel.id, 'late done', { dueDate: '2026-10-01' });
    await a.ok('POST', `/api/v1/tasks/${lateDone.id}/complete`, { completed: true });
    const titles = async (q: string) =>
      (await a.ok<AllViewDto>('GET', `/api/v1/me/views/today${q}`)).sections.map((s) => [
        s.id,
        s.items.map((t) => t.title),
      ]);
    expect(await titles('')).toEqual([['today', ['open']]]);
    expect(await titles('?completed=false')).toEqual([['today', ['open']]]);
    expect(await titles('?completed=any')).toEqual([
      ['overdue', ['late done']],
      ['today', ['open', 'done']],
    ]);
    expect(await titles('?completed=true')).toEqual([
      ['overdue', ['late done']],
      ['today', ['done']],
    ]);
    expect((await a.call('GET', '/api/v1/me/views/today?completed=maybe')).status).toBe(422);
    expect((await a.call('GET', '/api/v1/me/views/nodate')).status).toBe(422);
    expect((await a.call('GET', '/api/v1/me/views/my')).status).toBe(422);
  });

  it("evaluates dates in the viewer's timezone", async () => {
    const { a, personal, mk } = await setup();
    await mk(personal, 'utc today', { dueDate: '2026-10-05' });
    await mk(personal, 'local today', { dueDate: TODAY });
    const view = await a.ok<AllViewDto>('GET', '/api/v1/me/views/today');
    expect(view.today).toBe(TODAY);
    expect(view.sections.map((s) => [s.id, s.items.map((t) => t.title)])).toEqual([
      ['overdue', ['utc today']],
      ['today', ['local today']],
    ]);
    await a.ok('PATCH', '/api/v1/me', { timezone: 'UTC' });
    const utc = await a.ok<AllViewDto>('GET', '/api/v1/me/views/today');
    expect(utc.today).toBe('2026-10-05');
    expect(utc.sections.map((s) => [s.id, s.items.map((t) => t.title)])).toEqual([
      ['today', ['utc today']],
    ]);
  });

  it('leaves out orgs the user left or that were deleted', async () => {
    const { a, b, kestrel, club, mk } = await setup();
    await mk(kestrel.id, 'kestrel', { dueDate: TODAY }, b);
    await mk(club.id, 'club', { dueDate: TODAY }, b);
    const titles = async () =>
      (await b.ok<AllViewDto>('GET', '/api/v1/me/views/today')).sections.flatMap((s) =>
        s.items.map((t) => t.title),
      );
    expect((await titles()).sort()).toEqual(['club', 'kestrel']);
    await b.ok('DELETE', `/api/v1/orgs/${kestrel.id}/members/${b.userId}`, undefined, 204);
    expect(await titles()).toEqual(['club']);
    await a.ok('DELETE', `/api/v1/orgs/${club.id}`, { confirmName: 'Club' }, 204);
    expect(await titles()).toEqual([]);
  });
});

describe('GET /me/views/{view} with a grant (ADR 0073 A9, 11 §2.2)', () => {
  it('skips orgs outside an org-limited grant without failing', async () => {
    const { ctx, a, kestrel, club, personal, mk } = await setup();
    await mk(personal, 'personal', { dueDate: TODAY });
    await mk(kestrel.id, 'kestrel', { dueDate: TODAY });
    await mk(club.id, 'club', { dueDate: TODAY });
    const { token } = await pat(a, ['tasks:read'], {
      orgs: [{ orgId: kestrel.id, read: 'all', write: 'none' }],
    });
    const view = await bearer(ctx, token).ok<AllViewDto>('GET', '/api/v1/me/views/today');
    expect(view.sections.map((s) => [s.id, s.items.map((t) => t.title)])).toEqual([
      ['today', ['kestrel']],
    ]);
  });

  it('a group-limited grant sees only the rows it may read', async () => {
    const { ctx, a, kestrel, personal, mk } = await setup();
    const prio = await groupNamed(a, 'Prio', personal);
    const inPrio = await mk(personal, 'in prio', { dueDate: TODAY, groupId: prio.id });
    await mk(personal, 'sub of prio', { dueDate: TODAY, parentId: inPrio.id });
    await mk(personal, 'in inbox', { dueDate: TODAY });
    await mk(personal, 'late in inbox', { dueDate: '2026-10-01' });
    await mk(kestrel.id, 'kestrel', { dueDate: TODAY });
    const { token } = await pat(a, ['tasks:read'], {
      orgs: [
        { orgId: personal, read: { groups: [prio.id] }, write: 'none' },
        { orgId: kestrel.id, read: 'all', write: 'none' },
      ],
    });
    const view = await bearer(ctx, token).ok<AllViewDto>('GET', '/api/v1/me/views/today');
    // The only overdue row is hidden, so there is no Overdue section.
    expect(view.sections.map((s) => [s.id, s.items.map((t) => t.title)])).toEqual([
      ['today', ['in prio', 'sub of prio', 'kestrel']],
    ]);
  });

  it('a grant reaching none of my orgs gets the empty sections', async () => {
    const { ctx, a, b, kestrel } = await setup();
    const { token } = await pat(a, ['tasks:read'], {
      orgs: [{ orgId: kestrel.id, read: 'all', write: 'none' }],
    });
    // A is Kestrel's only owner and cannot leave: make B an owner first.
    await a.ok('PATCH', `/api/v1/orgs/${kestrel.id}/members/${b.userId}`, { role: 'owner' });
    await a.ok('DELETE', `/api/v1/orgs/${kestrel.id}/members/${a.userId}`, undefined, 204);
    const api = bearer(ctx, token);
    expect(await api.ok<AllViewDto>('GET', '/api/v1/me/views/today')).toEqual({
      view: 'today',
      today: TODAY,
      sections: [{ id: 'today', kind: 'today', date: TODAY, items: [] }],
    });
    expect(
      (await api.ok<AllViewDto>('GET', '/api/v1/me/views/week')).sections.map((s) => s.id),
    ).toHaveLength(7);
    expect((await api.ok<AllViewDto>('GET', '/api/v1/me/views/overdue')).sections).toEqual([]);
  });

  it('a PAT or an app without tasks:read gets 403 forbidden_scope', async () => {
    const ctx = oauthCtx({ clock: () => NOW });
    const a = ctx.user('a@example.com');
    const { token } = await pat(a, ['notifications:read']);
    const denied = await bearer(ctx, token).problem(
      'GET',
      '/api/v1/me/views/today',
      undefined,
      403,
    );
    expect(denied.code).toBe('forbidden_scope');
    expect(denied.detail).toContain('tasks:read');
    const app = await connect(
      ctx,
      a,
      { scope: 'notifications:read', resource: API_RESOURCE },
      { scopes: ['notifications:read'] },
    );
    const res = await withToken(ctx, app.access, 'GET', '/api/v1/me/views/week');
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('forbidden_scope');
    const reader = await connect(
      ctx,
      a,
      { scope: 'tasks:read', resource: API_RESOURCE },
      { scopes: ['tasks:read'] },
    );
    expect((await withToken(ctx, reader.access, 'GET', '/api/v1/me/views/week')).status).toBe(200);
  });
});

describe('prefs.defaultOrgId (ADR 0073 A4)', () => {
  it('accepts null or an org I am a member of; anything else is 422', async () => {
    const { a, b, kestrel } = await setup();
    const stranger = await sharedOrg(b, [], 'Elsewhere');
    const me = await a.ok<Me>('PATCH', '/api/v1/me', { prefs: { defaultOrgId: kestrel.id } });
    expect(me.prefs.defaultOrgId).toBe(kestrel.id);
    for (const defaultOrgId of [stranger.id, '0199c5a0-2c3d-7b4e-9f50-6b7c8d9e0a99']) {
      const res = await a.call('PATCH', '/api/v1/me', { prefs: { defaultOrgId } });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({
        code: 'validation_failed',
        errors: [{ path: 'prefs.defaultOrgId' }],
      });
    }
    expect((await a.ok<Me>('GET', '/api/v1/me')).prefs.defaultOrgId).toBe(kestrel.id);
    expect(
      (await a.call('PATCH', '/api/v1/me', { prefs: { defaultOrgId: 'kestrel' } })).status,
    ).toBe(422);
    const cleared = await a.ok<Me>('PATCH', '/api/v1/me', { prefs: { defaultOrgId: null } });
    expect(cleared.prefs.defaultOrgId).toBeNull();
  });

  it('reads as null once I am no longer a member, or the org is deleted', async () => {
    const { a, b, kestrel, club } = await setup();
    await b.ok('PATCH', '/api/v1/me', { prefs: { defaultOrgId: kestrel.id } });
    await b.ok('DELETE', `/api/v1/orgs/${kestrel.id}/members/${b.userId}`, undefined, 204);
    expect((await b.ok<Me>('GET', '/api/v1/me')).prefs.defaultOrgId).toBeNull();
    // Another prefs write keeps working (the stale value is not re-validated).
    expect(
      (await b.ok<Me>('PATCH', '/api/v1/me', { prefs: { startPage: 'all-today' } })).prefs,
    ).toMatchObject({ defaultOrgId: null, startPage: 'all-today' });
    await b.ok('PATCH', '/api/v1/me', { prefs: { defaultOrgId: club.id } });
    await a.ok('DELETE', `/api/v1/orgs/${club.id}`, { confirmName: 'Club' }, 204);
    expect((await b.ok<Me>('GET', '/api/v1/me')).prefs.defaultOrgId).toBeNull();
  });

  it('a grant that does not reach the default org reads it as null', async () => {
    const { ctx, a, kestrel, club } = await setup();
    await a.ok('PATCH', '/api/v1/me', { prefs: { defaultOrgId: club.id } });
    const { token } = await pat(a, ['tasks:read'], {
      orgs: [{ orgId: kestrel.id, read: 'all', write: 'none' }],
    });
    const me = await bearer(ctx, token).ok<Me>('GET', '/api/v1/me');
    expect(me.orgs.map((o: Org) => o.id)).toEqual([kestrel.id]);
    expect(me.prefs.defaultOrgId).toBeNull();
  });
});
