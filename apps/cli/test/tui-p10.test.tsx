import { addDays, todayIn } from '@rooster/core/dates';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type CliHarness, cliHarness } from './support/fake-io.ts';
import { type RoosterServer, startServer, type TestUser } from './support/rooster-server.ts';
import { KEY, openTui, type TuiHarness } from './support/tui.ts';

/** Phase 10 in the TUI: repeat and reminder tokens in `d`, indicators, the next instance. */

interface TaskJson {
  id: string;
  title: string;
  dueDate: string | null;
  completedAt: number | null;
  deletedAt?: number | null;
  recurrence?: string | null;
  nextReminderAt?: number | null;
}

let server: RoosterServer;
let open: TuiHarness[] = [];
let seq = 0;

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

async function setup(): Promise<{ user: TestUser; cli: CliHarness; day: string }> {
  seq += 1;
  const user = await server.user(`tui-p10-${seq}@example.com`, 'Ada');
  const { token } = await user.token({
    scopes: ['tasks:read', 'tasks:write', 'tasks:delete'] as never,
  });
  const cli = cliHarness();
  const login = await cli.run(['login', '--with-token', '--server', server.url], { stdin: token });
  expect(login.code).toBe(0);
  const { data } = await user.api<{ timezone: string }>('GET', '/api/v1/me');
  return { user, cli, day: todayIn(data.timezone, Date.now()) };
}

async function tui(
  cli: CliHarness,
  options: Parameters<typeof openTui>[1] = {},
): Promise<TuiHarness> {
  const harness = await openTui(cli, options);
  open.push(harness);
  return harness;
}

