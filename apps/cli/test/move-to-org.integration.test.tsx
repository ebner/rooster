import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cliHarness } from './support/fake-io.ts';
import { type RoosterServer, startServer, type TestUser } from './support/rooster-server.ts';
import { KEY, openTui, type TuiHarness } from './support/tui.ts';

/**
 * ADR 0072 against a real server: `rooster mv --to-org` and the TUI's "Another organisation…"
 * step, with the preview's confirmation (§13) and undo (§20).
 */

interface TaskJson {
  id: string;
  orgId: string;
  seq: number;
  title: string;
  placement: { groupId: string; position: string } | null;
}

let server: RoosterServer;
let seq = 0;
let open: TuiHarness[] = [];

beforeAll(async () => {
  server = await startServer();
});
afterEach(() => {
  for (const tui of open) tui.close();
  open = [];
});
afterAll(async () => {
  await server?.close();
});

async function join(owner: TestUser, member: TestUser, orgId: string): Promise<void> {
  const invite = await owner.api<{ url: string }>('POST', `/api/v1/orgs/${orgId}/invites`, {
    role: 'member',
  });
  const token = invite.data.url.split('/invite/')[1];
  expect((await member.api('POST', `/api/v1/invites/${token}/accept`)).status).toBe(200);
}

/**
 * Ada owns Acme (with Bob) and Garden (with Carol). Bob commented on Ada's Acme task, so moving
 * it to Garden shows his comment to Carol (`exposes`); moving her personal task doesn't.
 */
async function setup() {
  seq += 1;
  const ada = await server.user(`move-ada-${seq}@example.com`, 'Ada');
  const bob = await server.user(`move-bob-${seq}@example.com`, 'Bob');
  const carol = await server.user(`move-carol-${seq}@example.com`, 'Carol');
  const acme = (
    await ada.api<{ id: string; slug: string }>('POST', '/api/v1/orgs', { name: `Acme ${seq}` })
  ).data;
  const garden = (
    await ada.api<{ id: string; slug: string }>('POST', '/api/v1/orgs', {
      name: `Garden ${seq}`,
    })
  ).data;
  await join(ada, bob, acme.id);
  await join(ada, carol, garden.id);
  const shared = (
    await ada.api<TaskJson>('POST', `/api/v1/orgs/${acme.id}/tasks`, { title: 'Fix the gate' })
  ).data;
  expect(
    (await bob.api('POST', `/api/v1/tasks/${shared.id}/comments`, { body: 'I can help' })).status,
  ).toBe(201);
  const own = (
    await ada.api<TaskJson>('POST', '/api/v1/orgs/personal/tasks', { title: 'Water plants' })
  ).data;
  const { token } = await ada.token({
    scopes: ['tasks:read', 'tasks:write', 'groups:write'] as never,
    name: `move-${seq}`,
  });
  const cli = cliHarness();
  const login = await cli.run(['login', '--with-token', '--server', server.url], { stdin: token });
  expect(login.code).toBe(0);
  return { ada, cli, acme, garden, shared, own };
}

async function taskOf(user: TestUser, id: string): Promise<TaskJson> {
  return (await user.api<TaskJson>('GET', `/api/v1/tasks/${id}`)).data;
}

