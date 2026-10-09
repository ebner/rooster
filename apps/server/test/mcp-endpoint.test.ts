// The remote MCP endpoint (WP 9.4, 11 §5.2, ADR 0042): auth challenges, scope step-up, grant
// constraints, revocation, rate limits and transport rules. Tokens come from `FakeOAuth`
// (mcp-helpers.ts) until the OAuth provider lands; see mcp-oauth.test.ts for the real flow.
import type { CallToolResult } from '@modelcontextprotocol/client';
import { TOOL_NAMES } from '@rooster/mcp';
import { describe, expect, it } from 'vitest';
import { MCP_TOOL_CALL_LIMIT } from '../src/mcp/route.ts';
import { personalOrgId } from './grant-helpers.ts';
import { BASE_URL } from './helpers.ts';
import { groupNamed, inboxOf, listCtx, titlesIn } from './list-helpers.ts';
import {
  challenge,
  FakeOAuth,
  MCP_URL,
  mcpClient,
  RESOURCE_METADATA_URL,
  rpc,
} from './mcp-helpers.ts';

// `WWW-Authenticate: Bearer …` parameters (their order carries no meaning, RFC 9110 §11.6.1).
const CHALLENGE_READ = { resource_metadata: RESOURCE_METADATA_URL, scope: 'tasks:read' };
const INVALID_TOKEN = { error: 'invalid_token', ...CHALLENGE_READ };
const insufficient = (scope: string) => ({
  error: 'insufficient_scope',
  resource_metadata: RESOURCE_METADATA_URL,
  scope,
});

/** A 2025-era `tools/call` (no envelope), the shape most clients still send. */
const call = (name: string, args: Record<string, unknown> = {}, id: number | string = 1) => ({
  jsonrpc: '2.0',
  id,
  method: 'tools/call',
  params: { name, arguments: args },
});

function setup(options: { clock?: () => number } = {}) {
  const ctx = listCtx(options.clock === undefined ? {} : { clock: options.clock });
  const alice = ctx.user('alice@example.com', 'Alice');
  const oauth = new FakeOAuth(ctx.app);
  return { ctx, alice, oauth, app: ctx.app };
}

function text(result: CallToolResult): string {
  return result.content.map((c) => (c.type === 'text' ? c.text : '')).join('\n');
}

