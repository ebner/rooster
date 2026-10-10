import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createRoosterClient } from '@rooster/api-client';
import { addDays, todayIn } from '@rooster/core/dates';
import { createRoosterMcpServer } from '@rooster/mcp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type CliHarness, cliHarness } from './support/fake-io.ts';
import { type RoosterServer, startServer, type TestUser } from './support/rooster-server.ts';

/** Phase 10 in the CLI and MCP: reminders, repeating tasks and attachments (07 §4, §6). */

interface TaskJson {
  id: string;
  seq: number;
  title: string;
  dueDate: string | null;
  completedAt: number | null;
  deletedAt?: number | null;
  recurrence?: string | null;
  recurrenceBasis?: string | null;
  nextReminderAt?: number | null;
}
interface ReminderJson {
  id: string;
  kind: 'relative' | 'absolute';
  offsetMinutes: number | null;
  remindAt: number | null;
  fireAt: number | null;
}

let server: RoosterServer;
let seq = 0;

beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server?.close();
});

const SCOPES = ['tasks:read', 'tasks:write', 'tasks:delete'];

async function setup(): Promise<{ user: TestUser; cli: CliHarness; day: string; tz: string }> {
  seq += 1;
  const user = await server.user(`p10-${seq}@example.com`, 'Ada');
  const { token } = await user.token({ scopes: SCOPES as never, name: `p10-${seq}` });
  const cli = cliHarness();
  const login = await cli.run(['login', '--with-token', '--server', server.url], { stdin: token });
  expect(login.code).toBe(0);
  const { data: me } = await user.api<{ timezone: string }>('GET', '/api/v1/me');
  return { user, cli, day: todayIn(me.timezone, Date.now()), tz: me.timezone };
}

async function json<T>(cli: CliHarness, argv: string[]): Promise<T> {
  const result = await cli.run([...argv, '--json']);
  expect(result.stderr).toBe('');
  expect(result.code).toBe(0);
  return JSON.parse(result.stdout) as T;
}

async function reminders(user: TestUser, taskId: string): Promise<ReminderJson[]> {
  const { status, data } = await user.api<ReminderJson[]>(
    'GET',
    `/api/v1/tasks/${taskId}/reminders`,
  );
  expect(status).toBe(200);
  return data;
}

async function getTask(user: TestUser, id: string): Promise<TaskJson> {
  return (await user.api<TaskJson>('GET', `/api/v1/tasks/${id}`)).data;
}

describe('P10 CLI: --remind and --no-remind', () => {
  it('add --remind sets relative and absolute reminders; edit adds, --no-remind clears', async () => {
    const { user, cli, day } = await setup();
    const at = `${addDays(day, 10)} 09:00`;
    const task = await json<TaskJson>(cli, [
      'add',
      'Dentist',
      '--due',
      'tomorrow 14:00',
      '--remind',
      '1h',
      '--remind',
      at,
      '--remind',
      '!1h',
    ]);
    expect(task.nextReminderAt).toEqual(expect.any(Number));
    let list = await reminders(user, task.id);
    expect(list.map((r) => r.offsetMinutes ?? 'abs').sort()).toEqual([60, 'abs']);

    // A title token works too (parse: true on the server).
    const tokened = await json<TaskJson>(cli, ['add', 'Call Bo fri !15m']);
    expect((await reminders(user, tokened.id)).map((r) => r.offsetMinutes)).toEqual([15]);

    await json(cli, ['edit', String(task.seq), '--remind', 'due']);
    list = await reminders(user, task.id);
    expect(list).toHaveLength(3);

    // Clear first, then add: one reminder left.
    await json(cli, ['edit', String(task.seq), '--no-remind', '--remind', '1d']);
    list = await reminders(user, task.id);
    expect(list.map((r) => r.offsetMinutes)).toEqual([1440]);

    const cleared = await cli.run(['edit', String(task.seq), '--no-remind']);
    expect(cleared.code).toBe(0);
    expect(await reminders(user, task.id)).toEqual([]);
    expect((await getTask(user, task.id)).nextReminderAt ?? null).toBeNull();
  });

  it('a bad --remind exits 5 before anything is sent; a relative one without a date is refused', async () => {
    const { cli } = await setup();
    const bad = await cli.run(['add', 'Something', '--remind', 'whenever']);
    expect(bad.code).toBe(5);
    expect(bad.stderr).toContain('--remind');
    const ls = await cli.run(['ls', '--json']);
    expect(ls.stdout).not.toContain('Something');

    const undated = await cli.run(['add', 'No date here', '--no-parse', '--remind', '1h']);
    expect(undated.code).toBe(5);
  });
});

