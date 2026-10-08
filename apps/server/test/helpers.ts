import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { uuidv7 } from '@rooster/core/ids';
import type { Locale } from '@rooster/i18n';
import { type App, type AppDeps, createApp } from '../src/app.ts';
import { SESSION_COOKIE } from '../src/auth/cookies.ts';
import { type Config, parseConfig } from '../src/config.ts';
import { type AppDb, openDb } from '../src/db/client.ts';
import { runMigrations } from '../src/db/migrate.ts';
import { session, user } from '../src/db/schema/index.ts';
import { createLogger, type Logger } from '../src/lib/logger.ts';
import { randomToken, signCookieValue } from '../src/lib/tokens.ts';
import type { MockIdp } from './mock-idp.ts';

export const BASE_URL = 'http://localhost:3000';

export const TEST_ENV = {
  ROOSTER_BASE_URL: BASE_URL,
  ROOSTER_AUTH_SECRET: 'test-secret-0123456789-abcdefghijklmnop-QRSTUV',
  ROOSTER_ADMIN_EMAILS: 'admin@example.com',
  // Phase 1 requires a sign-in provider; Google needs no network at boot.
  ROOSTER_GOOGLE_CLIENT_ID: 'test-google-client',
  ROOSTER_GOOGLE_CLIENT_SECRET: 'test-google-secret',
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

/** Env for an app that signs in through the mock IdP (provider id `dev`). */
export function idpEnv(idp: MockIdp): Record<string, string> {
  return { ROOSTER_OIDC_PROVIDERS: JSON.stringify([idp.provider()]) };
}

export function createTestApp(
  options: {
    env?: Record<string, string>;
    db?: AppDb;
    logger?: Logger;
    clock?: () => number;
    apiRateLimit?: AppDeps['apiRateLimit'];
    sse?: AppDeps['sse'];
  } = {},
): { app: App; db: AppDb; config: Config } {
  const config = testConfig({ ROOSTER_WEB_DIR: '/nonexistent/web', ...options.env });
  const db = options.db ?? createTestDb();
  const logger = options.logger ?? createLogger('silent');
  const app = createApp({
    config,
    db,
    logger,
    version: '0.0.0-test',
    authRateLimit: false,
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.apiRateLimit === undefined ? {} : { apiRateLimit: options.apiRateLimit }),
    ...(options.sse === undefined ? {} : { sse: options.sse }),
  });
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

/** A minimal browser cookie store: name → value, fed from `Set-Cookie` headers. */
export class CookieJar {
  private readonly cookies = new Map<string, string>();

  update(res: Response): this {
    for (const line of res.headers.getSetCookie()) {
      const [pair = ''] = line.split(';');
      const eq = pair.indexOf('=');
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      const expired = /max-age=0\b/i.test(line) || value === '';
      if (expired) this.cookies.delete(name);
      else this.cookies.set(name, value);
    }
    return this;
  }

  get(name: string): string | undefined {
    return this.cookies.get(name);
  }

  set(name: string, value: string): void {
    this.cookies.set(name, value);
  }

  header(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; ');
  }
}

export interface SignInResult {
  jar: CookieJar;
  /** Where the OAuth callback redirected the browser. */
  location: string;
}

/**
 * The real sign-in flow through better-auth and the mock IdP: start social sign-in, follow
 * the redirect to the issuer's authorize endpoint, then complete the callback. The returned
 * jar carries `rooster.session` when sign-in succeeded.
 */
export async function signInAs(
  app: App,
  email: string,
  options: {
    jar?: CookieJar;
    acceptLanguage?: string;
    emailVerified?: boolean;
    idp?: MockIdp;
    /** The configured provider id to sign in with; default `dev`. */
    provider?: string;
    /** The app's origin, when it is not `BASE_URL`. */
    origin?: string;
  } = {},
): Promise<SignInResult> {
  const jar = options.jar ?? new CookieJar();
  if (options.emailVerified !== undefined) {
    if (options.idp === undefined) throw new Error('signInAs: emailVerified needs the idp');
    options.idp.setNextUser({ email, emailVerified: options.emailVerified });
  }
  const start = await app.request('/api/auth/sign-in/social', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      origin: options.origin ?? BASE_URL,
      cookie: jar.header(),
    },
    body: JSON.stringify({
      provider: options.provider ?? 'dev',
      callbackURL: '/',
      errorCallbackURL: '/login',
      // Without a hint the mock IdP uses its "next user".
      ...(options.emailVerified === undefined ? { loginHint: email } : {}),
    }),
  });
  if (start.status !== 200) throw new Error(`sign-in start: ${start.status} ${await start.text()}`);
  jar.update(start);
  const { url } = (await start.json()) as { url: string };
  const authorize = await fetch(url, { redirect: 'manual' });
  const callback = authorize.headers.get('location');
  if (callback === null) throw new Error(`authorize: ${authorize.status} without a redirect`);
  const target = new URL(callback);
  const done = await app.request(`${target.pathname}${target.search}`, {
    headers: {
      cookie: jar.header(),
      ...(options.acceptLanguage === undefined
        ? {}
        : { 'accept-language': options.acceptLanguage }),
    },
  });
  jar.update(done);
  return { jar, location: done.headers.get('location') ?? '' };
}

/** Headers for an API request as the holder of `jar` (cookie auth, same origin). */
export function asJar(jar: CookieJar, init: RequestInit = {}): RequestInit {
  const headers = new Headers(init.headers);
  headers.set('cookie', jar.header());
  headers.set('origin', BASE_URL);
  if (init.body !== undefined && !headers.has('content-type')) {
    headers.set('content-type', 'application/json');
  }
  return { ...init, headers };
}

/** JSON request init. */
export function jsonBody(method: string, body: unknown): RequestInit {
  return { method, body: JSON.stringify(body), headers: { 'content-type': 'application/json' } };
}

/** Inserts a verified user row (no personal org); returns its ID. */
export function insertUser(
  db: AppDb,
  input: { email: string; name?: string; locale?: Locale },
): string {
  const now = Date.now();
  const userId = uuidv7();
  db.orm
    .insert(user)
    .values({
      id: userId,
      name: input.name ?? input.email.split('@')[0] ?? 'user',
      email: input.email,
      emailVerified: true,
      createdAt: new Date(now),
      updatedAt: new Date(now),
      locale: input.locale ?? 'en',
    })
    .run();
  return userId;
}

/**
 * A user with a personal org and a live session, created directly in the database (fast
 * path for table-driven tests; `signInAs` covers the real flow).
 */
export function createUserWithSession(
  app: App,
  db: AppDb,
  input: { email: string; name?: string; locale?: Locale },
): { userId: string; sessionId: string; jar: CookieJar } {
  const userId = insertUser(db, input);
  app.services.orgs.bootstrapPersonalOrg(userId, input.locale ?? 'en');
  const jar = new CookieJar();
  const sessionId = addSession(db, userId, jar, TEST_ENV.ROOSTER_AUTH_SECRET);
  return { userId, sessionId, jar };
}

/** Inserts a session for the user and stores its signed cookie in `jar`. */
export function addSession(db: AppDb, userId: string, jar: CookieJar, secret: string): string {
  const now = Date.now();
  const id = uuidv7();
  const token = randomToken();
  db.orm
    .insert(session)
    .values({
      id,
      token,
      userId,
      expiresAt: new Date(now + 30 * 86_400_000),
      createdAt: new Date(now),
      updatedAt: new Date(now),
      ipAddress: '',
      userAgent: 'vitest',
    })
    .run();
  jar.set(SESSION_COOKIE, signCookieValue(secret, token));
  return id;
}
