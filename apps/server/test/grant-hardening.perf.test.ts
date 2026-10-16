// The grant reviews' timing budgets (review rounds 5–7): moving and re-parenting a task with
// 2,000 subtasks under a restricted grant stream, and subtree reach at 135,000 children. They
// run here, alone and without coverage (`pnpm --filter @rooster/server test:perf`), because the
// parallel coverage run on a shared machine missed them by a few milliseconds.
// ROOSTER_PERF_SLACK (a factor, default 1) loosens them on a slow or shared machine.
import type { Task } from '@rooster/core/schemas';
import { describe, expect, it } from 'vitest';
import { readOnly } from '../src/services/context.ts';
import { taskReach } from '../src/services/event-audience.ts';
import { subtreePlacements } from '../src/services/list-access.ts';
import { ALL, actorOf, openStream, pat } from './grant-helpers.ts';
import { groupNamed, listCtx, meta } from './list-helpers.ts';

const SLACK = Number(process.env.ROOSTER_PERF_SLACK ?? '1') || 1;

describe('review round 5', () => {
  it('R5 moving a task with 2,000 subtasks stays fast, with and without a grant stream', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const prio = await groupNamed(owner, 'Prio');
    const today = await groupNamed(owner, 'Today');
    const parent = await owner.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'Big', groupId: prio.id },
      201,
    );
    const insert = ctx.db.sqlite.prepare(
      "INSERT INTO task (id, org_id, parent_id, subtask_position, title, assignee_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'sub', ?, ?, 0, 0)",
    );
    ctx.db.sqlite.transaction(() => {
      for (let i = 0; i < 2_000; i++) {
        insert.run(
          `0199aaaa-0000-7000-8000-${i.toString(16).padStart(12, '0')}`,
          parent.orgId,
          parent.id,
          `a${i.toString(36).padStart(4, '0')}`,
          owner.userId,
          owner.userId,
        );
      }
    })();
    const { tasks } = ctx.app.services;
    let edit = Date.now();
    const timedMove = (groupId: string) => {
      edit += 1;
      const started = performance.now();
      tasks.move(owner.actor, parent.id, { groupId }, meta(edit));
      return performance.now() - started;
    };
    timedMove(today.id);
    expect(timedMove(prio.id)).toBeLessThan(20 * SLACK);
    // A grant reading only Prio: its stream needs the prior-group snapshot.
    const reader = await pat(owner, ['tasks:read'], {
      orgs: [{ orgId: parent.orgId, read: { groups: [prio.id] }, write: 'none' }],
    });
    const stream = openStream(ctx, await actorOf(ctx, reader.token));
    expect(ctx.app.services.events.hasRestrictedGrantStream(parent.orgId)).toBe(true);
    timedMove(today.id);
    expect(timedMove(prio.id)).toBeLessThan(20 * SLACK);
    // A reorder inside the group takes no snapshot at all.
    expect(timedMove(prio.id)).toBeLessThan(20 * SLACK);
    stream.close();
    expect(ctx.app.services.events.hasRestrictedGrantStream(parent.orgId)).toBe(false);
  });
});

