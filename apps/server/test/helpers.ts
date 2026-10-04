import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type App, createApp } from '../src/app.ts';
import { type Config, parseConfig } from '../src/config.ts';
import { type AppDb, openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { createLogger, type Logger } from '../src/lib/logger.ts';

export const TEST_ENV = {
  ROOSTER_BASE_URL: 'http://localhost:3000',
  ROOSTER_AUTH_SECRET: 'test-secret-test-secret-test-secret-42',
  ROOSTER_ADMIN_EMAILS: 'admin@example.com',
} as const;

/** A migrated, private in-memory database. */
export function createTestDb(): AppDb {
  const db = openDb(':memory:');
  runMigrations(db);
  return db;
}

export function testConfig(env: Record<string, string> = {}): Config {
  const result = parseConfig({ ...TEST_ENV, ROOSTER_DATA_DIR: '/nonexistent', ...env });
  if (!result.ok) throw new Error(result.errors.join('\n'));
  return result.config;
}

export function createTestApp(
  options: { env?: Record<string, string>; db?: AppDb; logger?: Logger } = {},
): { app: App; db: AppDb; config: Config } {
  const config = testConfig({ ROOSTER_WEB_DIR: '/nonexistent/web', ...options.env });
  const db = options.db ?? createTestDb();
  const logger = options.logger ?? createLogger('silent');
  const app = createApp({ config, db, logger, version: '0.0.0-test' });
  return { app, db, config };
}

/** A logger whose JSON lines are collected in `lines`. */
export function captureLogger(): { logger: Logger; lines: Record<string, unknown>[] } {
  const lines: Record<string, unknown>[] = [];
  const logger = createLogger('debug', {
    write: (chunk: string) => {
      lines.push(JSON.parse(chunk) as Record<string, unknown>);
    },
  });
  return { logger, lines };
}

/** A fresh temp directory, removed by the returned cleanup function. */
export function tempDir(prefix = 'rooster-test-'): { path: string; cleanup: () => void } {
  const path = mkdtempSync(join(tmpdir(), prefix));
  return { path, cleanup: () => rmSync(path, { recursive: true, force: true }) };
}
