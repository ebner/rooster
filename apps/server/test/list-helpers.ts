import type { Group, MyList, Org, Task } from '@rooster/core/schemas';
import { expect } from 'vitest';
import type { App, AppDeps } from '../src/app.ts';
import type { AppDb } from '../src/db/client.ts';
import type { Actor } from '../src/services/index.ts';
import type { FakeMail, FakePush } from './delivery-fakes.ts';
import {
  addSession,
  asJar,
  CookieJar,
  createTestApp,
  createUserWithSession,
  TEST_ENV,
} from './helpers.ts';

export interface Caller {
  userId: string;
  jar: CookieJar;
  actor: Actor;
  /** An API request as this user; `headers` adds e.g. Idempotency-Key or X-Rooster-Edit-Time. */
  call(
    method: string,
    path: string,
    body?: unknown,
    headers?: Record<string, string>,
  ): Promise<Response>;
  /** Like `call`, asserting the status and returning the parsed JSON body. */
  ok<T>(
    method: string,
    path: string,
    body?: unknown,
    status?: number,
    headers?: Record<string, string>,
  ): Promise<T>;
}

export interface ListCtx {
  app: App;
  db: AppDb;
  push: FakePush;
  mail: FakeMail;
  /** A signed-in user with a personal org (default groups: Today, Prio, Upcoming). */
  user(email: string, name?: string): Caller;
  /** A new session for a user already in the database (e.g. from a fixture). */
  signedIn(userId: string): Caller;
}

export function listCtx(
  options: {
    clock?: () => number;
    env?: Record<string, string>;
    apiRateLimit?: AppDeps['apiRateLimit'];
    sse?: AppDeps['sse'];
    db?: AppDb;
    cimdFetch?: AppDeps['cimdFetch'];
  } = {},
): ListCtx {
  const { app, db, push, mail } = createTestApp({
    ...(options.db === undefined ? {} : { db: options.db }),
    ...(options.clock === undefined ? {} : { clock: options.clock }),
    ...(options.env === undefined ? {} : { env: options.env }),
    ...(options.sse === undefined ? {} : { sse: options.sse }),
    ...(options.cimdFetch === undefined ? {} : { cimdFetch: options.cimdFetch }),
    apiRateLimit: options.apiRateLimit ?? false,
  });
  const user = (email: string, name?: string): Caller =>
    callerFor(createUserWithSession(app, db, { email, ...(name === undefined ? {} : { name }) }));
  const signedIn = (userId: string): Caller => {
    const jar = new CookieJar();
    const sessionId = addSession(db, userId, jar, TEST_ENV.ROOSTER_AUTH_SECRET);
    return callerFor({ userId, sessionId, jar });
  };
  const callerFor = (u: { userId: string; sessionId: string; jar: CookieJar }): Caller => {
    const actor = app.services.users.resolveActor(u.userId, u.sessionId);
    if (actor === null) throw new Error('actor');
    const call = async (
      method: string,
      path: string,
      body?: unknown,
      headers?: Record<string, string>,
    ): Promise<Response> =>
      app.request(
        path,
        asJar(u.jar, {
          method,
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          ...(headers === undefined ? {} : { headers }),
        }),
      );
    const ok = async <T>(
      method: string,
      path: string,
      body?: unknown,
      status = 200,
      headers?: Record<string, string>,
    ): Promise<T> => {
      const res = await call(method, path, body, headers);
      const text = await res.text();
      expect(res.status, `${method} ${path}: ${text}`).toBe(status);
      return (text === '' ? undefined : JSON.parse(text)) as T;
    };
    return { userId: u.userId, jar: u.jar, actor, call, ok };
  };
  return { app, db, push, mail, user, signedIn };
}

export const myList = (c: Caller, org = 'personal', query = '') =>
  c.ok<MyList>('GET', `/api/v1/orgs/${org}/my-list${query}`);

export async function groupsOf(c: Caller, org = 'personal'): Promise<Group[]> {
  return (await myList(c, org)).groups;
}

/** The normal group with this name. */
export async function groupNamed(c: Caller, name: string, org = 'personal'): Promise<Group> {
  const group = (await groupsOf(c, org)).find((g) => g.name === name);
  if (group === undefined) throw new Error(`no group ${name}`);
  return group;
}

export async function inboxOf(c: Caller, org = 'personal'): Promise<Group> {
  const group = (await groupsOf(c, org)).find((g) => g.kind === 'inbox');
  if (group === undefined) throw new Error('no inbox');
  return group;
}

export const createTask = (c: Caller, body: Record<string, unknown>, org = 'personal') =>
  c.ok<Task>('POST', `/api/v1/orgs/${org}/tasks`, body, 201);

/** Titles of the live tasks in a group of my list, in list order (`ORDER BY position, id`). */
export async function titlesIn(c: Caller, groupId: string, org = 'personal'): Promise<string[]> {
  const list = await myList(c, org);
  return list.tasks
    .filter((t) => t.placement?.groupId === groupId)
    .sort((a, b) => {
      const pa = a.placement?.position ?? '';
      const pb = b.placement?.position ?? '';
      return pa < pb ? -1 : pa > pb ? 1 : a.id < b.id ? -1 : 1;
    })
    .map((t) => t.title);
}

export async function sharedOrg(owner: Caller, members: Caller[], name = 'Shared'): Promise<Org> {
  const org = await owner.ok<Org>('POST', '/api/v1/orgs', { name }, 201);
  for (const m of members) {
    const { url } = await owner.ok<{ url: string }>(
      'POST',
      `/api/v1/orgs/${org.id}/invites`,
      { role: 'member' },
      201,
    );
    await m.ok('POST', `/api/v1/invites/${url.split('/invite/')[1]}/accept`);
  }
  return org;
}

export const meta = (editTime = Date.now()) => ({ editTime, clientId: null, client: null });