describe('AC-9.4 /mcp authentication (401)', () => {
  it('challenges a request without a token with the resource metadata and tasks:read', async () => {
    const { app, oauth } = setup();
    const res = await rpc(app, null, call('list_orgs'));
    expect(res.status).toBe(401);
    expect(challenge(res)).toEqual(CHALLENGE_READ);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toMatchObject({ jsonrpc: '2.0', error: { code: -32000 }, id: null });
    expect(oauth.calls).toEqual([]);
  });

  it('treats a non-Bearer scheme, a query token and a body token as no token', async () => {
    const { app, alice, oauth } = setup();
    const { token } = await oauth.token(alice, ['tasks:read']);
    const basic = await rpc(app, null, call('list_orgs'), { authorization: `Basic ${token}` });
    expect(challenge(basic)).toEqual(CHALLENGE_READ);
    const query = await app.request(`/mcp?access_token=${token}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ ...call('list_orgs'), access_token: token }),
    });
    expect(query.status).toBe(401);
    expect(challenge(query)).toEqual(CHALLENGE_READ);
    expect(oauth.calls).toEqual([]);
  });

  it('answers an unknown token with invalid_token', async () => {
    const { app, oauth } = setup();
    const res = await rpc(app, 'rooster_at_unknown', call('list_orgs'));
    expect(res.status).toBe(401);
    expect(challenge(res)).toEqual(INVALID_TOKEN);
    expect(oauth.calls).toEqual([{ token: 'rooster_at_unknown', resource: 'mcp' }]);
  });

  it('rejects an oversized token without looking it up', async () => {
    const { app, oauth } = setup();
    const res = await rpc(app, 'x'.repeat(4096), call('list_orgs'));
    expect(res.status).toBe(401);
    expect(challenge(res)).toEqual(INVALID_TOKEN);
    expect(oauth.calls).toEqual([]);
  });

  it('AC-9.3 rejects a token bound to /api/v1 (audience)', async () => {
    const { app, alice, oauth } = setup();
    const { token } = await oauth.token(alice, ['tasks:read'], { orgs: 'all' }, 'api');
    const res = await rpc(app, token, call('list_orgs'));
    expect(res.status).toBe(401);
    expect(challenge(res)).toEqual(INVALID_TOKEN);
    // The endpoint always asks for the `mcp` audience.
    expect(oauth.calls.map((c) => c.resource)).toEqual(['mcp']);
  });

  it('AC-9.4 fails the next call with 401 once the grant is revoked', async () => {
    const { app, alice, oauth } = setup();
    const { token, created } = await oauth.token(alice, ['tasks:read']);
    expect((await rpc(app, token, call('list_orgs'))).status).toBe(200);
    await alice.ok('DELETE', `/api/v1/me/grants/${created.grant.id}`, undefined, 204);
    const res = await rpc(app, token, call('list_orgs'));
    expect(res.status).toBe(401);
    expect(challenge(res)).toEqual(INVALID_TOKEN);
  });
});

describe('AC-9.4 /mcp scope step-up (403 insufficient_scope)', () => {
  it('challenges create_task with a read-only token for tasks:write, before anything runs', async () => {
    const { app, alice, oauth } = setup();
    const { token } = await oauth.token(alice, ['tasks:read']);
    const inbox = await inboxOf(alice);
    const res = await rpc(app, token, call('create_task', { title: 'Nope' }, 'c-1'));
    expect(res.status).toBe(403);
    expect(challenge(res)).toEqual(insufficient('tasks:write'));
    expect(await res.json()).toMatchObject({ error: { code: -32000 }, id: 'c-1' });
    expect(await titlesIn(alice, inbox.id)).toEqual([]);
  });

  it('names every scope a call needs: assigning someone else adds tasks:assign', async () => {
    const { app, alice, oauth } = setup();
    const read = (await oauth.token(alice, ['tasks:read'])).token;
    const write = (await oauth.token(alice, ['tasks:write'])).token;
    const other = { title: 'For Bob', assignee: 'bob@example.com' };
    const asRead = await rpc(app, read, call('create_task', other));
    expect(challenge(asRead)).toEqual(insufficient('tasks:write tasks:assign'));
    const asWrite = await rpc(app, write, call('update_task', { ref: '1', assignee: 'Bob' }));
    expect(asWrite.status).toBe(403);
    expect(challenge(asWrite)).toEqual(insufficient('tasks:write tasks:assign'));
    // Unassigning is assigning nobody: also tasks:assign.
    const none = await rpc(app, write, call('update_task', { ref: '1', assignee: null }));
    expect(challenge(none)).toEqual(insufficient('tasks:write tasks:assign'));
    // Assigning oneself needs only tasks:write.
    // The display name counts as "me" too (ADR 0044 §1); the user is named "Alice".
    for (const me of ['me', 'alice@example.com', 'ALICE@example.com', 'Alice', ' alice ']) {
      const self = await rpc(
        app,
        write,
        call('create_task', { title: `Mine ${me}`, assignee: me }),
      );
      expect(self.status, me).toBe(200);
    }
  });

  it('challenges the other capabilities: groups, comments, notifications, delete', async () => {
    const { app, alice, oauth } = setup();
    const { token } = await oauth.token(alice, ['tasks:write']);
    const cases: [string, Record<string, unknown>, string][] = [
      ['create_group', { name: 'G' }, 'groups:write'],
      ['add_comment', { ref: '1', body: 'Hi' }, 'comments:write'],
      ['list_notifications', {}, 'notifications:read'],
      ['delete_task', { ref: '1' }, 'tasks:delete'],
    ];
    for (const [tool, args, scope] of cases) {
      const res = await rpc(app, token, call(tool, args));
      expect(res.status, tool).toBe(403);
      expect(challenge(res), tool).toEqual(insufficient(scope));
    }
  });

  it('checks every call of a batch and names the union of their scopes', async () => {
    const { app, alice, oauth } = setup();
    const { token } = await oauth.token(alice, ['tasks:read']);
    const inbox = await inboxOf(alice);
    const res = await rpc(app, token, [
      call('list_orgs', {}, 1),
      call('create_group', { name: 'G' }, 2),
      call('create_task', { title: 'Batched' }, 3),
    ]);
    expect(res.status).toBe(403);
    expect(challenge(res)).toEqual(insufficient('tasks:read tasks:write groups:write'));
    expect(await titlesIn(alice, inbox.id)).toEqual([]);
  });

  it('lists every tool but delete_task without tasks:delete (step-up listing)', async () => {
    const { app, alice, oauth } = setup();
    const read = await mcpClient(app, (await oauth.token(alice, ['tasks:read'])).token);
    const names = (await read.listTools()).tools.map((t) => t.name);
    expect(names).toContain('create_task');
    expect(names).not.toContain('delete_task');
    const full = await mcpClient(app, (await oauth.token(alice, ['tasks:delete'])).token);
    const all = (await full.listTools()).tools.map((t) => t.name);
    expect(all).toContain('delete_task');
    // The pre-check knows every tool the server registers, so none can slip past it.
    expect(all.every((n) => (TOOL_NAMES as readonly string[]).includes(n))).toBe(true);
  });
});

describe('AC-9.4 /mcp tools against the REST API in-process', () => {
  it('lists, creates and completes through a real MCP client, attributed via mcp', async () => {
    const { app, alice, oauth } = setup();
    const { token } = await oauth.token(alice, ['tasks:write']);
    const client = await mcpClient(app, token);
    const orgs = (await client.callTool({ name: 'list_orgs', arguments: {} })) as CallToolResult;
    expect(orgs.isError).toBeFalsy();
    expect(text(orgs)).toContain('Personal');

    const created = (await client.callTool({
      name: 'create_task',
      arguments: { title: 'Book dentist' },
    })) as CallToolResult;
    expect(created.isError, text(created)).toBeFalsy();
    const inbox = await inboxOf(alice);
    expect(await titlesIn(alice, inbox.id)).toEqual(['Book dentist']);

    const listed = (await client.callTool({
      name: 'list_tasks',
      arguments: {},
    })) as CallToolResult;
    expect(text(listed)).toContain('Book dentist');

    const list = await alice.ok<{ tasks: { id: string; title: string; seq: number | null }[] }>(
      'GET',
      `/api/v1/orgs/personal/my-list`,
    );
    const task = list.tasks.find((t) => t.title === 'Book dentist');
    if (task === undefined) throw new Error('task');
    const done = (await client.callTool({
      name: 'complete_task',
      arguments: { ref: String(task.seq) },
    })) as CallToolResult;
    expect(done.isError, text(done)).toBeFalsy();
    const detail = await alice.ok<{ completedAt: number | null }>(
      'GET',
      `/api/v1/tasks/${task.id}`,
    );
    expect(detail.completedAt).not.toBeNull();

    const feed = await alice.ok<{
      items: { kind: string; activity?: { type: string; via: string } }[];
    }>('GET', `/api/v1/tasks/${task.id}/activity?limit=50`);
    const entries = feed.items.flatMap((i) => (i.activity === undefined ? [] : [i.activity]));
    expect(entries.map((e) => [e.type, e.via])).toEqual([
      ['created', 'mcp'],
      ['completed', 'mcp'],
    ]);
  });

  it('AC-9.4 a write outside the grant is a tool error naming the allowed groups', async () => {
    const { app, alice, oauth } = setup();
    const orgId = await personalOrgId(alice);
    const inbox = await inboxOf(alice);
    const prio = await groupNamed(alice, 'Prio');
    const { token } = await oauth.token(alice, ['tasks:write'], {
      orgs: [{ orgId, read: 'all', write: { groups: [inbox.id] } }],
    });
    const client = await mcpClient(app, token);
    const created = (await client.callTool({
      name: 'create_task',
      arguments: { title: 'Pay rent' },
    })) as CallToolResult;
    expect(created.isError, text(created)).toBeFalsy();
    expect(await titlesIn(alice, inbox.id)).toEqual(['Pay rent']);

    const list = await alice.ok<{ tasks: { title: string; seq: number | null }[] }>(
      'GET',
      '/api/v1/orgs/personal/my-list',
    );
    const seq = list.tasks.find((t) => t.title === 'Pay rent')?.seq;
    const moved = (await client.callTool({
      name: 'move_task',
      arguments: { ref: String(seq), group: 'Prio' },
    })) as CallToolResult;
    expect(moved.isError).toBe(true);
    expect(text(moved)).toContain('outside_grant');
    expect(text(moved)).toContain(inbox.name);
    expect(await titlesIn(alice, prio.id)).toEqual([]);
    // A constraint miss is a tool result, never an HTTP scope challenge.
    const raw = await rpc(app, token, call('move_task', { ref: String(seq), group: 'Prio' }));
    expect(raw.status).toBe(200);
  });

  it('applies the per-user API limit to the in-process calls', async () => {
    const ctx = listCtx({ apiRateLimit: { max: 3, windowMs: 60_000 } });
    const alice = ctx.user('alice@example.com');
    const oauth = new FakeOAuth(ctx.app);
    const { token } = await oauth.token(alice, ['tasks:read']);
    const client = await mcpClient(ctx.app, token);
    let limited = false;
    for (let i = 0; i < 5 && !limited; i += 1) {
      const result = (await client.callTool({
        name: 'list_orgs',
        arguments: {},
      })) as CallToolResult;
      limited = result.isError === true && text(result).includes('rate_limited');
    }
    expect(limited).toBe(true);
  });
});

describe('AC-9.4 /mcp tool-call rate limit (120 per grant and minute)', () => {
  it('answers 429 with Retry-After past the limit, per grant, and recovers after the window', async () => {
    let now = Date.UTC(2026, 9, 9, 12);
    const { app, alice, oauth } = setup({ clock: () => now });
    const first = (await oauth.token(alice, ['tasks:read'])).token;
    const second = (await oauth.token(alice, ['tasks:read'])).token;
    // An unknown tool still counts as a call, and is cheap to answer.
    for (let i = 0; i < MCP_TOOL_CALL_LIMIT.max; i += 1) {
      const res = await rpc(app, first, call('no_such_tool', {}, i));
      expect(res.status).toBe(200);
    }
    const over = await rpc(app, first, call('list_orgs', {}, 'over'));
    expect(over.status).toBe(429);
    expect(over.headers.get('retry-after')).toBe('60');
    expect(await over.json()).toMatchObject({ error: { code: -32000 }, id: 'over' });
    // Other requests of the same grant (listing) are not tool calls.
    const list = await rpc(app, first, { jsonrpc: '2.0', id: 9, method: 'tools/list' });
    expect(list.status).toBe(200);
    // Another grant has its own budget.
    expect((await rpc(app, second, call('list_orgs'))).status).toBe(200);
    now += 30_000;
    expect((await rpc(app, first, call('list_orgs'))).headers.get('retry-after')).toBe('30');
    now += 30_001;
    expect((await rpc(app, first, call('list_orgs'))).status).toBe(200);
  });
});

describe('/mcp transport rules', () => {
  it('answers GET and DELETE with 405 (stateless: no stream, no session)', async () => {
    const { app } = setup();
    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) {
      const res = await app.request('/mcp', { method });
      expect(res.status, method).toBe(405);
      expect(res.headers.get('allow')).toBe('POST');
    }
  });

  it('rejects a foreign or opaque Origin before authentication (DNS rebinding)', async () => {
    const { app, alice, oauth } = setup();
    const { token } = await oauth.token(alice, ['tasks:read']);
    for (const origin of ['https://evil.example', 'null', 'http://localhost:3001']) {
      const res = await rpc(app, token, call('list_orgs'), { origin });
      expect(res.status, origin).toBe(403);
    }
    expect(oauth.calls).toEqual([]);
    expect((await rpc(app, token, call('list_orgs'), { origin: BASE_URL })).status).toBe(200);
  });

  it('rejects on Origin, method, auth and headers without waiting for the body', async () => {
    const { app, alice, oauth } = setup();
    const { token } = await oauth.token(alice, ['tasks:read']);
    // A chunked body that never ends: any check that read it first would hang.
    const endless = () =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('{"jsonrpc":"2.0",'));
        },
      });
    const send = (headers: Record<string, string>) =>
      Promise.race([
        app.request('/mcp', {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            accept: 'application/json, text/event-stream',
            ...headers,
          },
          body: endless(),
          duplex: 'half',
        } as RequestInit),
        new Promise<'hung'>((resolve) => setTimeout(() => resolve('hung'), 1_000)),
      ]);
    const cases: [Record<string, string>, number][] = [
      [{ origin: 'https://evil.example' }, 403],
      [{}, 401],
      [{ authorization: 'Bearer rooster_at_unknown' }, 401],
      [{ authorization: `Bearer ${token}`, 'content-type': 'text/plain' }, 415],
      [{ authorization: `Bearer ${token}`, accept: 'text/html' }, 406],
    ];
    for (const [headers, status] of cases) {
      const res = await send(headers);
      expect(res === 'hung' ? 'hung' : res.status, JSON.stringify(headers)).toBe(status);
    }
  });

  it('cuts off a chunked body over 1 MB without a Content-Length', async () => {
    const { app, alice, oauth } = setup();
    const { token } = await oauth.token(alice, ['tasks:read']);
    const chunk = new Uint8Array(64 * 1024).fill(0x20);
    let sent = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        sent += chunk.byteLength;
        controller.enqueue(chunk);
        if (sent > 4 * 1024 * 1024) controller.close();
      },
    });
    const res = await app.request('/mcp', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
      },
      body,
      duplex: 'half',
    } as RequestInit);
    expect(res.status).toBe(413);
    // It stopped reading at the bound rather than draining the stream.
    expect(sent).toBeLessThan(2 * 1024 * 1024);
  });

  it('enforces JSON, the Accept header, valid JSON and the body size', async () => {
    const { app, alice, oauth } = setup();
    const { token } = await oauth.token(alice, ['tasks:read']);
    const form = await rpc(app, token, 'a=b', { 'content-type': 'text/plain' });
    expect(form.status).toBe(415);
    for (const accept of ['application/json', 'text/event-stream', '*/*', 'text/html']) {
      const res = await rpc(app, token, call('list_orgs'), { accept });
      expect(res.status, accept).toBe(406);
    }
    const broken = await rpc(app, token, '{"jsonrpc":');
    expect(broken.status).toBe(400);
    expect(await broken.json()).toMatchObject({ error: { code: -32700 } });
    const huge = await rpc(
      app,
      token,
      call('create_task', { title: 'x', description: 'y'.repeat(1_100_000) }),
    );
    expect(huge.status).toBe(413);
  });

  it('sends no-store and the security headers', async () => {
    const { app, alice, oauth } = setup();
    const { token } = await oauth.token(alice, ['tasks:read']);
    const res = await rpc(app, token, call('list_orgs'));
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(res.headers.get('access-control-allow-origin')).toBeNull();
  });
});

describe('RFC 9728 protected resource metadata', () => {
  for (const path of [
    '/.well-known/oauth-protected-resource/mcp',
    '/.well-known/oauth-protected-resource',
  ]) {
    it(`serves ${path} with CORS, with discovery on or off`, async () => {
      for (const discovery of ['on', 'off']) {
        const ctx = listCtx({ env: { ROOSTER_AGENT_DISCOVERY: discovery } });
        const res = await ctx.app.request(path);
        expect(res.status).toBe(200);
        expect(res.headers.get('access-control-allow-origin')).toBe('*');
        expect(await res.json()).toEqual({
          resource: MCP_URL,
          authorization_servers: [`${BASE_URL}/api/auth`],
          scopes_supported: ['tasks:read'],
          bearer_methods_supported: ['header'],
          resource_name: 'rooster',
        });
        const preflight = await ctx.app.request(path, { method: 'OPTIONS' });
        expect(preflight.status).toBe(204);
        expect(preflight.headers.get('access-control-allow-origin')).toBe('*');
      }
    });
  }
});