describe('P10 CLI: repeating tasks', () => {
  it('--due "every mon" repeats; done prints the next occurrence; ls and show mark it', async () => {
    const { cli } = await setup();
    const task = await json<TaskJson>(cli, ['add', 'Water plants', '--due', 'every mon']);
    expect(task.recurrence).toBe('FREQ=WEEKLY;BYDAY=MO');

    await json(cli, ['edit', String(task.seq), '--remind', '1h']);
    const ls = await cli.run(['ls']);
    expect(ls.code).toBe(0);
    const row = ls.stdout.split('\n').find((line) => line.includes('Water plants'));
    expect(row).toContain('↻');
    expect(row).toContain('🔔');

    const show = await cli.run(['show', String(task.seq)]);
    expect(show.code).toBe(0);
    expect(show.stdout).toMatch(/Repeats\s+↻ Weekly on Monday/);
    expect(show.stdout).toMatch(/Reminders\s+1 h before · .+ 08:00/);

    const done = await cli.run(['done', String(task.seq)]);
    expect(done.code).toBe(0);
    expect(done.stderr).toContain('Next occurrence:');
    const lines = done.stdout.split('\n').filter((line) => line.includes('Water plants'));
    expect(lines).toHaveLength(2);
    expect(lines[0]).toContain('✓');
    expect(lines[1]).toContain('○');

    const result = await json<{ task: TaskJson; next?: TaskJson }>(cli, [
      'undone',
      String(task.seq),
    ]);
    expect(result.next).toBeUndefined();
  });

  it('--repeat keeps a date (also one in the title), takes the first occurrence without one, and none stops it', async () => {
    const { cli, day } = await setup();
    const titled = await json<TaskJson>(cli, ['add', 'Pay rent in 3 days', '--repeat', 'monthly']);
    expect(titled.title).toBe('Pay rent');
    expect(titled.dueDate).toBe(addDays(day, 3));
    expect(titled.recurrence).toMatch(/^FREQ=MONTHLY/);

    const plain = await json<TaskJson>(cli, ['add', 'Stretch', '--no-parse', '--repeat', 'daily']);
    expect(plain.dueDate).toBe(day);
    expect(plain.recurrence).toBe('FREQ=DAILY');

    const due = addDays(day, 5);
    const dated = await json<TaskJson>(cli, ['add', 'Review', '--due', due]);
    const edited = await json<{ task: TaskJson }>(cli, [
      'edit',
      String(dated.seq),
      '--repeat',
      'every 3 days after done',
    ]);
    expect(edited.task.dueDate).toBe(due);
    expect(edited.task.recurrence).toBe('FREQ=DAILY;INTERVAL=3');
    expect(edited.task.recurrenceBasis).toBe('completion');

    const stopped = await json<{ task: TaskJson }>(cli, [
      'edit',
      String(dated.seq),
      '--repeat',
      'none',
    ]);
    expect(stopped.task.recurrence ?? null).toBeNull();
    expect(stopped.task.dueDate).toBe(due);

    const bad = await cli.run(['edit', String(dated.seq), '--repeat', 'tomorrow']);
    expect(bad.code).toBe(5);
    expect(bad.stderr).toContain('--repeat');
  });

  it('rm --occurrence skips to the next instance; a plain rm ends the series', async () => {
    const { user, cli } = await setup();
    const task = await json<TaskJson>(cli, ['add', 'Standup', '--due', 'every weekday']);
    const skipped = await json<{ id: string; next: TaskJson | null }[]>(cli, [
      'rm',
      '--occurrence',
      String(task.seq),
    ]);
    expect(skipped[0]?.next?.title).toBe('Standup');
    const next = skipped[0]?.next as TaskJson;
    expect(next.id).not.toBe(task.id);
    expect((await getTask(user, task.id)).deletedAt).toEqual(expect.any(Number));

    const text = await cli.run(['rm', String(next.seq)]);
    expect(text.code).toBe(0);
    const ls = await json<{ tasks: TaskJson[] }>(cli, ['ls']);
    expect(ls.tasks.filter((t) => t.title === 'Standup')).toEqual([]);

    const plain = await json<TaskJson>(cli, ['add', 'Once', '--due', 'tomorrow']);
    const refused = await cli.run(['rm', '--occurrence', String(plain.seq)]);
    expect(refused.code).toBe(5);
  });
});