async function eventually<T>(fn: () => Promise<T>, check: (value: T) => boolean): Promise<T> {
  const started = Date.now();
  for (;;) {
    const value = await fn();
    if (check(value)) return value;
    if (Date.now() - started > 3_000) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('rooster mv --to-org against the server (ADR 0072 §24)', () => {
  it('moves a task, prints its new ref, and its old ref still finds it', async () => {
    const { ada, cli, acme, own } = await setup();
    try {
      const moved = await cli.run(['mv', String(own.seq), '--to-org', acme.slug]);
      expect(moved.stderr).toContain('Moved 1 task to Acme');
      expect(moved.code).toBe(0);
      const after = await taskOf(ada, own.id);
      expect(after.orgId).toBe(acme.id);
      expect(moved.stdout).toContain(`${acme.slug}#${after.seq}`);
      // §7: the old number keeps resolving.
      const shown = await cli.run(['show', `personal#${own.seq}`, '--json']);
      expect(shown.code).toBe(0);
      expect(JSON.parse(shown.stdout).id).toBe(own.id);
    } finally {
      cli.cleanup();
    }
  });

  it('asks for --yes when others’ comments would reach new people', async () => {
    const { ada, cli, acme, garden, shared } = await setup();
    try {
      const ref = `${acme.slug}#${shared.seq}`;
      const refused = await cli.run(['mv', ref, '--to-org', garden.slug]);
      expect(refused.code).toBe(2);
      expect(refused.stderr).toContain('1 comment by other people would become visible');
      expect((await taskOf(ada, shared.id)).orgId).toBe(acme.id);
      const moved = await cli.run(['mv', ref, '--to-org', garden.slug, '--yes', '--json']);
      expect(moved.code).toBe(0);
      expect(JSON.parse(moved.stdout).orgId).toBe(garden.id);
      expect((await taskOf(ada, shared.id)).orgId).toBe(garden.id);
    } finally {
      cli.cleanup();
    }
  });
});

describe('TUI: m → Another organisation… (ADR 0072 §24)', () => {
  it('moves the task to the picked org and group; the row leaves; u brings it back', async () => {
    const { ada, cli, acme, own } = await setup();
    const t = await openTui(cli);
    open.push(t);
    try {
      await t.waitFor((f) => f.includes('Water plants'));
      await t.press('m');
      await t.waitFor((f) => f.includes('Another organisation…'));
      await t.type('another');
      await t.press(KEY.enter);
      // The orgs other than this one, in sidebar order.
      await t.waitFor((f) => f.includes('Move to organisation') && f.includes('Acme'));
      await t.type('acme');
      await t.press(KEY.enter);
      // Enter takes my first group after the Inbox there.
      await t.waitFor((f) => f.includes('Group in Acme'));
      await t.waitFor((f) => /› \d {3}Today/.test(f));
      await t.press(KEY.enter);
      await t.waitFor((f) => f.includes('Moved to Acme') && !f.includes('○ Water plants'));
      const moved = await eventually(
        () => taskOf(ada, own.id),
        (task) => task.orgId === acme.id,
      );
      expect(moved.orgId).toBe(acme.id);
      await t.press('u');
      const back = await eventually(
        () => taskOf(ada, own.id),
        (task) => task.orgId !== acme.id,
      );
      expect(back.seq).toBe(own.seq);
      expect(back.placement?.groupId).toBe(own.placement?.groupId);
      await t.waitFor((f) => f.includes('○ Water plants'));
    } finally {
      cli.cleanup();
    }
  });

  it('confirms before sharing others’ comments: n keeps the task, y moves it', async () => {
    const { ada, cli, acme, garden, shared } = await setup();
    expect((await cli.run(['org', 'use', acme.slug])).code).toBe(0);
    const t = await openTui(cli);
    open.push(t);
    try {
      const pick = async () => {
        await t.waitFor((f) => f.includes('Fix the gate'));
        await t.press('m');
        await t.type('another');
        await t.press(KEY.enter);
        await t.type('garden');
        await t.press(KEY.enter);
        await t.waitFor((f) => /› \d {3}Today/.test(f));
        await t.press(KEY.enter);
        await t.waitFor((f) =>
          f.includes('1 comment by other people will be visible to members of Garden'),
        );
      };
      await pick();
      await t.press(KEY.enter);
      expect(t.frame()).toContain('1 comment by other people');
      await t.press('n');
      await t.waitFor((f) => !f.includes('1 comment by other people'));
      expect((await taskOf(ada, shared.id)).orgId).toBe(acme.id);
      await pick();
      await t.press('y');
      await t.waitFor((f) => f.includes('Moved to Garden') && !f.includes('○ Fix the gate'));
      expect(
        (
          await eventually(
            () => taskOf(ada, shared.id),
            (task) => task.orgId === garden.id,
          )
        ).orgId,
      ).toBe(garden.id);
    } finally {
      cli.cleanup();
    }
  });
});
