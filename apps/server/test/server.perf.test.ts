// [perf] WP 11.4, AC-11.4 (10 §4, ADR 0052 §8): server time of GET /my-list with 1,000 and
// 2,000 tasks in one org, and the mutation p95. Requests go through the whole Hono stack
// in-process (middleware, services, SQLite, JSON), without a network.
//
// Timing tests are sensitive to load. Each figure is the median or p95 of many samples after
// a warm-up, and the budgets are asserted on those, never on a single sample.
// ROOSTER_PERF_SLACK (a factor, default 1) loosens them on a slow or shared machine.

import { uuidv7 } from '@rooster/core/ids';
import type { MyList, Task } from '@rooster/core/schemas';
import { beforeAll, describe, expect, it } from 'vitest';
import type { Actor } from '../src/services/index.ts';
import { type Caller, type ListCtx, listCtx, meta } from './list-helpers.ts';

const SLACK = Number(process.env.ROOSTER_PERF_SLACK ?? '1') || 1;
const MY_LIST_BUDGET_MS = 50;
const MUTATION_P95_BUDGET_MS = 20;

function percentile(samples: number[], p: number): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, index)] as number;
}

const round = (ms: number) => Math.round(ms * 100) / 100;

async function timed(fn: () => Promise<Response>, expected: number): Promise<number> {
  const start = performance.now();
  const res = await fn();
  const text = await res.text();
  const ms = performance.now() - start;
  if (res.status !== expected) throw new Error(`${res.status}: ${text}`);
  return ms;
}

const GROUPS = ['Today', 'Prio', 'Upcoming', 'Waiting for', 'Someday', 'Errands'];
const TAGS = ['finance', 'home', 'work', 'health', 'car', 'garden', 'kids', 'travel'];

/**
 * Adds `count` tasks to the org through the services, like a busy list: tasks spread over the
 * groups with due dates and tags, every 8th one with 3 subtasks, and every 10th completed
 * recently (still shown in the list).
 */
function seed(ctx: ListCtx, actor: Actor, orgId: string, groupIds: string[], count: number) {
  const { tasks } = ctx.app.services;
  let made = 0;
  let n = 0;
  while (made < count) {
    n += 1;
    const tagNames = n % 3 === 0 ? [TAGS[n % TAGS.length] as string] : [];
    if (n % 7 === 0) tagNames.push(TAGS[(n + 3) % TAGS.length] as string);
    const parent = tasks.create(
      actor,
      orgId,
      {
        title: `Task ${made + 1}: follow up on the quarterly numbers`,
        groupId: groupIds[n % groupIds.length] as string,
        ...(n % 4 === 0 ? { dueDate: `2026-${String((n % 12) + 1).padStart(2, '0')}-15` } : {}),
        ...(n % 9 === 0
          ? { description: 'Some **notes** with a [link](https://example.com).' }
          : {}),
        tagNames,
      },
      meta(),
    );
    made += 1;
    if (n % 8 === 0) {
      for (let i = 0; i < 3 && made < count; i++) {
        tasks.create(actor, orgId, { title: `Step ${i + 1}`, parentId: parent.id }, meta());
        made += 1;
      }
    }
    if (n % 10 === 0) tasks.complete(actor, parent.id, true, meta());
  }
}

async function measureMyList(owner: Caller, orgId: string, samples = 40) {
  const path = `/api/v1/orgs/${orgId}/my-list`;
  for (let i = 0; i < 5; i++) await timed(() => owner.call('GET', path), 200);
  const times: number[] = [];
  for (let i = 0; i < samples; i++) times.push(await timed(() => owner.call('GET', path), 200));
  const list = await owner.ok<MyList>('GET', path);
  return { median: percentile(times, 50), p95: percentile(times, 95), tasks: list.tasks.length };
}

