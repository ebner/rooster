import type { ListOp, ReducerContext } from '@rooster/core/reducers';
import { clear, createStore, delMany, setMany, type UseStore, values } from 'idb-keyval';

/** One queued list op as stored in the IndexedDB outbox (04 §6.2). */
export interface OutboxRecord {
  op: ListOp;
  orgId: string;
  ctx: ReducerContext;
  /**
   * The signed-in user who queued the op. Only that user's confirmed session ever sends it;
   * missing on records written before 1.0.1 (the engine assigns them to the cache owner).
   */
  userId?: string;
}

/**
 * Durable storage of the pipeline's FIFO. Ops are written before they are sent and removed
 * once the server confirmed or rejected them, so a reload, a crash or a closed tab never
 * loses an edit.
 */
export interface Outbox {
  /** Every record, oldest first. */
  load(): Promise<OutboxRecord[]>;
  /** Adds or rewrites records (rewrites keep their slot: the key is the op id). */
  put(records: readonly OutboxRecord[]): Promise<void>;
  remove(opIds: readonly string[]): Promise<void>;
  clear(): Promise<void>;
}

export const outboxDbName = 'rooster-outbox';
export const outboxStoreName = 'outbox';

/**
 * The IndexedDB outbox: database `rooster-outbox`, object store `outbox`, keyed by `opId`.
 * Op ids are UUIDv7 and monotonic per tab, so key order is enqueue order (FIFO); ops of
 * different tabs interleave by time.
 */
export function createIdbOutbox(
  store: UseStore = createStore(outboxDbName, outboxStoreName),
): Outbox {
  return {
    load: () => values<OutboxRecord>(store),
    put: (records) =>
      records.length === 0
        ? Promise.resolve()
        : setMany(
            records.map((r) => [r.op.opId, r]),
            store,
          ),
    remove: (opIds) => (opIds.length === 0 ? Promise.resolve() : delMany([...opIds], store)),
    clear: () => clear(store),
  };
}

/** An outbox that keeps nothing across reloads (tests, and browsers without IndexedDB). */
export function createMemoryOutbox(): Outbox & { records: Map<string, OutboxRecord> } {
  const records = new Map<string, OutboxRecord>();
  return {
    records,
    load: async () =>
      [...records.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r),
    put: async (list) => {
      for (const r of list) records.set(r.op.opId, structuredClone(r));
    },
    remove: async (opIds) => {
      for (const id of opIds) records.delete(id);
    },
    clear: async () => records.clear(),
  };
}

/** Whether IndexedDB can be used here (missing in some private modes and in plain Node). */
export function hasIndexedDb(): boolean {
  try {
    return typeof globalThis.indexedDB !== 'undefined' && globalThis.indexedDB !== null;
  } catch {
    return false;
  }
}
