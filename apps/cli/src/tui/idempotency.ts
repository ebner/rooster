import { AsyncLocalStorage } from 'node:async_hooks';
import { uuidv7 } from '@rooster/core/ids';

/**
 * One logical change's request identity (06 §1): an `Idempotency-Key` per write it sends, in
 * order, and one edit time. Sending the change again with `r` reuses them, so a create whose
 * response was lost is answered from the server's idempotency record instead of creating a
 * second task.
 */
export interface MutationIdentity {
  editTime: number;
  keys: string[];
  /** The next write's index into `keys` during the current attempt. */
  next: number;
}

export const mutationIdentity = (editTime: number): MutationIdentity => ({
  editTime,
  keys: [],
  next: 0,
});

const store = new AsyncLocalStorage<MutationIdentity>();

/** Runs one attempt of a change: its writes take the identity's keys from the first. */
export function withMutationIdentity<T>(
  identity: MutationIdentity,
  fn: () => Promise<T>,
): Promise<T> {
  identity.next = 0;
  return store.run(identity, fn);
}

/**
 * Stamps a write with the current change's key and edit time (left alone outside a change,
 * where `cliFetch` adds fresh ones).
 */
export function stampRequest(request: Request): Request {
  const identity = store.getStore();
  if (identity === undefined || request.method === 'GET' || request.method === 'HEAD') {
    return request;
  }
  const index = identity.next++;
  identity.keys[index] ??= uuidv7();
  const headers = new Headers(request.headers);
  headers.set('Idempotency-Key', identity.keys[index]);
  headers.set('X-Rooster-Edit-Time', String(identity.editTime));
  return new Request(request, { headers });
}
