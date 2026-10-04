import type { RequestIdVariables } from 'hono/request-id';
import type { Logger } from './logger.ts';

export interface AppVariables extends RequestIdVariables {
  /** Request-scoped child logger carrying `reqId`. */
  logger: Logger;
}

export interface AppEnv {
  Variables: AppVariables;
}
