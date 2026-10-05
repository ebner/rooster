/** Shared by playwright.config.ts (server env) and the tests (who may sign in). */
export const e2eEnv = {
  idpPort: 9400,
  idpIssuer: 'http://localhost:9400',
  adminEmail: 'admin@example.com',
  /** Anyone at this domain may sign in (ROOSTER_ALLOWED_DOMAINS). */
  allowedDomain: 'allowed.test',
  /** Not allowlisted: these need an invite. */
  outsideDomain: 'outside.test',
} as const;
