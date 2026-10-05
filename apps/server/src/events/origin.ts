import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<string | null>();

/**
 * Runs `fn` with the request's `X-Rooster-Client-Id` as the origin of every domain event it
 * emits. Request-scoped rather than a service argument: origin is transport metadata that
 * every mutation needs, including the ones that take no `OpMeta` (orgs, settings).
 */
export function runWithOrigin<T>(origin: string | null, fn: () => T): T {
  return storage.run(origin, fn);
}

/** The origin of the current request, or `null` outside one (jobs, auth hooks). */
export function currentOrigin(): string | null {
  return storage.getStore() ?? null;
}
