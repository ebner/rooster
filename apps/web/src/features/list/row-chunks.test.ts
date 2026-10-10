import { describe, expect, test } from 'vitest';
import type { Row, TaskRow } from './model/rows';
import { ChunkAssigner, chunkMax, chunkTarget, isChunk, type ListItem } from './row-chunks';

const task = (id: string): TaskRow => ({ kind: 'task', id, level: 2 }) as unknown as TaskRow;
const header = (id: string): Row => ({ kind: 'group', id }) as unknown as Row;
const ids = (n: number, prefix = 't') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

/** The chunk key of every task row. */
function keys(items: ListItem[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const item of items)
    if (isChunk(item)) for (const row of item.rows) out.set(row.id, item.key);
  return out;
}

function layout(items: ListItem[]): string[][] {
  return items.map((item) => (isChunk(item) ? item.rows.map((r) => r.id) : [`#${item.id}`]));
}

describe('ChunkAssigner (AC-11.4)', () => {
  test('a first render fills chunks to the target size; headers stay outside chunks', () => {
    const rows = [header('g1'), ...ids(120).map(task), header('g2'), ...ids(10, 'u').map(task)];
    const items = new ChunkAssigner().assign(rows, new Set());
    expect(layout(items).map((c) => c.length)).toEqual([1, chunkTarget, chunkTarget, 24, 1, 10]);
    // Every row appears once, in order.
    expect(layout(items).flat()).toEqual(rows.map((r) => (r.kind === 'task' ? r.id : `#${r.id}`)));
  });

  test('an insert joins the chunk it lands in; no other row changes chunk', () => {
    const assigner = new ChunkAssigner();
    const rows = ids(100).map(task);
    const before = keys(assigner.assign(rows, new Set()));
    const next = [...rows.slice(0, 30), task('new'), ...rows.slice(30)];
    const after = keys(assigner.assign(next, new Set(['new'])));
    for (const row of rows) expect(after.get(row.id)).toBe(before.get(row.id));
    expect(after.get('new')).toBe(before.get('t29'));
  });

  test('moving the focused row across a chunk boundary keeps its chunk (down and up)', () => {
    const assigner = new ChunkAssigner();
    let rows = ids(100).map(task);
    const first = keys(assigner.assign(rows, new Set()));
    // t47 is the last row of the first chunk; Ctrl+↓ swaps it with t48.
    expect(first.get('t47')).not.toBe(first.get('t48'));
    const swap = (list: TaskRow[], a: number) => {
      const copy = [...list];
      [copy[a], copy[a + 1]] = [copy[a + 1] as TaskRow, copy[a] as TaskRow];
      return copy;
    };
    rows = swap(rows, 47);
    const down = keys(assigner.assign(rows, new Set(['t47'])));
    expect(down.get('t47')).toBe(first.get('t47'));
    // And back up again: still its chunk.
    rows = swap(rows, 47);
    const up = keys(assigner.assign(rows, new Set(['t47'])));
    expect(up.get('t47')).toBe(first.get('t47'));
    // t49 (now the first of the second chunk) moving up past t48 keeps its chunk too.
    expect(up.get('t49')).not.toBe(up.get('t48'));
    rows = swap(rows, 48);
    const upAgain = keys(assigner.assign(rows, new Set(['t49'])));
    expect(upAgain.get('t49')).toBe(up.get('t49'));
  });

  test('the focused row keeps its chunk when it moves far down, into another group', () => {
    const assigner = new ChunkAssigner();
    const a = ids(60, 'a').map(task);
    const b = ids(60, 'b').map(task);
    const before = keys(assigner.assign([header('g1'), ...a, header('g2'), ...b], new Set()));
    const moved = a[5] as TaskRow;
    const next = [header('g1'), ...a.filter((r) => r !== moved), header('g2'), moved, ...b];
    const items = assigner.assign(next, new Set([moved.id]));
    expect(keys(items).get(moved.id)).toBe(before.get(moved.id));
    // Keys stay unique and chunks contiguous.
    const chunkKeys = items.filter(isChunk).map((c) => c.key);
    expect(new Set(chunkKeys).size).toBe(chunkKeys.length);
  });

  test('deleted rows leave; chunks never grow past the max', () => {
    const assigner = new ChunkAssigner();
    let rows = ids(50).map(task);
    assigner.assign(rows, new Set());
    for (let i = 0; i < 200; i++) rows = [...rows.slice(0, 10), task(`n${i}`), ...rows.slice(10)];
    const items = assigner.assign(rows, new Set());
    for (const item of items)
      if (isChunk(item)) expect(item.rows.length).toBeLessThanOrEqual(chunkMax);
    const fewer = assigner.assign(rows.slice(100), new Set());
    expect(layout(fewer).flat()).toEqual(rows.slice(100).map((r) => r.id));
  });
});
