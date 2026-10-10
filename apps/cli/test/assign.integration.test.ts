import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CliHarness, cliHarness } from './support/fake-io.ts';
import { type RoosterServer, startServer, type TestUser } from './support/rooster-server.ts';

/**
 * `--assign` against a real server (11 §2.1): a grant sees member names, never colleagues'
 * emails, so the server resolves an email or a full name; a part of a name is matched locally.
 */

let server: RoosterServer;
let seq = 0;

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server?.close();
});

interface TaskJson {
  id: string;
  assigneeId: string | null;
}

async function join(owner: TestUser, member: TestUser, orgId: string): Promise<void> {
  const invite = await owner.api<{ url: string }>('POST', `/api/v1/orgs/${orgId}/invites`, {
    role: 'member',
  });
  const token = invite.data.url.split('/invite/')[1];
  expect((await member.api('POST', `/api/v1/invites/${token}/accept`)).status).toBe(200);
}

async function setup(): Promise<{
  cli: CliHarness;
  owner: TestUser;
  bob: TestUser;
  orgId: string;
  slug: string;
}> {
  seq += 1;
  const owner = await server.user(`assign-owner-${seq}@example.com`, 'Ada Lind');
  const bob = await server.user(`assign-bob-${seq}@example.com`, 'Bob Ek');
  const org = await owner.api<{ id: string; slug: string }>('POST', '/api/v1/orgs', {
    name: `Assign ${seq}`,
  });
  await join(owner, bob, org.data.id);
  const { token } = await owner.token({
    scopes: ['tasks:read', 'tasks:write', 'tasks:assign'],
    name: `assign-${seq}`,
  });
  const cli = cliHarness();
  const login = await cli.run(['login', '--with-token', '--server', server.url], { stdin: token });
  expect(login.code).toBe(0);
  return { cli, owner, bob, orgId: org.data.id, slug: org.data.slug };
}

async function add(cli: CliHarness, slug: string, assign: string) {
  return cli.run(['add', 'Pay invoice', '--no-parse', '--org', slug, '--assign', assign, '--json']);
}

describe('--assign through the server', () => {
  it('assigns by email in any case, by full name and by part of a name', async () => {
    const { cli, bob, slug } = await setup();
    for (const assign of [bob.email.toUpperCase(), 'bob ek', 'bo']) {
      const result = await add(cli, slug, assign);
      expect(result.stderr, assign).toBe('');
      expect((JSON.parse(result.stdout) as TaskJson).assigneeId, assign).toBe(bob.userId);
    }
  });

  it('an unknown email fails like an unknown name, and nothing is created', async () => {
    const { cli, slug, owner, orgId } = await setup();
    for (const assign of ['nobody@example.com', 'Nobody']) {
      const result = await add(cli, slug, assign);
      expect(result.code, assign).toBe(4);
      expect(result.stderr).toContain(`No member matches “${assign}”`);
    }
    const tasks = await owner.api<{ items: unknown[] }>(
      'GET',
      `/api/v1/orgs/${orgId}/tasks?view=everyone`,
    );
    expect(tasks.data.items).toEqual([]);
  });

  it('a full name two members share lists them by name only', async () => {
    const { cli, slug, owner, orgId } = await setup();
    const twin = await server.user(`assign-twin-${seq}@example.com`, 'Bob Ek');
    await join(owner, twin, orgId);
    const result = await add(cli, slug, 'Bob Ek');
    expect(result.code).toBe(4);
    expect(result.stderr).toContain('“Bob Ek” matches several people: Bob Ek, Bob Ek');
    expect(result.stderr).not.toContain('@');
    // The email tells them apart.
    const byEmail = await add(cli, slug, twin.email);
    expect((JSON.parse(byEmail.stdout) as TaskJson).assigneeId).toBe(twin.userId);
  });

  it("output never shows a colleague's email", async () => {
    const { cli, bob, slug } = await setup();
    const created = JSON.parse((await add(cli, slug, 'Bob Ek')).stdout) as TaskJson;
    for (const argv of [
      ['show', created.id],
      ['ls', 'everyone', '--org', slug],
      ['ls', 'everyone', '--org', slug, '--json'],
    ]) {
      const result = await cli.run(argv);
      expect(result.code, argv.join(' ')).toBe(0);
      if (!argv.includes('--json')) expect(result.stdout).toContain('Bob Ek');
      expect(result.stdout).not.toContain(bob.email);
    }
  });
});
