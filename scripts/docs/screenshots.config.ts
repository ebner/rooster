import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import type { PlaywrightTestConfig } from '@playwright/test';
import { DEMO } from './screenshots/demo-env';

/**
 * `pnpm docs:screenshots` (ADR 0052 §3): the e2e stack (mock IdP, a fresh API server, Vite) with
 * a fictional demo team, captured on desktop (1440 × 900) and phone (iPhone 15), light and dark.
 *
 * This file lives outside apps/web, so `@playwright/test` is resolved from the web app, the one
 * copy the runner itself uses (a second copy would refuse to load).
 */
const root = resolve(import.meta.dirname, '../..');
const requireFromWeb = createRequire(resolve(root, 'apps/web/package.json'));
const { devices } = requireFromWeb('@playwright/test') as typeof import('@playwright/test');

const dataDir = process.env.ROOSTER_DOCS_DATA_DIR;
if (!dataDir) throw new Error('Run through `pnpm docs:screenshots` (ROOSTER_DOCS_DATA_DIR unset)');

const serverEnv = {
  ROOSTER_BASE_URL: DEMO.baseURL,
  ROOSTER_AUTH_SECRET: 'docs-screenshots-only-Secret-0123456789-abcdefghijk',
  ROOSTER_ADMIN_EMAILS: DEMO.adminEmail,
  ROOSTER_ALLOWED_DOMAINS: DEMO.domain,
  ROOSTER_OIDC_PROVIDERS: JSON.stringify([
    {
      id: 'dev',
      name: 'Dev login',
      discoveryUrl: `${DEMO.idpIssuer}/.well-known/openid-configuration`,
      clientId: 'rooster-dev',
      clientSecret: 'rooster-dev-secret',
    },
  ]),
  ROOSTER_DATA_DIR: dataDir,
  ROOSTER_TRUST_PROXY: 'true',
  ROOSTER_BACKUP_CRON: 'off',
  // The demo has email configured so Settings → Notifications shows the email column; nothing
  // listens on this port, so no mail leaves the machine (failed sends are only logged).
  ROOSTER_SMTP_URL: 'smtp://127.0.0.1:2599',
  ROOSTER_MAIL_FROM: `rooster <rooster@${DEMO.domain}>`,
  ROOSTER_LOG_LEVEL: 'fatal',
  PORT: String(DEMO.apiPort),
};

/** Light always; dark projects skip themselves while the app has no dark theme (D-22). */
const themes = ['light', 'dark'] as const;
// Retina density: crisp in the README and on high-density screens; the optimiser keeps it small.
const desktop = {
  ...devices['Desktop Chrome'],
  viewport: { width: 1440, height: 900 },
  deviceScaleFactor: 2,
};
// iPhone 15 at 2× instead of 3×: the same layout, a third fewer pixels to store.
const phone = { ...devices['iPhone 15'], deviceScaleFactor: 2 };

const config: PlaywrightTestConfig = {
  testDir: 'screenshots',
  outputDir: resolve(dataDir, 'test-results'),
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: 'list',
  use: {
    baseURL: DEMO.baseURL,
    locale: 'en-GB',
    timezoneId: DEMO.timezone,
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'seed', testMatch: /seed\.setup\.ts$/, use: desktop },
    ...themes.flatMap((theme) => [
      {
        name: `desktop-${theme}`,
        testMatch: /desktop\.shots\.ts$/,
        dependencies: ['seed'],
        use: { ...desktop, colorScheme: theme },
        metadata: { theme, form: 'desktop' },
      },
      {
        name: `phone-${theme}`,
        testMatch: /phone\.shots\.ts$/,
        dependencies: ['seed'],
        use: { ...phone, colorScheme: theme },
        metadata: { theme, form: 'phone' },
      },
    ]),
  ],
  webServer: [
    {
      command: 'node scripts/dev-idp.mjs',
      cwd: root,
      url: `${DEMO.idpIssuer}/.well-known/openid-configuration`,
      env: { DEV_IDP_PORT: String(DEMO.idpPort) },
      reuseExistingServer: false,
      timeout: 60_000,
    },
    {
      command: `node ../web/e2e/support/wait-for.mjs ${DEMO.idpIssuer}/.well-known/openid-configuration && pnpm exec tsx src/main.ts`,
      cwd: resolve(root, 'apps/server'),
      url: `http://localhost:${DEMO.apiPort}/readyz`,
      env: serverEnv,
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm exec vite --port ${DEMO.webPort} --strictPort`,
      cwd: resolve(root, 'apps/web'),
      url: DEMO.baseURL,
      env: { ROOSTER_API_TARGET: `http://localhost:${DEMO.apiPort}` },
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
};

export default config;
