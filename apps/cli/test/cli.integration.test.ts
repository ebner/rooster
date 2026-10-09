import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { addDays, todayIn } from '@rooster/core/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/run.ts';
import { type CliHarness, cliHarness, fakeIo } from './support/fake-io.ts';
import { type RoosterServer, startServer, type TestUser } from './support/rooster-server.ts';

interface TaskJson {
  id: string;
  seq: number;
  title: string;
  dueDate: string | null;
  tagIds: string[];
  completedAt: number | null;
  placement: { groupId: string } | null;
}
interface GroupJson {
  id: string;
  name: string;
  kind: string;
}

let server: RoosterServer;

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server?.close();
});

/** A CLI home signed in with `token` (`login --with-token`, as CI would). */
async function signedIn(token: string): Promise<CliHarness> {
  const cli = cliHarness();
  const login = await cli.run(['login', '--with-token', '--server', server.url], { stdin: token });
  expect(login.stderr).toContain('Signed in as');
  expect(login.code).toBe(0);
  return cli;
}

async function myList(user: TestUser) {
  const { data } = await user.api<{ groups: GroupJson[]; tasks: TaskJson[] }>(
    'GET',
    '/api/v1/orgs/personal/my-list',
  );
  return data;
}

async function tagNames(user: TestUser, ids: string[]) {
  const { data } = await user.api<{ id: string; name: string }[]>(
    'GET',
    '/api/v1/orgs/personal/tags',
  );
  return ids.map((id) => data.find((t) => t.id === id)?.name);
}

describe('AC-8.2 add with NL parsing, then ls --json', () => {
  it('AC-8.2 rooster add "Pay invoice tom #finance >Prio" lands in Prio, due tomorrow, tagged', async () => {
    const user = await server.user('ac82@example.com', 'Ada');
    const { token } = await user.token({ scopes: ['tasks:write'], name: 'ac82' });
    const cli = await signedIn(token);
    try {
      const add = await cli.run(['add', 'Pay invoice tom #finance >Prio']);
      expect(add.stderr).toBe('');
      expect(add.code).toBe(0);
      expect(add.stdout).toMatch(/Pay invoice/);

      const ls = await cli.run(['ls', '--json']);
      expect(ls.code).toBe(0);
      // The `jq` part of the AC, in JS: `.tasks[] | select(.title == "Pay invoice")`.
      const listed = JSON.parse(ls.stdout) as { groups: GroupJson[]; tasks: TaskJson[] };
      const task = listed.tasks.find((t) => t.title === 'Pay invoice');
      expect(task).toBeDefined();
      const prio = listed.groups.find((g) => g.name === 'Prio');
      expect(task?.placement?.groupId).toBe(prio?.id);
      const { data: me } = await user.api<{ timezone: string }>('GET', '/api/v1/me');
      expect(task?.dueDate).toBe(addDays(todayIn(me.timezone, Date.now()), 1));
      expect(await tagNames(user, task?.tagIds ?? [])).toEqual(['finance']);

      // Default position is the top of the group (07 §4), even when >Prio picked it.
      const prioTasks = (await myList(user)).tasks
        .filter((t) => t.placement?.groupId === prio?.id)
        .sort((a, b) =>
          (a.placement as never as { position: string }).position <
          (b.placement as never as { position: string }).position
            ? -1
            : 1,
        );
      expect(prioTasks[0]?.title).toBe('Pay invoice');
    } finally {
      cli.cleanup();
    }
  });
});

describe('AC-8.3 a read-only PAT', () => {
  it('AC-8.3 runs ls and show, and add exits 3 with a clear message', async () => {
    const user = await server.user('ac83@example.com', 'Bo');
    await user.api('POST', '/api/v1/orgs/personal/tasks', { title: 'Renew passport' });
    const { token } = await user.token({ scopes: ['tasks:read'], name: 'reader' });
    const cli = await signedIn(token);
    try {
      const ls = await cli.run(['ls']);
      expect(ls.code).toBe(0);
      expect(ls.stdout).toContain('Renew passport');
      const seq = /^\s*(\d+)\s+○ Renew passport/m.exec(ls.stdout)?.[1];
      expect(seq).toBeDefined();

      const show = await cli.run(['show', seq as string]);
      expect(show.code).toBe(0);
      expect(show.stdout).toContain('Renew passport');

      const add = await cli.run(['add', 'Something new']);
      expect(add.code).toBe(3);
      expect(add.stderr).toContain('tasks:write');
      expect(add.stderr).toContain('Connected apps');
    } finally {
      cli.cleanup();
    }
  });
});

