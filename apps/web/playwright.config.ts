import { mkdirSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { defineConfig, devices } from '@playwright/test';
import { e2eEnv } from './e2e/support/env';

/**
 * e2e runs the whole stack: the mock IdP (scripts/dev-idp.mjs), the API server on a
 * fresh data directory, and Vite proxying /api to it. The browser only talks to Vite,
 * so Vite's origin is ROOSTER_BASE_URL (cookies, OAuth callback, CSRF origin).
 */
const webPort = 5181;
const apiPort = 3181;
const baseURL = `http://localhost:${webPort}`;
const { idpIssuer, idpPort } = e2eEnv;

// Workers re-evaluate this file; the env var keeps one data directory per run.
process.env.ROOSTER_E2E_DATA_DIR ??= mkdtempSync(join(tmpdir(), 'rooster-e2e-'));

const serverEnv = {
  ROOSTER_BASE_URL: baseURL,
  ROOSTER_AUTH_SECRET: 'e2e-secret-e2e-secret-e2e-secret-e2e-secret',
  ROOSTER_ADMIN_EMAILS: e2eEnv.adminEmail,
  ROOSTER_ALLOWED_DOMAINS: e2eEnv.allowedDomain,
  ROOSTER_OIDC_PROVIDERS: JSON.stringify([
    {
      id: 'dev',
      name: 'Dev login',
      discoveryUrl: `${idpIssuer}/.well-known/openid-configuration`,
      clientId: 'rooster-dev',
      clientSecret: 'rooster-dev-secret',
    },
  ]),
  ROOSTER_DATA_DIR: process.env.ROOSTER_E2E_DATA_DIR,
  // Each browser context sends its own X-Forwarded-For (e2e/support/auth.ts), so the
  // per-IP sign-in rate limit applies per simulated client, as in production.
  ROOSTER_TRUST_PROXY: 'true',
  ROOSTER_BACKUP_CRON: 'off',
  ROOSTER_LOG_LEVEL: 'warn',
  PORT: String(apiPort),
};

/**
 * PWA specs (`*.pwa.spec.ts`, Phase 4) need a service worker, which `vite` dev does not serve:
 * they run against the production build (`vite build`) served by a second API server on its
 * own origin and data directory, exactly as in a deployment (strict CSP, SPA fallback, no
 * proxy in between).
 */
const pwaPort = 3182;
const pwaBaseURL = `http://localhost:${pwaPort}`;
const pwaDataDir = `${process.env.ROOSTER_E2E_DATA_DIR}-pwa`;
mkdirSync(pwaDataDir, { recursive: true });
const pwaServerEnv = {
  ...serverEnv,
  ROOSTER_BASE_URL: pwaBaseURL,
  ROOSTER_DATA_DIR: pwaDataDir,
  ROOSTER_WEB_DIR: resolve(import.meta.dirname, 'dist'),
  PORT: String(pwaPort),
};

export default defineConfig({
  testDir: 'e2e',
  globalTeardown: './e2e/support/teardown.ts',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  use: {
    baseURL,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
      testIgnore: [/perf\.spec\.ts$/, /\.pwa(-last)?\.spec\.ts$/, /\.mobile\.spec\.ts$/],
    },
    // Phones (02 §13, AC-4.5): iOS Safari (WebKit) and Android Chrome, touch and safe areas.
    { name: 'mobile', use: { ...devices['iPhone 15'] }, testMatch: /\.mobile\.spec\.ts$/ },
    {
      name: 'mobile-android',
      use: { ...devices['Pixel 8'] },
      testMatch: /\.mobile\.spec\.ts$/,
    },
    {
      name: 'pwa',
      use: { ...devices['Desktop Chrome'], baseURL: pwaBaseURL },
      testMatch: /\.pwa\.spec\.ts$/,
    },
    // AC-4.7 deploys a new sw.js into the served build: last and alone, so no other PWA test
    // sees the new version.
    {
      name: 'pwa-update',
      use: { ...devices['Desktop Chrome'], baseURL: pwaBaseURL },
      testMatch: /\.pwa-last\.spec\.ts$/,
      dependencies: ['pwa'],
      fullyParallel: false,
    },
    // Timing budgets (AC-2.12) run last and alone, so other workers do not skew them.
    {
      name: 'perf',
      use: { ...devices['Desktop Chrome'] },
      testMatch: /perf\.spec\.ts$/,
      dependencies: ['chromium'],
      fullyParallel: false,
    },
  ],
  webServer: [
    {
      command: 'node scripts/dev-idp.mjs',
      cwd: '../..',
      url: `${idpIssuer}/.well-known/openid-configuration`,
      env: { DEV_IDP_PORT: String(idpPort) },
      reuseExistingServer: !process.env.CI,
      timeout: 60_000,
    },
    {
      command: `node ../web/e2e/support/wait-for.mjs ${idpIssuer}/.well-known/openid-configuration && pnpm exec tsx src/main.ts`,
      cwd: '../server',
      url: `http://localhost:${apiPort}/readyz`,
      env: serverEnv,
      // Always a fresh server: tests assume a clean data directory and this env.
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      command: `pnpm -C ../web exec vite build --logLevel warn && node ../web/e2e/support/wait-for.mjs ${idpIssuer}/.well-known/openid-configuration && pnpm exec tsx src/main.ts`,
      cwd: '../server',
      url: `${pwaBaseURL}/readyz`,
      env: pwaServerEnv,
      reuseExistingServer: false,
      timeout: 240_000,
    },
    {
      command: `pnpm exec vite --port ${webPort} --strictPort`,
      url: baseURL,
      env: { ROOSTER_API_TARGET: `http://localhost:${apiPort}` },
      // Not reused: a dev Vite on this port would proxy to the wrong API server.
      reuseExistingServer: false,
      timeout: 60_000,
    },
  ],
});
