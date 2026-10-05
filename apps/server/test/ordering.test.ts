import { compareKeys, MAX_KEY_LENGTH } from '@rooster/core/ordering';
import type { Task, TaskMoveResult } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { placement } from '../src/db/schema/index.ts';
import { type Keyed, OrderingService } from '../src/services/ordering-service.ts';
import { createTask, groupNamed, listCtx, meta, titlesIn } from './list-helpers.ts';

const ordering = new OrderingService();

function domain(items: Keyed[]) {
  const writes: Keyed[] = [];
  return {
    items,
    writes,
    write: (id: string, position: string) => {
      writes.push({ id, position });
    },
  };
}

describe('OrderingService', () => {
  const items: Keyed[] = [
    { id: 'a', position: 'a0' },
    { id: 'b', position: 'a1' },
    { id: 'c', position: 'a2' },
  ];

  it('resolves intents to slots', () => {
    expect(ordering.slot(items, {})).toEqual({ index: 3, fellBack: false });
    expect(ordering.slot(items, 'top')).toEqual({ index: 0, fellBack: false });
    expect(ordering.slot(items, { afterId: null, beforeId: 'a' })).toEqual({
      index: 0,
      fellBack: false,
    });
    expect(ordering.slot(items, { afterId: 'b' })).toEqual({ index: 2, fellBack: false });
    expect(ordering.slot(items, { beforeId: 'c' })).toEqual({ index: 2, fellBack: false });
    // Not adjacent (hidden items between): directly below `afterId`.
    expect(ordering.slot(items, { afterId: 'a', beforeId: 'c' })).toEqual({
      index: 1,
      fellBack: false,
    });
  });

  it('falls back to the end for foreign or out-of-order neighbours', () => {
    expect(ordering.slot(items, { afterId: 'zzz' })).toEqual({ index: 3, fellBack: true });
    expect(ordering.slot(items, { beforeId: 'zzz' })).toEqual({ index: 3, fellBack: true });
    expect(ordering.slot(items, { afterId: 'c', beforeId: 'a' })).toEqual({
      index: 3,
      fellBack: true,
    });
  });

  it('generates keys between the actual neighbours', () => {
    const d = domain(items);
    const { keys, rebalanced } = ordering.place(d, { afterId: 'a', beforeId: 'b' }, 3);
    expect(rebalanced).toBe(false);
    expect(keys).toHaveLength(3);
    const all = ['a0', ...keys, 'a1'];
    expect([...all].sort(compareKeys)).toEqual(all);
    expect(d.writes).toEqual([]);
  });

  it('re-keys the domain when neighbours share a key (collision)', () => {
    const d = domain([
      { id: 'a', position: 'a0' },
      { id: 'b', position: 'a0' },
    ]);
    const { keys, rebalanced } = ordering.place(d, { afterId: 'a', beforeId: 'b' });
    expect(rebalanced).toBe(true);
    const byId = new Map(d.writes.map((w) => [w.id, w.position]));
    const a = byId.get('a') ?? 'a0';
    const b = byId.get('b') ?? 'a0';
    expect(compareKeys(a, keys[0] as string)).toBe(-1);
    expect(compareKeys(keys[0] as string, b)).toBe(-1);
  });

  it('re-keys the domain when a key would exceed 64 characters', () => {
    const long = `a0${'0'.repeat(MAX_KEY_LENGTH)}1`;
    const d = domain([
      { id: 'a', position: 'a0' },
      { id: 'b', position: long },
      { id: 'c', position: 'a1' },
    ]);
    const { keys, rebalanced } = ordering.place(d, { afterId: 'a', beforeId: 'b' });
    expect(rebalanced).toBe(true);
    const final = new Map<string, string>([
      ['a', 'a0'],
      ['b', long],
      ['c', 'a1'],
      ...d.writes.map((w): [string, string] => [w.id, w.position]),
      ['new', keys[0] as string],
    ]);
    const order = [...final].sort((x, y) => compareKeys(x[1], y[1])).map(([id]) => id);
    expect(order).toEqual(['a', 'new', 'b', 'c']);
    expect([...final.values()].every((k) => k.length <= MAX_KEY_LENGTH)).toBe(true);
  });
});

