// WP 9.6 (server): the `admin` capability (ADR 0041 §7, ADR 0042 §1) and linked identities
// (FR-SET-3). AC-9.6.

import { uuidv7 } from '@rooster/core/ids';
import type { Grant, LinkedIdentity } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { accessGrant, account, user as userTable } from '../src/db/schema/index.ts';
import { bearer, deviceCode, pat, pollToken } from './grant-helpers.ts';
import { tempDir } from './helpers.ts';
import { type Caller, type ListCtx, listCtx } from './list-helpers.ts';

/** Every admin route (routes/admin.ts), as a request that succeeds for an admin. */
const ADMIN_ROUTES: [string, string, unknown?][] = [
  ['GET', '/api/v1/admin/allowlist'],
  ['POST', '/api/v1/admin/allowlist', { kind: 'domain', value: 'new.example' }],
  ['GET', '/api/v1/admin/users'],
  ['GET', '/api/v1/admin/backups'],
  ['GET', '/api/v1/admin/system'],
  ['POST', '/api/v1/admin/backups'],
  ['POST', '/api/v1/admin/search/reindex'],
];

function adminCtx(): ListCtx {
  const dir = tempDir();
  return listCtx({ env: { ROOSTER_DATA_DIR: dir.path } });
}

async function statuses(ctx: ListCtx, token: string): Promise<number[]> {
  const api = bearer(ctx, token);
  const out: number[] = [];
  for (const [method, path, body] of ADMIN_ROUTES) {
    out.push((await api.call(method, path, body)).status);
  }
  return out;
}

const all = (status: number) => ADMIN_ROUTES.map(() => status);

describe('AC-9.6 the admin capability', () => {
  it('AC-9.6 an admin PAT reaches every admin route, including POST /admin/search/reindex', async () => {
    const ctx = adminCtx();
    const admin = ctx.user('admin@example.com');
    const { token, grant } = await pat(admin, ['admin']);
    expect(grant.scopes).toEqual(['admin']);
    expect(await statuses(ctx, token)).toEqual([200, 201, 200, 200, 200, 201, 200]);
    const reindex = await bearer(ctx, token).ok<{ indexed: number }>(
      'POST',
      '/api/v1/admin/search/reindex',
    );
    expect(typeof reindex.indexed).toBe('number');
  });

  it('without the capability, or for an admin no longer, the admin routes are 403', async () => {
    const ctx = adminCtx();
    const admin = ctx.user('admin@example.com');
    const plain = await pat(admin, ['tasks:read']);
    for (const status of await statuses(ctx, plain.token)) expect(status).toBe(403);
    const withAdmin = await pat(admin, ['admin', 'tasks:read']);
    // The role is checked on every request: an admin whose email is no longer verified (or no
    // longer listed) loses admin access at once.
    ctx.db.orm
      .update(userTable)
      .set({ emailVerified: false })
      .where(eq(userTable.id, admin.userId))
      .run();
    expect(await statuses(ctx, withAdmin.token)).toEqual(all(403));
    const res = await bearer(ctx, withAdmin.token).call('POST', '/api/v1/admin/search/reindex');
    expect(((await res.json()) as { code: string }).code).toBe('forbidden');
  });

  it('a non-admin cannot create an admin PAT (403 admin_only_scope), nor patch admin in', async () => {
    const ctx = adminCtx();
    const ada = ctx.user('ada@example.com');
    const res = await ada.call('POST', '/api/v1/me/tokens', {
      name: 'x',
      scopes: ['admin'],
      constraints: { orgs: 'all' },
    });
    expect(res.status).toBe(403);
    expect(((await res.json()) as { code: string }).code).toBe('admin_only_scope');
    const plain = await pat(ada, ['tasks:read']);
    const patch = await ada.call('PATCH', `/api/v1/me/grants/${plain.grant.id}`, {
      scopes: ['tasks:read', 'admin'],
    });
    expect(patch.status).toBe(403);
    expect(((await patch.json()) as { code: string }).code).toBe('admin_only_scope');
    // Even a grant row that says admin gives a non-admin nothing.
    ctx.db.orm
      .update(accessGrant)
      .set({ scopes: 'admin tasks:read' })
      .where(eq(accessGrant.id, plain.grant.id))
      .run();
    expect(await statuses(ctx, plain.token)).toEqual(all(403));
  });

  it('device approval keeps admin for admins and drops it silently for everyone else', async () => {
    const ctx = adminCtx();
    const admin = ctx.user('admin@example.com');
    const ada = ctx.user('ada@example.com');
    const asked = await deviceCode(ctx, 'tasks:read admin');
    const shown = await ada.ok<{ requestedScopes: string[] }>(
      'GET',
      `/api/v1/device/${asked.user_code}`,
    );
    expect(shown.requestedScopes).toEqual(['tasks:read']);
    const approved = await ada.ok<Grant>('POST', `/api/v1/device/${asked.user_code}/approve`, {
      scopes: ['tasks:read', 'admin'],
      constraints: { orgs: 'all' },
    });
    expect(approved.scopes).toEqual(['tasks:read']);

    const forAdmin = await deviceCode(ctx, 'tasks:read admin');
    const adminShown = await admin.ok<{ requestedScopes: string[] }>(
      'GET',
      `/api/v1/device/${forAdmin.user_code}`,
    );
    expect(adminShown.requestedScopes).toEqual(['tasks:read', 'admin']);
    const grant = await admin.ok<Grant>('POST', `/api/v1/device/${forAdmin.user_code}/approve`, {
      scopes: ['tasks:read', 'admin'],
      constraints: { orgs: 'all' },
    });
    expect(grant.scopes).toEqual(['tasks:read', 'admin']);
    const polled = await pollToken(ctx, forAdmin.device_code);
    expect(polled.status).toBe(200);
    const device = { token: polled.body.access_token as string };
    const reindex = await bearer(ctx, device.token).call('POST', '/api/v1/admin/search/reindex');
    expect(reindex.status).toBe(200);
    // A device with admin may mint an admin PAT; one without may not.
    const minted = await bearer(ctx, device.token).call('POST', '/api/v1/me/tokens', {
      name: 'Admin script',
      scopes: ['admin'],
      constraints: { orgs: 'all' },
    });
    expect(minted.status).toBe(201);
  });

  it('an OAuth grant never reaches the admin routes, whatever its row says', async () => {
    const ctx = adminCtx();
    const admin = ctx.user('admin@example.com');
    const { token, grant } = await pat(admin, ['admin']);
    ctx.db.orm
      .update(accessGrant)
      .set({ kind: 'oauth', clientId: 'https://app.example.com/client.json' })
      .where(eq(accessGrant.id, grant.id))
      .run();
    // A PAT whose grant became an app grant is refused outright (kind mismatch).
    expect((await bearer(ctx, token).call('GET', '/api/v1/me')).status).toBe(401);
  });
});

