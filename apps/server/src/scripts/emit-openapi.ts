// Writes apps/server/openapi.json, the input for packages/api-client (`pnpm gen:api`).
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createApp, openApiDocumentConfig } from '../app.ts';
import { parseConfig } from '../config.ts';
import { openDb } from '../db/client.ts';
import { runMigrations } from '../db/migrate.ts';
import { createLogger } from '../lib/logger.ts';
import { VERSION } from '../version.ts';

const parsed = parseConfig({
  ROOSTER_BASE_URL: 'http://localhost:3000',
  ROOSTER_AUTH_SECRET: 'openapi-emitter-placeholder-secret-0000',
  ROOSTER_ADMIN_EMAILS: 'admin@example.com',
  ROOSTER_GOOGLE_CLIENT_ID: 'openapi-emitter',
  ROOSTER_GOOGLE_CLIENT_SECRET: 'openapi-emitter',
  ROOSTER_DATA_DIR: '/nonexistent',
});
if (!parsed.ok) throw new Error(parsed.errors.join('\n'));

const db = openDb(':memory:');
runMigrations(db);
const app = createApp({
  config: parsed.config,
  db,
  logger: createLogger('silent'),
  version: VERSION,
});
const document = app.getOpenAPI31Document(openApiDocumentConfig(VERSION));
db.close();

const out = join(dirname(fileURLToPath(import.meta.url)), '../../openapi.json');
writeFileSync(out, `${JSON.stringify(document, null, 2)}\n`);
process.stdout.write(`openapi: wrote ${out}\n`);
