// WP 11.1 (10 §6): "problem+json never contains stacks". Every kind of failure an API client
// can provoke answers with the documented problem members only: no stack frames, no SQL, no
// bound parameters, no exception messages. The other 10 §6 checks live next to the feature
// they guard (docs/security/asvs.md lists them).

import { describe, expect, it } from 'vitest';
import { task } from '../src/db/schema/index.ts';
import { BASE_URL, captureLogger, createTestApp } from './helpers.ts';
import { createTask, listCtx } from './list-helpers.ts';

const PROBLEM_KEYS = new Set([
  'type',
  'title',
  'status',
  'detail',
  'code',
  'errors',
  'existingId',
  'candidates',
  'limitBytes',
  'usedBytes',
]);

/** Fails if the body carries anything a stack, a query or an exception message would. */
function expectCleanProblem(text: string, secrets: string[] = []) {
  expect(text).not.toMatch(/\bat [\w.<>]+ \(|\.ts:\d+|\.js:\d+|node:internal/);
  expect(text).not.toMatch(/stack|SQLITE_|Failed query|params:|INSERT INTO|SELECT /i);
  for (const s of secrets) expect(text).not.toContain(s);
  const body = JSON.parse(text) as Record<string, unknown>;
  for (const key of Object.keys(body)) expect(PROBLEM_KEYS.has(key), key).toBe(true);
}

describe('10 §6 problem+json never contains stacks', () => {
  it('an unexpected error and a database error', async () => {
    const { logger, lines } = captureLogger();
    const { app, db } = createTestApp({ logger });
    app.get('/api/_test/throw', () => {
      throw new Error('internal detail /opt/app/secret.ts:12');
    });
    app.get('/api/_test/sql', () => {
      // A constraint violation from SQLite, with the bound user content in Drizzle's message.
      db.orm
        .insert(task)
        .values({
          id: 'x',
          orgId: 'no-such-org',
          title: 'Private title 4711',
          createdBy: 'nobody',
          createdAt: 0,
          updatedAt: 0,
        })
        .run();
      return new Response('unreachable');
    });
    for (const path of ['/api/_test/throw', '/api/_test/sql']) {
      const res = await app.request(path);
      expect(res.status, path).toBe(500);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      expectCleanProblem(await res.text(), ['secret', '4711', 'no-such-org']);
    }
    // The log keeps the stack for the operator, without the parameters.
    const logged = JSON.stringify(lines.filter((l) => l.msg === 'unhandled error'));
    expect(logged).toContain('stack');
    expect(logged).not.toContain('Private title 4711');
  });

  it('validation, malformed JSON, unknown routes and domain errors', async () => {
    const ctx = listCtx();
    const ann = ctx.user('ann@example.com');
    const t = await createTask(ann, { title: 'Mine' });
    const cases: [string, string, string | undefined, number][] = [
      ['POST', '/api/v1/orgs/personal/tasks', JSON.stringify({ title: '' }), 422],
      ['POST', '/api/v1/orgs/personal/tasks', '{"title": "unterminated', 400],
      ['PATCH', `/api/v1/tasks/${t.id}`, JSON.stringify({ dueDate: 'not-a-date' }), 422],
      ['GET', '/api/v1/tasks/0199c5a1-4e5f-7d60-b172-8d9e0a1b2c99', undefined, 404],
      ['GET', '/api/v1/no/such/route', undefined, 404],
      ['POST', `/api/v1/tasks/${t.id}/move`, JSON.stringify({ groupId: 'nope' }), 404],
    ];
    for (const [method, path, body, status] of cases) {
      const res = await ctx.app.request(path, {
        method,
        headers: {
          cookie: ann.jar.header(),
          origin: BASE_URL,
          'content-type': 'application/json',
        },
        ...(body === undefined ? {} : { body }),
      });
      const text = await res.text();
      expect([status, 422], `${method} ${path}: ${text}`).toContain(res.status);
      expect(res.headers.get('content-type')).toBe('application/problem+json');
      expectCleanProblem(text);
    }
  });

  it('errors from the sign-in endpoints carry no stack either', async () => {
    const { app } = createTestApp();
    const res = await app.request('/api/auth/sign-in/social', {
      method: 'POST',
      headers: { 'content-type': 'application/json', origin: BASE_URL },
      body: JSON.stringify({ provider: 'no-such-provider', callbackURL: '/' }),
    });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const text = await res.text();
    expect(text).not.toMatch(/\bat [\w.<>]+ \(|\.ts:\d+|\.js:\d+|node:internal|"stack"/);
  });
});

describe('ASVS 8.2.1 API responses are not cached', () => {
  it('JSON and problem responses are no-store; downloads keep their own policy', async () => {
    const ctx = listCtx();
    const ann = ctx.user('ann@example.com');
    for (const path of ['/api/v1/me', '/api/v1/orgs/personal/my-list', '/api/v1/no/such/route']) {
      const res = await ann.call('GET', path);
      expect(res.headers.get('cache-control'), path).toBe('no-store');
    }
    const anonymous = await ctx.app.request('/api/v1/me');
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('cache-control')).toBe('no-store');
  });
});
