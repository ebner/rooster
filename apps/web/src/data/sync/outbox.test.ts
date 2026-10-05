import 'fake-indexeddb/auto';
import { uuidv7 } from '@rooster/core/ids';
import { type ListOp, listOps } from '@rooster/core/reducers';
import { createStore } from 'idb-keyval';
import { describe, expect, test } from 'vitest';
import { createIdbOutbox, createMemoryOutbox, type OutboxRecord } from './outbox';

const ctx = { userId: 'u1' };

function record(title: string): OutboxRecord {
  const op = {
    ...listOps.createTask({ id: uuidv7(), title, groupId: 'g' }),
    opId: uuidv7(),
    editTime: Date.now(),
    clientId: 'c',
  } as ListOp;
  return { op, orgId: 'org', ctx };
}

const titles = (records: OutboxRecord[]) =>
  records.map((r) => (r.op.kind === 'task.create' ? r.op.payload.title : r.op.kind));

describe('IndexedDB outbox (04 §6.2)', () => {
  test('keeps ops in FIFO order across instances (a reload)', async () => {
    const store = createStore('outbox-test-fifo', 'outbox');
    const outbox = createIdbOutbox(store);
    const [a, b, c] = [record('A'), record('B'), record('C')];
    await outbox.put([a, b]);
    await outbox.put([c]);
    const reopened = createIdbOutbox(createStore('outbox-test-fifo', 'outbox'));
    expect(titles(await reopened.load())).toEqual(['A', 'B', 'C']);

    await reopened.remove([b.op.opId]);
    expect(titles(await outbox.load())).toEqual(['A', 'C']);

    // A rewrite (tag remap) keeps the op's slot.
    await outbox.put([{ ...a, op: { ...a.op, editTime: 1 } as ListOp }]);
    expect(titles(await outbox.load())).toEqual(['A', 'C']);
    await outbox.clear();
    expect(await outbox.load()).toEqual([]);
  });

  test('the memory outbox behaves the same', async () => {
    const outbox = createMemoryOutbox();
    const [a, b] = [record('A'), record('B')];
    await outbox.put([b, a].reverse());
    expect(titles(await outbox.load())).toEqual(['A', 'B']);
    await outbox.remove([a.op.opId]);
    expect(titles(await outbox.load())).toEqual(['B']);
  });
});
