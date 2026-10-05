#!/usr/bin/env node
// Mock OIDC issuer for local development (WP 1.7). Every sign-in succeeds as the "next
// user" (default dev@example.com), or as the email in the authorize request's login_hint.
//
//   pnpm dev:idp                       # issuer http://localhost:9400
//   DEV_IDP_PORT=9500 pnpm dev:idp
//   curl -X POST localhost:9400/__next-user -H 'content-type: application/json' \
//        -d '{"email":"bob@example.com","name":"Bob"}'
//
// Point the server at it with ROOSTER_OIDC_PROVIDERS (see apps/server/.env.example).
// The implementation lives in apps/server/test/mock-idp.ts (Node strips its types).
import { DEFAULT_IDENTITY, NEXT_USER_PATH, startMockIdp } from '../apps/server/test/mock-idp.ts';

const port = Number(process.env.DEV_IDP_PORT ?? 9400);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`dev-idp: DEV_IDP_PORT must be a port number, got "${process.env.DEV_IDP_PORT}"`);
  process.exit(1);
}

const idp = await startMockIdp({ port, host: 'localhost' });
const provider = idp.provider();
console.log(`dev-idp: issuer ${idp.issuer} (next user: ${DEFAULT_IDENTITY.email})`);
console.log(`dev-idp: change the next user with POST ${idp.issuer}${NEXT_USER_PATH}`);
console.log(`dev-idp: ROOSTER_OIDC_PROVIDERS='${JSON.stringify([provider])}'`);

const stop = async () => {
  await idp.stop();
  process.exit(0);
};
process.once('SIGINT', stop);
process.once('SIGTERM', stop);
