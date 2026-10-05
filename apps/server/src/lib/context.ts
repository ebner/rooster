import type { RequestIdVariables } from 'hono/request-id';
import type { Actor } from '../services/context.ts';
import type { Logger } from './logger.ts';

export interface AppVariables extends RequestIdVariables {
  /** Request-scoped child logger carrying `reqId`. */
  logger: Logger;
  /** Set by the actor middleware on every authenticated `/api/v1` request. */
  actor?: Actor;
}

export interface AppEnv {
  Variables: AppVariables;
}
