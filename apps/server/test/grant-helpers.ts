// Shared helpers for the grant tests (WP 8.2): bearer requests, PATs and the device flow.
import { defaultKeyHasher } from '@better-auth/api-key';
import type { GrantConstraints, GrantScope } from '@rooster/core/grants';
import type { Grant, Me, TokenCreated } from '@rooster/core/schemas';
import { expect } from 'vitest';
import type { Actor } from '../src/services/index.ts';
import type { Caller, ListCtx } from './list-helpers.ts';

export const ALL: GrantScope[] = [
  'tasks:read',
  'tasks:write',
  'comments:write',
  'tasks:assign',
  'groups:write',
  'tasks:delete',
  'notifications:read',
];

/** A request with `Authorization: Bearer <token>` (no cookie, no Origin: not a browser). */
export function bearer(ctx: ListCtx, token: string) {
  const call = (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) =>
    ctx.app.request(path, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  const ok = async <T>(method: string, path: string, body?: unknown, status = 200): Promise<T> => {
    const res = await call(method, path, body);
    const text = await res.text();
    expect(res.status, `${method} ${path}: ${text}`).toBe(status);
    return (text === '' ? undefined : JSON.parse(text)) as T;
  };
  const problem = async (method: string, path: string, body: unknown, status: number) => {
    const res = await call(method, path, body);
    expect(res.status, await res.clone().text()).toBe(status);
    return (await res.json()) as { code: string; detail: string };
  };
  return { call, ok, problem };
}

export async function pat(
  owner: Caller,
  scopes: GrantScope[],
  constraints: GrantConstraints = { orgs: 'all' },
  extra: { expiresInDays?: number } = {},
): Promise<TokenCreated> {
  return owner.ok<TokenCreated>(
    'POST',
    '/api/v1/me/tokens',
    { name: 'Script', scopes, constraints, ...extra },
    201,
  );
}

export async function personalOrgId(c: Caller): Promise<string> {
  const me = await c.ok<Me>('GET', '/api/v1/me');
  const org = me.orgs.find((o) => o.isPersonal);
  if (org === undefined) throw new Error('no personal org');
  return org.id;
}

/** The CLI side of RFC 8628: request a code, then poll. */
export async function deviceCode(
  ctx: ListCtx,
  scope?: string,
  userAgent = 'rooster-cli/1.0.0 (linux; x64; laptop)',
) {
  const res = await ctx.app.request('/api/auth/device/code', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'user-agent': userAgent },
    body: JSON.stringify({ client_id: 'rooster-cli', ...(scope === undefined ? {} : { scope }) }),
  });
  expect(res.status, await res.clone().text()).toBe(200);
  return (await res.json()) as {
    device_code: string;
    user_code: string;
    verification_uri: string;
    verification_uri_complete: string;
    expires_in: number;
    interval: number;
  };
}

export async function pollToken(ctx: ListCtx, code: string) {
  const res = await ctx.app.request('/api/auth/device/token', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
      device_code: code,
      client_id: 'rooster-cli',
    }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, string> };
}

/** The decision nonce `/device` shows this caller for a pending code (as the page loads it). */
export async function deviceNonce(caller: Caller, userCode: string): Promise<string> {
  return (await caller.ok<{ decisionNonce: string }>('GET', `/api/v1/device/${userCode}`))
    .decisionNonce;
}

/** Logs a CLI device in with the given approval; returns the bearer token and the grant. */
export async function deviceLogin(
  ctx: ListCtx,
  owner: Caller,
  approval: { scopes: GrantScope[]; constraints: GrantConstraints; label?: string },
) {
  const code = await deviceCode(ctx, ALL.join(' '));
  const decisionNonce = await deviceNonce(owner, code.user_code);
  const grant = await owner.ok<Grant>('POST', `/api/v1/device/${code.user_code}/approve`, {
    ...approval,
    decisionNonce,
  });
  // The plugin enforces the 5 s polling interval only after a first poll.
  const token = await pollToken(ctx, code.device_code);
  expect(token.status, JSON.stringify(token.body)).toBe(200);
  return { token: token.body.access_token as string, grant, scope: token.body.scope };
}

/** The actor a PAT resolves to. */
export async function actorOf(ctx: ListCtx, token: string) {
  const actor = ctx.app.services.grants.resolvePat(await defaultKeyHasher(token), null);
  if (actor === null) throw new Error('no actor');
  return actor;
}

/** An SSE stream of a grant actor on the hub, discarding what it receives. */
export function openStream(ctx: ListCtx, actor: Actor): { close(): void } {
  const handle = ctx.app.hub.open({
    userId: actor.userId,
    ...ctx.app.services.grants.streamAccess(actor),
    sink: { write: () => {}, close: () => {} },
  });
  if (handle === null) throw new Error('hub closed');
  return handle;
}
