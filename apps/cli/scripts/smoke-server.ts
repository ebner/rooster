/**
 * A throwaway rooster server for `smoke.sh`: the server's test app (in-memory database) on a
 * free port, with one user and a PAT. Writes `ROOSTER_SMOKE_*` lines to the file in argv[2],
 * then serves until killed.
 */
import { writeFileSync } from 'node:fs';
import { startServer } from '../test/support/rooster-server.ts';

const out = process.argv[2];
if (out === undefined) {
  console.error('usage: smoke-server.ts <env file>');
  process.exit(2);
}
const email = 'smoke@example.com';
const server = await startServer();
const user = await server.user(email, 'Smoke Test');
const { token } = await user.token({ scopes: ['tasks:read'], name: 'smoke' });
writeFileSync(
  out,
  `ROOSTER_SMOKE_SERVER=${server.url}\nROOSTER_SMOKE_TOKEN=${token}\nROOSTER_SMOKE_EMAIL=${email}\n`,
  { mode: 0o600 },
);
const stop = async () => {
  await server.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