describe('AC-8.5 a PAT that may write only in Prio', () => {
  it('AC-8.5 adds and completes in Prio; moving out or adding to Today exits 3 naming Prio', async () => {
    const user = await server.user('ac85@example.com', 'Cy');
    const { data: me } = await user.api<{ orgs: { id: string; isPersonal: boolean }[] }>(
      'GET',
      '/api/v1/me',
    );
    const org = me.orgs.find((o) => o.isPersonal);
    const groups = (await myList(user)).groups;
    const prio = groups.find((g) => g.name === 'Prio') as GroupJson;
    const { token } = await user.token({
      scopes: ['tasks:write'],
      constraints: {
        orgs: [{ orgId: org?.id as string, read: 'all', write: { groups: [prio.id] } }],
      },
      name: 'prio-only',
    });
    const cli = await signedIn(token);
    try {
      const add = await cli.run(['add', '--quiet', 'Write Q4 plan', '--group', 'Prio']);
      expect(add.code).toBe(0);
      const seq = add.stdout.trim();
      expect(seq).toMatch(/^\d+$/);

      const done = await cli.run(['done', seq]);
      expect(done.code).toBe(0);
      const undone = await cli.run(['undone', seq]);
      expect(undone.code).toBe(0);

      const mv = await cli.run(['mv', seq, '--group', 'Today']);
      expect(mv.code).toBe(3);
      expect(mv.stderr).toContain('Prio');

      const today = await cli.run(['add', 'Elsewhere', '--group', 'Today']);
      expect(today.code).toBe(3);
      expect(today.stderr).toContain('Prio');

      // In Swedish the explanation comes from the grant itself (core/grants), naming Prio.
      expect((await cli.run(['config', 'set', 'locale', 'sv'])).code).toBe(0);
      const sv = await cli.run(['mv', seq, '--group', 'Today']);
      expect(sv.code).toBe(3);
      expect(sv.stderr).toContain('får bara skriva i gruppen Prio');
    } finally {
      cli.cleanup();
    }
  });
});