async function addTask(user: TestUser, body: Record<string, unknown>): Promise<TaskJson> {
  const { status, data } = await user.api<TaskJson>('POST', '/api/v1/orgs/personal/tasks', body);
  expect(status).toBe(201);
  return data;
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

const offsets = async (user: TestUser, id: string) =>
  (await user.api<{ offsetMinutes: number | null }[]>('GET', `/api/v1/tasks/${id}/reminders`)).data
    .map((r) => r.offsetMinutes)
    .sort();

describe('TUI: repeat and reminders (P10)', () => {
  it('d takes a recurrence phrase and reminder tokens; rows show ↻ and 🔔; u undoes both', async () => {
    const { user, cli } = await setup();
    const task = await addTask(user, { title: 'Water plants' });
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Water plants'));
    await t.press('d');
    await t.waitFor((f) => f.includes('Date ▏') && f.includes('!1h'));
    await t.type('every mon !1h');
    await t.waitFor((f) => f.includes('↻ Weekly on Monday · 🔔 1 h before'));
    await t.press(KEY.enter);
    await t.waitFor((f) => /Water plants\s+↻ 🔔/.test(f));
    const get = async () => (await user.api<TaskJson>('GET', `/api/v1/tasks/${task.id}`)).data;
    const saved = await eventually(get, (v) => v.recurrence === 'FREQ=WEEKLY;BYDAY=MO');
    expect(saved.recurrence).toBe('FREQ=WEEKLY;BYDAY=MO');
    expect(await offsets(user, task.id)).toEqual([60]);

    // The details list the rule and the reminder.
    await t.press('o');
    const details = await t.waitFor((f) => f.includes('Reminders'));
    expect(details).toMatch(/Repeats\s+↻ Weekly on Monday/);
    expect(details).toMatch(/Reminders\s+🔔 1 h before · /);
    await t.press(KEY.esc);

    await t.press('u');
    await t.waitFor((f) => f.includes('Undone'));
    const undone = await eventually(get, (v) => v.dueDate === null);
    expect(undone.dueDate).toBeNull();
    expect(undone.recurrence ?? null).toBeNull();
    expect(await offsets(user, task.id)).toEqual([]);
  });

  it('a reminder token alone keeps the date; without a due date the picker says why', async () => {
    const { user, cli, day } = await setup();
    const dated = await addTask(user, { title: 'Dated', dueDate: addDays(day, 2) });
    await addTask(user, { title: 'Undated' });
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Undated') && f.includes('Dated'));
    // The newest task is first: Undated.
    await t.press('d');
    await t.type('!15m');
    await t.press(KEY.enter);
    await t.waitFor((f) => f.includes('needs a due date'));
    await t.press(KEY.esc);
    await t.press('j');
    await t.press('d');
    await t.type('!15m');
    await t.press(KEY.enter);
    await t.waitFor((f) => /Dated\s+🔔/.test(f));
    expect(
      await eventually(
        () => offsets(user, dated.id),
        (v) => v.length === 1,
      ),
    ).toEqual([15]);
    expect((await user.api<TaskJson>('GET', `/api/v1/tasks/${dated.id}`)).data.dueDate).toBe(
      addDays(day, 2),
    );
  });

  it('x on a repeating task shows the next instance; u reopens it and trashes the next', async () => {
    const { user, cli, day } = await setup();
    const task = await addTask(user, {
      title: 'Standup',
      dueDate: day,
      recurrence: 'FREQ=DAILY',
    });
    const t = await tui(cli);
    await t.waitFor((f) => f.includes('Standup'));
    await t.press('x');
    const frame = await t.waitFor((f) => f.includes('Completed “Standup”; next: Tomorrow'));
    expect(frame).toMatch(/○ Standup/);
    const list = async () =>
      (
        await user.api<{ tasks: TaskJson[] }>('GET', '/api/v1/orgs/personal/my-list')
      ).data.tasks.filter((x) => x.title === 'Standup');
    const both = await eventually(list, (v) => v.length === 2);
    const next = both.find((x) => x.id !== task.id) as TaskJson;
    expect(next.dueDate).toBe(addDays(day, 1));

    await t.press('u');
    await t.waitFor((f) => f.includes('Undone'));
    const reopened = await eventually(
      async () => (await user.api<TaskJson>('GET', `/api/v1/tasks/${task.id}`)).data,
      (v) => v.completedAt === null,
    );
    expect(reopened.completedAt).toBeNull();
    const trashed = await eventually(
      async () => (await user.api<TaskJson>('GET', `/api/v1/tasks/${next.id}`)).data,
      (v) => typeof v.deletedAt === 'number',
    );
    expect(trashed.deletedAt).toEqual(expect.any(Number));
  });

  it('review finding 4: an undo whose PATCH fails is retried with r under the same keys', async () => {
    const { user, cli } = await setup();
    const task = await addTask(user, { title: 'Plan' });
    let failNextPatch = false;
    const writes: string[] = [];
    const t = await tui(cli, {
      io: {
        fetch: (input, init) => {
          const request = new Request(input as Request, init);
          if (request.method !== 'GET') {
            writes.push(`${request.method} ${request.headers.get('Idempotency-Key')}`);
          }
          if (failNextPatch && request.method === 'PATCH') {
            failNextPatch = false;
            return Promise.reject(new TypeError('fetch failed'));
          }
          return globalThis.fetch(request);
        },
      },
    });
    await t.waitFor((f) => f.includes('Plan') && f.includes('● synced'));
    await t.press('d');
    await t.type('fri !1h');
    await t.press(KEY.enter);
    await t.waitFor((f) => /Plan\s+🔔/.test(f));
    expect(
      await eventually(
        () => offsets(user, task.id),
        (v) => v.length === 1,
      ),
    ).toEqual([60]);

    writes.length = 0;
    failNextPatch = true;
    await t.press('u');
    await t.waitFor((f) => f.includes('Couldn’t save'));
    await t.press('r');
    await t.waitFor((f) => f.includes('Undone'));
    // The retry sent the DELETE again under its own key, then the PATCH under a new one.
    const [del1, patch1, del2, patch2] = writes;
    expect(del1?.startsWith('DELETE ')).toBe(true);
    expect(patch1?.startsWith('PATCH ')).toBe(true);
    expect(del2).toBe(del1);
    expect(patch2).toBe(patch1);
    expect(patch2).not.toBe(`PATCH ${del1?.slice('DELETE '.length)}`);
    const get = async () => (await user.api<TaskJson>('GET', `/api/v1/tasks/${task.id}`)).data;
    expect((await eventually(get, (v) => v.dueDate === null)).dueDate).toBeNull();
    expect(await offsets(user, task.id)).toEqual([]);
  });
});