describe('[perf] AC-11.4 server performance with a 2,000-task org', () => {
  let ctx: ListCtx;
  let owner: Caller;
  let orgId: string;
  let groupIds: string[];
  const report: Record<string, unknown> = {};

  beforeAll(async () => {
    ctx = listCtx();
    owner = ctx.user('owner@example.com', 'Owner');
    // Two members, so placements, audiences and events have others to reach.
    const others = [ctx.user('m1@example.com'), ctx.user('m2@example.com')];
    const org = await owner.ok<{ id: string }>('POST', '/api/v1/orgs', { name: 'Perf' }, 201);
    orgId = org.id;
    for (const m of others) {
      const { url } = await owner.ok<{ url: string }>(
        'POST',
        `/api/v1/orgs/${orgId}/invites`,
        { role: 'member' },
        201,
      );
      await m.ok('POST', `/api/v1/invites/${url.split('/invite/')[1]}/accept`);
    }
    const { groups } = ctx.app.services;
    for (const name of GROUPS) groups.create(owner.actor, orgId, { name }, meta());
    const list = await owner.ok<MyList>('GET', `/api/v1/orgs/${orgId}/my-list`);
    groupIds = list.groups.map((g) => g.id);
  }, 120_000);

  it('GET /my-list with 1,000 tasks takes ≤ 50 ms', async () => {
    seed(ctx, owner.actor, orgId, groupIds, 1_000);
    const r = await measureMyList(owner, orgId);
    report.myList1000 = { tasks: r.tasks, medianMs: round(r.median), p95Ms: round(r.p95) };
    expect(r.tasks).toBeGreaterThanOrEqual(1_000);
    expect(r.median).toBeLessThanOrEqual(MY_LIST_BUDGET_MS * SLACK);
    expect(r.p95).toBeLessThanOrEqual(MY_LIST_BUDGET_MS * 2 * SLACK);
  }, 120_000);

  it('GET /my-list with 2,000 tasks (reported; the budget is for 1,000)', async () => {
    seed(ctx, owner.actor, orgId, groupIds, 1_000);
    const r = await measureMyList(owner, orgId);
    report.myList2000 = { tasks: r.tasks, medianMs: round(r.median), p95Ms: round(r.p95) };
    expect(r.tasks).toBeGreaterThanOrEqual(2_000);
    // Twice the tasks may take at most twice the budget.
    expect(r.median).toBeLessThanOrEqual(MY_LIST_BUDGET_MS * 2 * SLACK);
  }, 120_000);

  it('mutation p95 (create, patch, complete, move) is ≤ 20 ms', async () => {
    const headers = () => ({ 'Idempotency-Key': uuidv7(), 'X-Rooster-Edit-Time': `${Date.now()}` });
    const groupA = groupIds[1] as string;
    const groupB = groupIds[2] as string;
    const run = async (rounds: number) => {
      const out: Record<'create' | 'patch' | 'complete' | 'move', number[]> = {
        create: [],
        patch: [],
        complete: [],
        move: [],
      };
      for (let i = 0; i < rounds; i++) {
        let created: Task | undefined;
        out.create.push(
          await timed(async () => {
            const res = await owner.call(
              'POST',
              `/api/v1/orgs/${orgId}/tasks`,
              { title: `New ${i}`, groupId: groupA, tagNames: ['work'] },
              headers(),
            );
            created = (await res.clone().json()) as Task;
            return res;
          }, 201),
        );
        const id = (created as Task).id;
        out.patch.push(
          await timed(
            () =>
              owner.call(
                'PATCH',
                `/api/v1/tasks/${id}`,
                { title: `Renamed ${i}`, dueDate: '2026-11-02' },
                headers(),
              ),
            200,
          ),
        );
        out.move.push(
          await timed(
            () =>
              owner.call(
                'POST',
                `/api/v1/tasks/${id}/move`,
                { groupId: groupB, afterId: null, beforeId: null },
                headers(),
              ),
            200,
          ),
        );
        out.complete.push(
          await timed(
            () =>
              owner.call('POST', `/api/v1/tasks/${id}/complete`, { completed: true }, headers()),
            200,
          ),
        );
      }
      return out;
    };
    await run(10); // warm-up
    const out = await run(60);
    const all = Object.values(out).flat();
    const per = Object.fromEntries(
      Object.entries(out).map(([k, v]) => [
        k,
        { medianMs: round(percentile(v, 50)), p95Ms: round(percentile(v, 95)) },
      ]),
    );
    report.mutations = { ...per, all: { p95Ms: round(percentile(all, 95)) } };
    // The figures for the report (AC-11.4); warn is the level the linter allows in tests.
    console.warn('[perf] AC-11.4 server', JSON.stringify(report));
    expect(percentile(all, 95)).toBeLessThanOrEqual(MUTATION_P95_BUDGET_MS * SLACK);
  }, 120_000);
});
