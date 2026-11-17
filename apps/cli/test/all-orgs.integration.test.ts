import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createRoosterClient } from '@rooster/api-client';
import { addDays, todayIn } from '@rooster/core/dates';
import { type AllViewSource, selectAllView } from '@rooster/core/views';
import { createRoosterMcpServer } from '@rooster/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { stripAnsi } from '../src/output/color.ts';
import { type CliHarness, cliHarness } from './support/fake-io.ts';
import { type RoosterServer, startServer, type TestUser } from './support/rooster-server.ts';
import { serveFetch } from './support/server.ts';

/**
 * Phase 13 (ADR 0073 A9, AC-13.5): `rooster ls today|week|overdue --all-orgs` is one
 * `GET /me/views/<view>` request, listed in the sections of All organisations.
 */

interface TaskJson {
  id: string;
  orgId: string;
  seq: number;
  title: string;
  parentId: string | null;
  completedAt: number | null;
}
interface AllViewJson {
  view: string;
  today: string;
  sections: { id: string; kind: string; date: string | null; items: TaskJson[] }[];
}
interface MeJson {
  timezone: string;
  orgs: { id: string; slug: string; isPersonal: boolean }[];
}

let server: RoosterServer;
let seq = 0;

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server?.close();
});

interface Seeded {
  user: TestUser;
  token: string;
  cli: CliHarness;
  day: string;
  me: MeJson;
  slug: (orgId: string) => string;
  tasks: Record<string, TaskJson>;
}

/**
 * Ada in Personal and two shared orgs (Kestrel, Club). Overdue and today's tasks in all three, a
 * subtask, tomorrow's tasks, a completed one, and one assigned to Bo (never Ada's).
 */
async function seed(): Promise<Seeded> {
  seq += 1;
  const user = await server.user(`all-orgs-${seq}@example.com`, 'Ada');
  const bo = await server.user(`all-orgs-bo-${seq}@example.com`, 'Bo');
  const { token } = await user.token({ scopes: ['tasks:read'] as never });
  const cli = cliHarness();
  const login = await cli.run(['login', '--with-token', '--server', server.url], { stdin: token });
  expect(login.code).toBe(0);
  const org = async (name: string) => {
    const created = await user.api<{ id: string }>('POST', '/api/v1/orgs', { name });
    expect(created.status).toBe(201);
    const invite = await user.api<{ url: string }>(
      'POST',
      `/api/v1/orgs/${created.data.id}/invites`,
      { role: 'member' },
    );
    const accepted = await bo.api(
      'POST',
      `/api/v1/invites/${invite.data.url.split('/invite/')[1]}/accept`,
    );
    expect(accepted.status).toBe(200);
    return created.data.id;
  };
  const kestrel = await org('Kestrel');
  const club = await org('Club');
  const me = (await user.api<MeJson>('GET', '/api/v1/me')).data;
  const personal = me.orgs.find((o) => o.isPersonal)?.id as string;
  const day = todayIn(me.timezone, Date.now());
  const add = async (orgId: string, body: Record<string, unknown>) => {
    const { status, data } = await user.api<TaskJson>('POST', `/api/v1/orgs/${orgId}/tasks`, body);
    expect(status).toBe(201);
    return data;
  };
  const tasks: Record<string, TaskJson> = {};
  tasks.clubLate = await add(club, { title: 'Club late', dueDate: addDays(day, -3) });
  tasks.personalLate = await add(personal, { title: 'Personal late', dueDate: addDays(day, -2) });
  tasks.kestrelLate = await add(kestrel, { title: 'Kestrel late', dueDate: addDays(day, -3) });
  tasks.personalToday = await add(personal, { title: 'Personal today', dueDate: day });
  tasks.kestrelToday = await add(kestrel, { title: 'Kestrel today', dueDate: day });
  tasks.kestrelSub = await add(kestrel, {
    title: 'Kestrel sub',
    dueDate: day,
    parentId: tasks.kestrelToday.id,
  });
  tasks.clubToday = await add(club, { title: 'Club today', dueDate: day, tagNames: ['urgent'] });
  tasks.personalLater = await add(personal, {
    title: 'Personal later',
    dueDate: addDays(day, 3),
    tagNames: ['urgent'],
  });
  tasks.clubTomorrow = await add(club, { title: 'Club tomorrow', dueDate: addDays(day, 1) });
  tasks.done = await add(kestrel, { title: 'Done today', dueDate: day });
  expect(
    (await user.api('POST', `/api/v1/tasks/${tasks.done.id}/complete`, { completed: true })).status,
  ).toBe(200);
  tasks.bos = await add(kestrel, { title: 'Bo’s', dueDate: day, assigneeId: bo.userId });
  const slugs = new Map(me.orgs.map((o) => [o.id, o.slug]));
  return { user, token, cli, day, me, slug: (orgId) => slugs.get(orgId) ?? orgId, tasks };
}