describe('review round 6 (focused review)', () => {
  it('P1 re-parenting a task with 2,000 children: under 20 ms, under 50 ms with a restricted grant stream open', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const prio = await groupNamed(owner, 'Prio');
    const make = (title: string) =>
      owner.ok<Task>('POST', '/api/v1/orgs/personal/tasks', { title, groupId: prio.id }, 201);
    const parent = await make('Big');
    const targetA = await make('A');
    const targetB = await make('B');
    const insert = ctx.db.sqlite.prepare(
      "INSERT INTO task (id, org_id, parent_id, subtask_position, title, assignee_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'sub', ?, ?, 0, 0)",
    );
    ctx.db.sqlite.transaction(() => {
      for (let i = 0; i < 2_000; i++) {
        insert.run(
          `0199aaaa-0000-7000-8000-${i.toString(16).padStart(12, '0')}`,
          parent.orgId,
          parent.id,
          `a${i.toString(36).padStart(4, '0')}`,
          owner.userId,
          owner.userId,
        );
      }
    })();
    const actor = await actorOf(ctx, (await pat(owner, ALL)).token);
    const watcher = await pat(owner, ['tasks:read'], {
      orgs: [{ orgId: parent.orgId, read: { groups: [prio.id] }, write: 'none' }],
    });
    const stream = openStream(ctx, await actorOf(ctx, watcher.token));
    const { tasks } = ctx.app.services;
    let edit = Date.now();
    const timed = (parentId: string) => {
      edit += 1;
      const started = performance.now();
      tasks.patch(actor, parent.id, { parentId }, meta(edit));
      return performance.now() - started;
    };
    const browserTimed = (parentId: string) => {
      edit += 1;
      const started = performance.now();
      tasks.patch(owner.actor, parent.id, { parentId }, meta(edit));
      return performance.now() - started;
    };
    // The best of a few runs after a warm-up, alternating targets so each is a real move.
    const best = (run: (parentId: string) => number) => {
      run(targetA.id);
      return Math.min(run(targetB.id), run(targetA.id), run(targetB.id));
    };
    // Shared CI runners are about twice as slow as a workstation; a quadratic regression still
    // lands far above these budgets there.
    const budget = (ms: number) => (process.env.CI ? ms * 2.5 : ms) * SLACK;
    // A stream of a grant reading only Prio: the prior-group snapshot and the per-key filter
    // both run over the 2,000 subtasks.
    expect(best(timed)).toBeLessThan(budget(50));
    stream.close();
    // No such stream: the acting grant's own checks only, and the browser.
    expect(best(timed)).toBeLessThan(budget(20));
    expect(best(browserTimed)).toBeLessThan(budget(20));
  });
});

describe('review round 7 (performance rework)', () => {
  it('P7 subtree placements and task reach scale to 135,000 placed children and 33,000 roots', async () => {
    const ctx = listCtx();
    const owner = ctx.user('owner@example.com');
    const prio = await groupNamed(owner, 'Prio');
    const parent = await owner.ok<Task>(
      'POST',
      '/api/v1/orgs/personal/tasks',
      { title: 'Huge', groupId: prio.id },
      201,
    );
    const insertTask = ctx.db.sqlite.prepare(
      "INSERT INTO task (id, org_id, parent_id, subtask_position, title, assignee_id, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, 'sub', ?, ?, 0, 0)",
    );
    const insertPlacement = ctx.db.sqlite.prepare(
      'INSERT INTO placement (task_id, user_id, org_id, group_id, position, updated_at) VALUES (?, ?, ?, ?, ?, 0)',
    );
    const ids: string[] = [];
    ctx.db.sqlite.transaction(() => {
      for (let i = 0; i < 135_000; i++) {
        const id = `0199bbbb-0000-7000-8000-${i.toString(16).padStart(12, '0')}`;
        ids.push(id);
        const position = `a${i.toString(36).padStart(4, '0')}`;
        insertTask.run(id, parent.orgId, parent.id, position, owner.userId, owner.userId);
        insertPlacement.run(id, owner.userId, parent.orgId, prio.id, position);
      }
    })();
    // A spread of every returned row into push() overflowed the argument limit (RangeError).
    const placed = readOnly(ctx.db, (tx) => subtreePlacements(tx, [parent.id]));
    expect(placed.length).toBeGreaterThanOrEqual(135_000);
    // Excluding the roots from the ancestors must stay linear in the number of roots.
    const started = performance.now();
    const reach = readOnly(ctx.db, (tx) => taskReach(tx, ids.slice(0, 33_000)));
    expect(performance.now() - started).toBeLessThan(1_000 * SLACK);
    expect(reach.taskIds.has(parent.id)).toBe(true);
  }, 120_000);
});