describe('refs, output and the other commands against a real server', () => {
  it('resolves seq, org#seq, ID prefixes, @last and stdin refs', async () => {
    const user = await server.user('refs@example.com', 'Di');
    const { token } = await user.token({
      scopes: ['tasks:write', 'tasks:delete', 'groups:write', 'comments:write'],
      name: 'all',
    });
    const cli = await signedIn(token);
    try {
      const a = JSON.parse((await cli.run(['add', '--json', 'First'])).stdout) as TaskJson;
      const b = JSON.parse((await cli.run(['add', '--json', 'Second'])).stdout) as TaskJson;
      expect((await cli.run(['show', '--quiet', String(a.seq)])).stdout.trim()).toBe(String(a.seq));
      expect((await cli.run(['show', '--quiet', `personal#${b.seq}`])).stdout.trim()).toBe(
        String(b.seq),
      );
      expect((await cli.run(['show', '--quiet', a.id.slice(0, 13)])).stdout.trim()).toBe(
        String(a.seq),
      );
      expect((await cli.run(['show', '--quiet', '@last'])).stdout.trim()).toBe(String(a.seq));
      const missing = await cli.run(['show', '9999']);
      expect(missing.code).toBe(4);

      // `rooster ls --json | jq -r '.tasks[].seq' | rooster done -`
      const piped = await cli.run(['done', '-'], { stdin: `${a.seq}\n${b.seq}\n` });
      expect(piped.code).toBe(0);
      const list = await myList(user);
      expect(
        list.tasks
          .filter((t) => t.completedAt !== null)
          .map((t) => t.title)
          .sort(),
      ).toEqual(['First', 'Second']);

      const rm = await cli.run(['rm', String(a.seq)]);
      expect(rm.code).toBe(0);
      const restore = await cli.run(['restore', String(a.seq)]);
      expect(restore.code).toBe(0);
      expect(restore.stdout).toContain('First');
    } finally {
      cli.cleanup();
    }
  });

  it('manages groups and tags, edits, comments, searches and moves', async () => {
    const user = await server.user('groups@example.com', 'Ed');
    const { token } = await user.token({
      scopes: ['tasks:write', 'tasks:delete', 'groups:write', 'comments:write'],
      name: 'all',
    });
    const cli = await signedIn(token);
    try {
      expect((await cli.run(['group', 'add', 'Errands'])).code).toBe(0);
      expect((await cli.run(['group', 'rename', 'Errands', 'Chores'])).code).toBe(0);
      const groups = await cli.run(['group', 'ls']);
      expect(groups.stdout).toContain('Chores');

      const created = JSON.parse(
        (
          await cli.run([
            'add',
            '--json',
            'Buy milk',
            '--group',
            'Chores',
            '--tag',
            'shop',
            '--due',
            '2031-05-04',
          ])
        ).stdout,
      ) as TaskJson;
      expect(created.dueDate).toBe('2031-05-04');
      expect(await tagNames(user, created.tagIds)).toEqual(['shop']);

      const tagged = await cli.run(['tag', String(created.seq), '+urgent', '-shop']);
      expect(tagged.code).toBe(0);
      const detail = (await user.api<TaskJson>('GET', `/api/v1/tasks/${created.id}`)).data;
      expect(await tagNames(user, detail.tagIds)).toEqual(['urgent']);

      const edit = await cli.run([
        'edit',
        String(created.seq),
        '--title',
        'Buy oat milk',
        '--due',
        '2031-06-01',
      ]);
      expect(edit.code).toBe(0);
      const edited = (await user.api<TaskJson>('GET', `/api/v1/tasks/${created.id}`)).data;
      // [P2] the title and the due date change together (the due patch once reverted the title).
      expect(edited.title).toBe('Buy oat milk');
      expect(edited.dueDate).toBe('2031-06-01');
      expect((await cli.run(['edit', String(created.seq), '--due', 'none'])).code).toBe(0);
      const cleared = (await user.api<TaskJson>('GET', `/api/v1/tasks/${created.id}`)).data;
      expect(cleared.title).toBe('Buy oat milk');
      expect(cleared.dueDate).toBeNull();

      expect((await cli.run(['comment', String(created.seq), 'On', 'my', 'way'])).code).toBe(0);
      const search = await cli.run(['search', '--json', 'oat']);
      expect((JSON.parse(search.stdout) as unknown[]).length).toBe(1);

      const sub = await cli.run(['sub', String(created.seq), 'Check fridge']);
      expect(sub.code).toBe(0);
      const show = await cli.run(['show', String(created.seq)]);
      expect(show.stdout).toContain('Check fridge');
      expect(show.stdout).toContain('On my way');

      const mv = await cli.run(['mv', String(created.seq), '--group', 'Inbox', '--bottom']);
      expect(mv.code).toBe(0);
      const rmGroup = await cli.run(['group', 'rm', 'Chores']);
      expect(rmGroup.code).toBe(0);

      const ambiguous = await cli.run(['group', 'rename', 'Nope', 'X']);
      expect(ambiguous.code).toBe(4);

      // Dynamic completion: names from the server, then from the 60 s cache.
      const names = await cli.run(['__complete', 'groups']);
      expect(names.stdout.split('\n')).toEqual(expect.arrayContaining(['Inbox', 'Prio']));
      expect((await cli.run(['group', 'add', 'Later'])).code).toBe(0);
      expect((await cli.run(['__complete', 'groups'])).stdout).not.toContain('Later');
      expect((await cli.run(['__complete', 'tags'])).stdout).toContain('urgent');
    } finally {
      cli.cleanup();
    }
  });

  it('whoami prints the user and the grant; logout forgets a PAT but keeps it valid', async () => {
    const user = await server.user('whoami@example.com', 'Fia');
    const { token } = await user.token({ scopes: ['tasks:read'], name: 'laptop' });
    const cli = await signedIn(token);
    try {
      const who = await cli.run(['whoami']);
      expect(who.code).toBe(0);
      expect(who.stdout).toContain('Fia <whoami@example.com>');
      expect(who.stdout).toContain('tasks:read');
      const json = JSON.parse((await cli.run(['whoami', '--json'])).stdout) as {
        user: { email: string };
        grant: { kind: string };
      };
      expect(json.user.email).toBe('whoami@example.com');
      expect(json.grant.kind).toBe('pat');

      const version = await cli.run(['--version']);
      expect(version.stdout).toMatch(/^rooster \d+\.\d+\.\d+ \(server /);

      const out = await cli.run(['logout']);
      expect(out.code).toBe(0);
      expect((await cli.run(['whoami'])).code).toBe(3);
      // The PAT itself still works (logout only revokes device grants).
      const again = await signedIn(token);
      again.cleanup();
    } finally {
      cli.cleanup();
    }
  });

  it('a revoked or unknown token exits 3; an unreachable server exits 6', async () => {
    const cli = cliHarness();
    try {
      const bad = await cli.run(['login', '--with-token', '--server', server.url], {
        stdin: 'rooster_pat_nope',
      });
      expect(bad.code).toBe(3);
      const down = await cli.run(['ls'], {
        env: { ROOSTER_SERVER: 'http://127.0.0.1:9', ROOSTER_TOKEN: 'x' },
      });
      expect(down.code).toBe(6);
    } finally {
      cli.cleanup();
    }
  });
});

describe('the device flow (07 §2)', () => {
  it('logs in with a code approved in the browser, then logout revokes the device grant', async () => {
    const user = await server.user('device@example.com', 'Gus');
    const home = mkdtempSync(join(tmpdir(), 'rooster-cli-'));
    try {
      const io = fakeIo(home, {
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
      });
      const login = runCli(['login', '--server', server.url, '--scope', 'tasks:write'], io);
      let code: string | undefined;
      for (let i = 0; i < 200 && code === undefined; i++) {
        code = /Code: (\S+)/.exec(io.out.join(''))?.[1];
        if (code === undefined) await new Promise((r) => setTimeout(r, 10));
      }
      expect(code).toBeDefined();
      const pending = await user.api<{ requestedScopes: string[] }>(
        'GET',
        `/api/v1/device/${code}`,
      );
      expect(pending.data.requestedScopes).toEqual(['tasks:write']);
      const approved = await user.api('POST', `/api/v1/device/${code}/approve`, {
        scopes: ['tasks:write'],
        constraints: { orgs: 'all' },
      });
      expect(approved.status).toBe(200);
      expect(await login).toBe(0);
      expect(io.err.join('')).toContain('Signed in as Gus <device@example.com>');
      // The verification page is on the server's configured origin, not the one the CLI
      // talks to here, so it is printed but not opened.
      expect(io.opened).toEqual([]);

      const who = fakeIo(home);
      expect(await runCli(['whoami', '--json'], who)).toBe(0);
      const grant = (JSON.parse(who.out.join('')) as { grant: { kind: string; label: string } })
        .grant;
      expect(grant.kind).toBe('device');
      expect(grant.label).toContain('rooster CLI');

      // A device session may mint narrower PATs (not from a PAT: browser or device only).
      const create = fakeIo(home);
      expect(
        await runCli(['token', 'create', 'ci', '--read-only', '--org', 'personal'], create),
      ).toBe(0);
      expect(create.out.join('').trim()).toMatch(/^rooster_pat_\S+$/);
      const ls = fakeIo(home);
      expect(await runCli(['token', 'ls', '--json'], ls)).toBe(0);
      const tokens = JSON.parse(ls.out.join('')) as { id: string; label: string }[];
      expect(tokens.map((t) => t.label)).toEqual(['ci']);
      const revoke = fakeIo(home);
      expect(await runCli(['token', 'revoke', tokens[0]?.id.slice(0, 13) ?? ''], revoke)).toBe(3);
      expect(revoke.err.join('')).toContain('Connected apps');

      const out = fakeIo(home);
      expect(await runCli(['logout', '--json'], out)).toBe(0);
      expect(JSON.parse(out.out.join(''))).toMatchObject({ revoked: true });
      const { data: grants } = await user.api<{ kind: string }[]>('GET', '/api/v1/me/grants');
      expect(grants.filter((g) => g.kind === 'device')).toEqual([]);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a denied request exits 3', async () => {
    const user = await server.user('denied@example.com', 'Hal');
    const home = mkdtempSync(join(tmpdir(), 'rooster-cli-'));
    try {
      const io = fakeIo(home, {
        sleep: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20))),
      });
      const login = runCli(['login', '--no-browser', '--server', server.url], io);
      let code: string | undefined;
      for (let i = 0; i < 200 && code === undefined; i++) {
        code = /Code: (\S+)/.exec(io.out.join(''))?.[1];
        if (code === undefined) await new Promise((r) => setTimeout(r, 10));
      }
      expect((await user.api('POST', `/api/v1/device/${code}/deny`)).status).toBe(204);
      expect(await login).toBe(3);
      expect(io.err.join('')).toContain('denied');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe('edit --editor', () => {
  it('opens $EDITOR on the description (argv, no shell) and saves what it wrote', async () => {
    const user = await server.user('editor@example.com', 'Ivy');
    const { token } = await user.token({ scopes: ['tasks:write'], name: 'editor' });
    const { writeFileSync, readFileSync } = await import('node:fs');
    const calls: { editor: readonly string[]; file: string; before: string }[] = [];
    const cli = cliHarness(
      {},
      {
        runEditor: async (editor, file) => {
          calls.push({ editor, file, before: readFileSync(file, 'utf8') });
          writeFileSync(file, '## Notes\n\n- [ ] call back\n');
          return 0;
        },
      },
    );
    try {
      const login = await cli.run(['login', '--with-token', '--server', server.url], {
        stdin: token,
      });
      expect(login.code).toBe(0);
      const task = JSON.parse(
        (await cli.run(['add', '--json', 'Plan', '--desc', 'old text'])).stdout,
      ) as TaskJson;
      const edit = await cli.run(['edit', '--editor', String(task.seq)], {
        env: { EDITOR: '"/opt/My Editor/bin/edit" --wait' },
      });
      expect(edit.code).toBe(0);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.editor).toEqual(['/opt/My Editor/bin/edit', '--wait']);
      expect(calls[0]?.before).toBe('old text');
      const { data } = await user.api<{ description: string }>('GET', `/api/v1/tasks/${task.id}`);
      expect(data.description).toBe('## Notes\n\n- [ ] call back\n');
    } finally {
      cli.cleanup();
    }
  });
});

describe('[P2] mv --top', () => {
  it('leaves a task that is already first where it is (an empty intent meant the end)', async () => {
    const user = await server.user('mvtop@example.com', 'Jo');
    const { token } = await user.token({ scopes: ['tasks:write'], name: 'mv' });
    const cli = await signedIn(token);
    try {
      const add = async (title: string) =>
        JSON.parse((await cli.run(['add', '--json', title, '--group', 'Prio'])).stdout) as TaskJson;
      await add('Second');
      const first = await add('First');
      const order = async () => {
        const list = await myList(user);
        const prio = list.groups.find((g) => g.name === 'Prio')?.id;
        return list.tasks
          .filter((t) => t.placement?.groupId === prio)
          .sort((a, b) => {
            const pa = (a.placement as unknown as { position: string }).position;
            const pb = (b.placement as unknown as { position: string }).position;
            return pa < pb ? -1 : pa > pb ? 1 : 0;
          })
          .map((t) => t.title);
      };
      expect(await order()).toEqual(['First', 'Second']);
      expect((await cli.run(['mv', String(first.seq), '--group', 'Prio'])).code).toBe(0);
      expect(await order()).toEqual(['First', 'Second']);
      expect((await cli.run(['mv', String(first.seq), '--group', 'Prio', '--top'])).code).toBe(0);
      expect(await order()).toEqual(['First', 'Second']);
    } finally {
      cli.cleanup();
    }
  });
});