describe('placement ordering through the API', () => {
  it('rebalances a group whose keys grew too long, keeping the order', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    const x = await createTask(a, { title: 'x', groupId: prio.id });
    const y = await createTask(a, { title: 'y', groupId: prio.id });
    const z = await createTask(a, { title: 'z', groupId: prio.id });
    // Force pathological keys: x and y adjacent with a 66-character gap.
    ctx.db.orm.update(placement).set({ position: 'a0' }).where(eq(placement.taskId, x.id)).run();
    ctx.db.orm
      .update(placement)
      .set({ position: `a0${'0'.repeat(MAX_KEY_LENGTH)}1` })
      .where(eq(placement.taskId, y.id))
      .run();
    const moved = await a.ok<TaskMoveResult>('POST', `/api/v1/tasks/${z.id}/move`, {
      groupId: prio.id,
      afterId: x.id,
      beforeId: y.id,
    });
    expect(moved.placement.position.length).toBeLessThanOrEqual(MAX_KEY_LENGTH);
    expect(await titlesIn(a, prio.id)).toEqual(['x', 'z', 'y']);
    const keys = ctx.db.orm
      .select({ position: placement.position })
      .from(placement)
      .where(eq(placement.groupId, prio.id))
      .all();
    expect(keys.every((k) => k.position.length <= MAX_KEY_LENGTH)).toBe(true);
  });

  it('AC-2.10 concurrent moves between the same neighbours get distinct, ordered keys', async () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const prio = await groupNamed(a, 'Prio');
    const today = await groupNamed(a, 'Today');
    const left = await createTask(a, { title: 'left', groupId: prio.id });
    const right = await createTask(a, { title: 'right', groupId: prio.id });
    const m1 = await createTask(a, { title: 'm1', groupId: today.id });
    const m2 = await createTask(a, { title: 'm2', groupId: today.id });
    const body = { groupId: prio.id, afterId: left.id, beforeId: right.id };
    const [r1, r2] = await Promise.all([
      a.ok<TaskMoveResult>('POST', `/api/v1/tasks/${m1.id}/move`, body),
      a.ok<TaskMoveResult>('POST', `/api/v1/tasks/${m2.id}/move`, body),
    ]);
    expect(r1.placement.position).not.toBe(r2.placement.position);
    const titles = await titlesIn(a, prio.id);
    expect(titles[0]).toBe('left');
    expect(titles[3]).toBe('right');
    expect(titles.slice(1, 3).sort()).toEqual(['m1', 'm2']);
    // Deterministic: the later request lands directly below `left`, above the earlier one.
    const pos = new Map([
      ['m1', r1.placement.position],
      ['m2', r2.placement.position],
    ]);
    expect(titles.slice(1, 3)).toEqual(
      [...pos].sort((x, y) => compareKeys(x[1], y[1])).map(([t]) => t),
    );
  });

  it('fuzz: 600 random creates, moves and deletes keep keys unique and the order total', () => {
    const ctx = listCtx();
    const a = ctx.user('a@example.com');
    const { groups, tasks } = ctx.app.services;
    const gids = ['F1', 'F2', 'F3'].map(
      (name) => groups.create(a.actor, 'personal', { name }).group.id,
    );
    // Deterministic PRNG (mulberry32) so a failure is reproducible.
    let seed = 0x5eed;
    const rand = () => {
      seed = (seed + 0x6d2b79f5) | 0;
      let t = seed;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rand() * xs.length)] as T;
    const live: Task[] = [];
    const groupOf = () => pick(gids);
    const neighbour = () => (live.length === 0 || rand() < 0.2 ? null : pick(live).id);

    for (let i = 0; i < 600; i++) {
      const r = rand();
      if (r < 0.4 || live.length < 3) {
        const intent = rand() < 0.5 ? {} : { afterId: neighbour(), beforeId: neighbour() };
        live.push(
          tasks.create(a.actor, 'personal', { title: `t${i}`, groupId: groupOf(), ...intent }),
        );
      } else if (r < 0.85) {
        const t = pick(live);
        tasks.move(
          a.actor,
          t.id,
          { groupId: groupOf(), afterId: neighbour(), beforeId: neighbour() },
          meta(),
        );
      } else {
        const t = pick(live);
        tasks.remove(a.actor, t.id, meta());
        live.splice(live.indexOf(t), 1);
      }
    }

    const rows = ctx.db.orm.select().from(placement).all();
    const perGroup = new Map<string, string[]>();
    for (const row of rows) {
      const keys = perGroup.get(row.groupId) ?? [];
      keys.push(row.position);
      perGroup.set(row.groupId, keys);
    }
    for (const keys of perGroup.values()) {
      expect(new Set(keys).size).toBe(keys.length);
      expect(keys.every((k) => k.length <= MAX_KEY_LENGTH)).toBe(true);
    }
    expect(rows.length).toBeGreaterThan(200);
  });
});