describe('P10 MCP: remind, clearReminders and repeat (in process, over a PAT)', () => {
  async function mcpFor(user: TestUser) {
    const { token } = await user.token({
      scopes: ['tasks:read', 'tasks:write'] as never,
      name: 'mcp',
    });
    const client = createRoosterClient({ baseUrl: server.url, token });
    const mcpServer = createRoosterMcpServer({
      client,
      listing: { mode: 'granted', scopes: ['tasks:read', 'tasks:write'] },
      defaultOrg: 'personal',
      instanceUrl: server.url,
      version: '1.3.0',
    });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(b);
    const mcp = new Client({ name: 'p10', version: '1.0.0' });
    await mcp.connect(a);
    const call = async (name: string, args: Record<string, unknown>) => {
      const result = (await mcp.callTool({ name, arguments: args })) as {
        isError?: boolean;
        content: { type: string; text: string }[];
        structuredContent?: Record<string, unknown>;
      };
      return result;
    };
    return { call, close: () => mcp.close() };
  }

  it('create_task with remind and a recurrence due; update_task remind, clearReminders and repeat; complete_task reports the next', async () => {
    const { user } = await setup();
    const { call, close } = await mcpFor(user);
    try {
      const created = await call('create_task', {
        title: 'Call mom',
        due: 'every sun 18:00',
        remind: '1h',
      });
      expect(created.isError).toBeFalsy();
      const row = created.structuredContent?.task as Record<string, unknown>;
      expect(row.repeat).toBe('FREQ=WEEKLY;BYDAY=SU');
      expect(row.nextReminder).toEqual(expect.any(String));
      const ref = row.ref as string;
      const { data: resolved } = await user.api<TaskJson>(
        'GET',
        `/api/v1/tasks/resolve?ref=${encodeURIComponent(ref)}`,
      );
      expect((await reminders(user, resolved.id)).map((r) => r.offsetMinutes)).toEqual([60]);

      const updated = await call('update_task', { ref, remind: ['15m', 'due', '15m'] });
      expect(updated.isError).toBeFalsy();
      expect((await reminders(user, resolved.id)).map((r) => r.offsetMinutes).sort()).toEqual([
        0, 15, 60,
      ]);

      const detail = await call('get_task', { ref });
      const reminderRows = (detail.structuredContent as { task: { reminders: unknown[] } }).task
        .reminders;
      expect(reminderRows).toHaveLength(3);
      expect(reminderRows).toContainEqual(expect.objectContaining({ before: '1h' }));

      const cleared = await call('update_task', { ref, clearReminders: true });
      expect(cleared.isError).toBeFalsy();
      expect(await reminders(user, resolved.id)).toEqual([]);

      const bad = await call('update_task', { ref, remind: 'whenever' });
      expect(bad.isError).toBe(true);
      expect(bad.content[0]?.text).toContain('reminder was not understood');

      const done = await call('complete_task', { ref });
      expect(done.isError).toBeFalsy();
      expect(done.content[0]?.text).toMatch(
        /Next occurrence: personal-[\w-]+#\d+, due \d{4}-\d{2}-\d{2}\./,
      );
      const next = done.structuredContent?.next as Record<string, unknown>;
      expect(next.repeat).toBe('FREQ=WEEKLY;BYDAY=SU');

      const stopped = await call('update_task', { ref: next.ref, repeat: 'none' });
      expect(stopped.isError).toBeFalsy();
      expect(
        (stopped.structuredContent as { task: Record<string, unknown> }).task.repeat,
      ).toBeUndefined();

      const repeated = await call('create_task', { title: 'Gym', repeat: 'every 2 days' });
      const gym = repeated.structuredContent?.task as Record<string, unknown>;
      expect(gym.repeat).toBe('FREQ=DAILY;INTERVAL=2');
      expect(gym.due).toEqual(expect.any(String));
    } finally {
      await close();
    }
  });
});
