import type { Auth } from '../auth/auth.ts';
import type { Config } from '../config.ts';
import type { Logger } from '../lib/logger.ts';
import type { Services } from '../services/index.ts';

/** What the Phase 9 route groups (OAuth, identities, MCP, discovery) are registered with. */
export interface P9RouteDeps {
  auth: Auth;
  config: Config;
  services: Services;
  logger: Logger;
  clock: () => number;
  version: string;
}