function identity(ctx: ListCtx, owner: Caller, providerId: string, email?: string): string {
  const id = uuidv7();
  const payload = Buffer.from(JSON.stringify({ email })).toString('base64url');
  ctx.db.orm
    .insert(account)
    .values({
      id,
      accountId: `${providerId}-${owner.userId}`,
      providerId,
      userId: owner.userId,
      idToken: email === undefined ? null : `e30.${payload}.sig`,
      createdAt: new Date(),
      updatedAt: new Date(),
    })
    .run();
  return id;
}

describe('AC-9.6 linked identities (FR-SET-3)', () => {
  it('AC-9.6 lists the identities and unlinks one, never the last', async () => {
    const ctx = listCtx();
    const ada = ctx.user('ada@example.com');
    const google = identity(ctx, ada, 'google', 'ada@gmail.example');
    const other = identity(ctx, ada, 'corp');
    const list = await ada.ok<LinkedIdentity[]>('GET', '/api/v1/me/identities');
    expect(list.map((i) => [i.id, i.providerId, i.providerName, i.email])).toEqual([
      [google, 'google', 'Google', 'ada@gmail.example'],
      [other, 'corp', 'corp', null],
    ]);
    await ada.ok('DELETE', `/api/v1/me/identities/${other}`, undefined, 204);
    const last = await ada.call('DELETE', `/api/v1/me/identities/${google}`);
    expect(last.status).toBe(409);
    expect(((await last.json()) as { code: string }).code).toBe('last_identity');
    expect(await ada.ok<LinkedIdentity[]>('GET', '/api/v1/me/identities')).toHaveLength(1);
  });

  it('another user’s identity and an unknown id are 404; tokens get 403', async () => {
    const ctx = listCtx();
    const ada = ctx.user('ada@example.com');
    const bob = ctx.user('bob@example.com');
    const bobs = identity(ctx, bob, 'google');
    identity(ctx, bob, 'corp');
    identity(ctx, ada, 'google');
    identity(ctx, ada, 'corp');
    expect((await ada.call('DELETE', `/api/v1/me/identities/${bobs}`)).status).toBe(404);
    expect((await ada.call('DELETE', `/api/v1/me/identities/${uuidv7()}`)).status).toBe(404);
    const { token } = await pat(ada, ['tasks:read']);
    expect((await bearer(ctx, token).call('GET', '/api/v1/me/identities')).status).toBe(403);
    expect((await bob.ok<LinkedIdentity[]>('GET', '/api/v1/me/identities')).length).toBe(2);
  });
});
