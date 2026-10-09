import type { Server } from 'node:http';
import { serve } from '@hono/node-server';
import { createApp } from './app.ts';
import { loadConfig } from './config.ts';
import { prepareDatabase } from './db/boot.ts';
import { registerJobs } from './jobs/register.ts';
import { createScheduler } from './jobs/scheduler.ts';
import { trackConnections } from './lib/graceful-close.ts';
import { createLogger } from './lib/logger.ts';
import { VERSION } from './version.ts';

const SHUTDOWN_GRACE_MS = 10_000;

// Before anything touches the disk: the database, its WAL and backups hold every user's
// data, so new files are 0600 and new directories 0700 whatever the inherited umask.
process.umask(0o077);

const config = loadConfig();
const logger = createLogger(config.logLevel);

let prepared: ReturnType<typeof prepareDatabase>;
try {
  prepared = prepareDatabase(config.dataDir, logger, VERSION);
} catch (err) {
  logger.fatal({ err, dataDir: config.dataDir }, 'database startup failed');
  process.exit(1);
}
const { db, instanceId } = prepared;

const app = createApp({ config, db, logger, version: VERSION });

// 05 §3: a search index whose row count disagrees with the live tasks (a restored backup, a
// crash between versions) is rebuilt before the first request.
const reindexed = app.services.search.rebuildIfStale();
if (reindexed !== null) {
  logger.warn(
    { before: reindexed.before, indexed: reindexed.indexed, durationMs: reindexed.durationMs },
    'search index rebuilt',
  );
}

const server = serve({ fetch: app.fetch, port: config.port }, (info) => {
  logger.info(
    { port: info.port, version: VERSION, gitSha: config.gitSha, instanceId },
    'rooster listening',
  );
});

const connections = trackConnections(server as Server);

const scheduler = createScheduler(logger);
registerJobs(scheduler, { db, services: app.services, config });

let shuttingDown = false;

async function shutdown(signal: NodeJS.Signals): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'shutting down');

  // SSE streams never finish on their own: end them first, so draining waits only for real
  // requests. Clients reconnect (with backoff) to the next instance.
  const streams = app.hub.shutdown();
  if (streams > 0) logger.info({ streams }, 'closed event streams');
  if (!(await connections.close(SHUTDOWN_GRACE_MS))) {
    logger.warn({ graceMs: SHUTDOWN_GRACE_MS }, 'in-flight requests did not finish in time');
  }

  scheduler.stop();
  db.close();
  logger.info('shutdown complete');
  process.exit(0);
}

process.once('SIGTERM', (signal) => void shutdown(signal));
process.once('SIGINT', (signal) => void shutdown(signal));
