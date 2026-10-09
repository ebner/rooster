import { AsyncLocalStorage } from 'node:async_hooks';
import { uuidv7 } from '@rooster/core/ids';

/**
 * One logical change's request identity (06 §1): an `Idempotency-Key` per write it sends, in
 * order, and one edit time. Sending the change again with `r` reuses the keys of writes whose
 * outcome is unknown (a network error, a lost response, a 5xx, a timeout), so a create whose
 * response was lost is answered from the server's idempotency record instead of creating a
 * second task. A write the server definitively rejected (4xx) gets a new key on the retry: the
 * server stored the rejection under the old one, and the cause may have been fixed meanwhile
 * (a deleted task restored on the web). Writes of the change that succeeded keep theirs.
 */
export interface MutationIdentity {
  editTime: number;
  keys: (string | undefined)[];
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
 * Sends `request` through `send`, a write stamped with the current change's key and edit time
 * (outside a change it is left alone, and `cliFetch` adds fresh ones).
 */
export async function sendWithIdentity(
  request: Request,
  send: (request: Request) => Promise<Response>,
): Promise<Response> {
  const identity = store.getStore();
  if (identity === undefined || request.method === 'GET' || request.method === 'HEAD') {
    return send(request);
  }
  const index = identity.next++;
  const key = identity.keys[index] ?? uuidv7();
  identity.keys[index] = key;
  const headers = new Headers(request.headers);
  headers.set('Idempotency-Key', key);
  headers.set('X-Rooster-Edit-Time', String(identity.editTime));
  const response = await send(new Request(request, { headers }));
  if (response.status >= 400 && response.status < 500) identity.keys[index] = undefined;
  return response;
}
