import type { RequestIdVariables } from 'hono/request-id';
import type { Actor, OpMeta } from '../services/context.ts';
import type { Logger } from './logger.ts';

export interface AppVariables extends RequestIdVariables {
  /** Request-scoped child logger carrying `reqId`. */
  logger: Logger;
  /** Set by the actor middleware on every authenticated `/api/v1` request. */
  actor?: Actor;
  /** Edit time and client identity of the request (lib/request-meta.ts). */
  opMeta?: OpMeta;
}

export interface AppEnv {
  Variables: AppVariables;
}
