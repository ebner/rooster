import type { Actor } from '../services/context.ts';

/**
 * The remote MCP endpoint (11 §5) runs its tools against the REST API **in-process**: it calls
 * `app.fetch(request, { [IN_PROCESS_ACTOR]: actor })` with the actor it already resolved from
 * the OAuth token, so every route, service check, rate limit and activity entry applies
 * unchanged and the token is never forwarded (11 §7, no token passthrough). A symbol key can
 * only be set by code in this process, never by an HTTP request (ADR 0042).
 */
export const IN_PROCESS_ACTOR: unique symbol = Symbol('rooster.inProcessActor');

export interface InProcessBindings {
  [IN_PROCESS_ACTOR]?: Actor;
}

/** The actor an in-process request carries, if any. */
export function inProcessActor(env: unknown): Actor | null {
  if (typeof env !== 'object' || env === null) return null;
  return (env as InProcessBindings)[IN_PROCESS_ACTOR] ?? null;
}