async function serverView(user: TestUser, view: string, query = ''): Promise<AllViewJson> {
  const { status, data } = await user.api<AllViewJson>('GET', `/api/v1/me/views/${view}${query}`);
  expect(status).toBe(200);
  return data;
}

async function json(cli: CliHarness, args: string[]): Promise<TaskJson[]> {
  const res = await cli.run([...args, '--json']);
  expect(res.code, res.stderr).toBe(0);
  return JSON.parse(res.stdout) as TaskJson[];
}

describe('rooster ls <view> --all-orgs (ADR 0073 A9)', () => {
  it('AC-13.5 rooster ls today --all-orgs matches All · Today', async () => {
    const { user, cli, day } = await seed();
    for (const view of ['today', 'week', 'overdue'] as const) {
      const fromServer = await serverView(user, view);
      const listed = await json(cli, ['ls', view, '--all-orgs', '--subtasks']);
      expect(listed.map((t) => t.id)).toEqual(
        fromServer.sections.flatMap((s) => s.items.map((t) => t.id)),
      );

      // The web computes All · Today with core `selectAllView` over each org's my-list cache.
      const me = (await user.api<MeJson>('GET', '/api/v1/me')).data;
      const sources: AllViewSource[] = [];
      for (const org of me.orgs) {
        const list = (
          await user.api<{ groups: { id: string }[]; tasks: { id: string }[] }>(
            'GET',
            `/api/v1/orgs/${org.id}/my-list`,
          )
        ).data;
        sources.push({
          orgId: org.id,
          source: {
            groups: Object.fromEntries(list.groups.map((g) => [g.id, g])),
            tasks: Object.fromEntries(list.tasks.map((t) => [t.id, t])),
          } as unknown as AllViewSource['source'],
        });
      }
      const web = selectAllView(sources, view, {
        today: day,
        nowMs: Date.now(),
        viewerTz: me.timezone,
        viewerId: user.userId,
        showCompleted: false,
      });
      expect(listed.map((t) => t.id)).toEqual(web.flatMap((s) => s.items.map((i) => i.taskId)));
    }
  });

  it('lists one heading with the web’s sections and each row’s org', async () => {
    const { cli, slug, tasks, day } = await seed();
    const res = await cli.run(['ls', 'today', '--all-orgs']);
    expect(res.code, res.stderr).toBe(0);
    const lines = stripAnsi(res.stdout).trimEnd().split('\n');
    expect(lines[0]).toBe('All organisations · Today');
    const ref = (key: string) => {
      const task = tasks[key] as TaskJson;
      return `${slug(task.orgId)}#${task.seq}`;
    };
    const overdueAt = lines.findIndex((l) => l.startsWith('Overdue (3)'));
    const todayAt = lines.findIndex((l) => /^Today · \w+day, \w+ \d+ \(3\)$/.test(l));
    expect(overdueAt).toBe(1);
    expect(todayAt).toBe(5);
    // Overdue by due date, then the sidebar order: Personal, Kestrel, Club.
    expect(lines.slice(2, 5).map((l) => l.trim().split(/\s+/)[0])).toEqual([
      ref('kestrelLate'),
      ref('clubLate'),
      ref('personalLate'),
    ]);
    // The subtask shows through its parent's progress; Bo's and the done one aren't listed.
    expect(lines.slice(6).map((l) => l.trim().split(/\s+/)[0])).toEqual([
      ref('personalToday'),
      ref('kestrelToday'),
      ref('clubToday'),
    ]);
    expect(lines.find((l) => l.includes('Kestrel today'))).toContain('▸ 0/1');
    expect(res.stdout).not.toContain('Bo’s');
    expect(res.stdout).not.toContain('Done today');

    const week = stripAnsi((await cli.run(['ls', 'week', '--all-orgs'])).stdout).split('\n');
    expect(week[0]).toBe('All organisations · Next 7 days');
    expect(week.filter((l) => /^\S.* \(\d+\)$/.test(l))).toEqual([
      'Today (3)',
      'Tomorrow (1)',
      expect.stringMatching(/^\w+day, \w+ \d+ \(1\)$/),
    ]);
    expect(week.some((l) => l.includes(addDays(day, 3)))).toBe(false);

    const quiet = await cli.run(['ls', 'overdue', '--all-orgs', '--quiet']);
    expect(quiet.stdout.trim().split('\n')).toEqual([
      ref('kestrelLate'),
      ref('clubLate'),
      ref('personalLate'),
    ]);
  });

  it('--json is a flat task array in section order; --completed asks for completed=any', async () => {
    const { user, cli, tasks } = await seed();
    const open = await json(cli, ['ls', 'today', '--all-orgs']);
    expect(open.map((t) => t.title)).toEqual([
      'Kestrel late',
      'Club late',
      'Personal late',
      'Personal today',
      'Kestrel today',
      'Club today',
    ]);
    const all = await json(cli, ['ls', 'today', '--all-orgs', '--completed', '--subtasks']);
    const fromServer = await serverView(user, 'today', '?completed=any');
    expect(all.map((t) => t.id)).toEqual(
      fromServer.sections.flatMap((s) => s.items.map((t) => t.id)),
    );
    expect(all.map((t) => t.id)).toContain(tasks.done?.id);
    // A tag is matched by name in each row's org.
    expect(
      (await json(cli, ['ls', 'week', '--all-orgs', '--tag', 'Urgent'])).map((t) => t.title),
    ).toEqual(['Club today', 'Personal later']);
    expect(
      await json(cli, ['ls', 'week', '--all-orgs', '--tag', 'urgent', '--tag', 'nope']),
    ).toEqual([]);
    // In Swedish (the server setting is the CLI's language).
    expect((await user.api('PATCH', '/api/v1/me', { locale: 'sv' })).status).toBe(200);
    const sv = stripAnsi((await cli.run(['ls', 'today', '--all-orgs'])).stdout).split('\n');
    expect(sv[0]).toBe('Alla organisationer · Idag');
    expect(sv).toContain('Försenade (3)');
    expect(sv.some((l) => /^Idag · [A-ZÅÄÖ][a-zåäö]+dag \d+ [a-zåäö]+ \(3\)$/.test(l))).toBe(true);
  });

  it('MCP list_tasks with allOrgs lists the same rows, each naming its org', async () => {
    const { user, token, slug } = await seed();
    const mcpServer = createRoosterMcpServer({
      client: createRoosterClient({ baseUrl: server.url, token }),
      listing: { mode: 'granted', scopes: ['tasks:read'] },
      defaultOrg: 'personal',
      instanceUrl: server.url,
      version: '1.11.0',
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(b);
    const mcp = new Client({ name: 'all-orgs', version: '1.0.0' });
    await mcp.connect(a);
    try {
      for (const view of ['today', 'week', 'overdue'] as const) {
        const result = (await mcp.callTool({
          name: 'list_tasks',
          arguments: { view, allOrgs: true },
        })) as { structuredContent: { tasks: { ref: string; org: string }[] } };
        const fromServer = await serverView(user, view);
        // Without the subtask, which shows through its parent's progress.
        const expected = fromServer.sections
          .flatMap((s) => s.items)
          .filter((t) => t.parentId === null);
        expect(result.structuredContent.tasks).toEqual(
          expected.map((t) =>
            expect.objectContaining({ ref: `${slug(t.orgId)}#${t.seq}`, org: slug(t.orgId) }),
          ),
        );
      }
    } finally {
      await mcp.close();
      await mcpServer.close();
    }
  });

  it('a server without GET /me/views gets the per-org listing', async () => {
    const { token, tasks } = await seed();
    const old = await serveFetch(async (request) => {
      const url = new URL(request.url);
      if (url.pathname.startsWith('/api/v1/me/views/')) {
        return Response.json(
          { type: 'about:blank', title: 'not_found', status: 404, code: 'not_found' },
          { status: 404, headers: { 'content-type': 'application/problem+json' } },
        );
      }
      return fetch(new Request(`${server.url}${url.pathname}${url.search}`, request));
    });
    const cli = cliHarness();
    try {
      const login = await cli.run(['login', '--with-token', '--server', old.url], { stdin: token });
      expect(login.code, login.stderr).toBe(0);
      const res = await cli.run(['ls', 'today', '--all-orgs']);
      expect(res.code, res.stderr).toBe(0);
      const text = stripAnsi(res.stdout);
      expect(text).not.toContain('All organisations');
      expect(text).toContain('Kestrel · Today');
      expect(text).toContain('Club · Today');
      const listed = await json(cli, ['ls', 'today', '--all-orgs']);
      expect(listed.map((t) => t.id).sort()).toEqual(
        [
          tasks.clubLate,
          tasks.personalLate,
          tasks.kestrelLate,
          tasks.personalToday,
          tasks.kestrelToday,
          tasks.clubToday,
        ]
          .map((t) => t?.id)
          .sort(),
      );
    } finally {
      cli.cleanup();
      await old.close();
    }
  });
});
