import type { Grant, GrantConstraintsValue, GrantScopeValue } from '@rooster/core/schemas';
import { serveFetch } from './server.ts';

/**
 * A real rooster server, in process: the server's own test helpers (`createTestApp`,
 * `createUserWithSession`) behind an HTTP port. The helpers are imported by a computed path so
 * the CLI's typecheck does not pull in the server's sources.
 */
const HELPERS = '../../../server/test/helpers.ts';

interface CookieJar {
  header(): string;
}
interface ServerApp {
  fetch(request: Request): Response | Promise<Response>;
}
interface Helpers {
  BASE_URL: string;
  createTestApp(options?: { env?: Record<string, string>; deviceIntervalSec?: number }): {
    app: ServerApp;
    db: unknown;
  };
  createUserWithSession(
    app: ServerApp,
    db: unknown,
    input: { email: string; name?: string },
  ): { userId: string; jar: CookieJar };
}

export interface TestUser {
  userId: string;
  email: string;
  /** Browser-session API call (cookie + Origin), as the web app would make it. */
  api<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; data: T }>;
  /** A PAT minted through `POST /me/tokens`, like Settings → Connected apps → New token. */
  token(options?: {
    scopes?: GrantScopeValue[];
    constraints?: GrantConstraintsValue;
    name?: string;
  }): Promise<{ token: string; grant: Grant }>;
}

export interface RoosterServer {
  url: string;
  user(email: string, name?: string): Promise<TestUser>;
  close(): Promise<void>;
}

export interface StartOptions {
  /** Server env, e.g. `ROOSTER_OAUTH_DEVICE: 'off'` (11 §9.1). */
  env?: Record<string, string>;
  /**
   * The device grant's polling interval (seconds). Tests poll in real time, since the server
   * answers `slow_down` to early polls, so it is short by default.
   */
  deviceIntervalSec?: number;
}

export async function startServer(options: StartOptions = {}): Promise<RoosterServer> {
  const helpers = (await import(
    /* @vite-ignore */ new URL(HELPERS, import.meta.url).href
  )) as Helpers;
  const { app, db } = helpers.createTestApp({
    ...(options.env === undefined ? {} : { env: options.env }),
    deviceIntervalSec: options.deviceIntervalSec ?? 1,
  });
  const served = await serveFetch((request) => app.fetch(request));
  return {
    url: served.url,
    close: served.close,
    async user(email, name) {
      const { userId, jar } = helpers.createUserWithSession(app, db, {
        email,
        ...(name === undefined ? {} : { name }),
      });
      const api = async <T>(method: string, path: string, body?: unknown) => {
        const response = await fetch(`${served.url}${path}`, {
          method,
          headers: {
            cookie: jar.header(),
            origin: helpers.BASE_URL,
            ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await response.text();
        return { status: response.status, data: (text === '' ? null : JSON.parse(text)) as T };
      };
      return {
        userId,
        email,
        api,
        async token(options = {}) {
          const { status, data } = await api<{ token: string; grant: Grant }>(
            'POST',
            '/api/v1/me/tokens',
            {
              name: options.name ?? 'test',
              scopes: options.scopes ?? ['tasks:read'],
              constraints: options.constraints ?? { orgs: 'all' },
            },
          );
          if (status !== 201) throw new Error(`token: ${status} ${JSON.stringify(data)}`);
          return data;
        },
      };
    },
  };
}
