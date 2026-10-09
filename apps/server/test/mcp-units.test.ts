// Units of the remote MCP endpoint: the in-process REST client (no token passthrough, API
// only), the JSON-RPC scanning the scope pre-check relies on, and the challenge format.
import { describe, expect, it } from 'vitest';
import { IN_PROCESS_ACTOR, type InProcessBindings } from '../src/lib/in-process.ts';
import { mcpProtectedResourceMetadata } from '../src/mcp/challenge.ts';
import { createInProcessClient } from '../src/mcp/in-process-client.ts';
import { echoId, toolCallsOf } from '../src/mcp/jsonrpc.ts';
import type { Actor } from '../src/services/index.ts';
import { BASE_URL, testConfig } from './helpers.ts';

const actor: Actor = {
  userId: 'u1',
  email: 'alice@example.com',
  isAdmin: false,
  via: 'oauth',
  sessionId: 'g1',
  grant: {
    id: 'g1',
    kind: 'oauth',
    clientId: 'https://client.example/meta.json',
    scopes: ['tasks:read'],
    constraints: { orgs: 'all' },
    updatedAt: 0,
  },
};

function capture() {
  const seen: { request: Request; env: InProcessBindings; body: string }[] = [];
  const client = createInProcessClient({
    baseUrl: BASE_URL,
    version: '9.9.9',
    actor,
    appFetch: async (request, env) => {
      seen.push({ request, env, body: await request.clone().text() });
      return Response.json({ ok: true });
    },
  });
  return { client, seen };
}

describe('the in-process REST client', () => {
  it('carries the actor by symbol and names itself mcp/<version>, with no credentials', async () => {
    const { client, seen } = capture();
    await client.POST('/api/v1/orgs/{orgId}/tasks', {
      params: { path: { orgId: 'personal' } },
      body: { title: 'x' },
      headers: {
        authorization: 'Bearer leaked',
        cookie: 'rooster.session=leaked',
        'x-forwarded-for': '1.2.3.4',
        'x-rooster-client': 'web',
      },
    });
    expect(seen).toHaveLength(1);
    const [{ request, env, body }] = seen as [(typeof seen)[number]];
    expect(env[IN_PROCESS_ACTOR]).toBe(actor);
    expect(request.url).toBe(`${BASE_URL}/api/v1/orgs/personal/tasks`);
    expect(request.headers.get('authorization')).toBeNull();
    expect(request.headers.get('cookie')).toBeNull();
    expect(request.headers.get('x-forwarded-for')).toBeNull();
    expect(request.headers.get('x-rooster-client')).toBe('mcp/9.9.9');
    expect(JSON.parse(body)).toEqual({ title: 'x' });
  });

  it('refuses anything but the REST API on the instance origin', async () => {
    const { client, seen } = capture();
    const raw = client as unknown as {
      GET(path: string, init?: Record<string, unknown>): Promise<unknown>;
    };
    for (const path of [
      '/api/auth/oauth2/token',
      '/api/v1/../auth/get-session',
      '/api/v1/%2e%2e/auth/x',
      '/healthz',
    ]) {
      await expect(raw.GET(path), path).rejects.toThrow(/only call the REST API/);
    }
    await expect(raw.GET('/api/v1/me', { baseUrl: 'https://evil.example' })).rejects.toThrow(
      /only call the REST API/,
    );
    expect(seen).toEqual([]);
  });
});

describe('JSON-RPC scanning for the scope pre-check', () => {
  it('finds tools/call in single messages and batches, and skips malformed ones', () => {
    const calls = toolCallsOf([
      {
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: { name: 'create_task', arguments: { title: 'a' } },
      },
      { jsonrpc: '2.0', id: 'x', method: 'tools/list' },
      { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 42 } },
      { jsonrpc: '2.0', method: 'tools/call', params: { name: 'list_orgs' } },
      null,
      'tools/call',
    ]);
    expect(calls).toEqual([
      { id: 1, name: 'create_task', args: { title: 'a' } },
      { id: null, name: 'list_orgs', args: undefined },
    ]);
    expect(toolCallsOf({ method: 'tools/call', id: 'a', params: { name: 'x' } })).toEqual([
      { id: 'a', name: 'x', args: undefined },
    ]);
    expect(toolCallsOf(null)).toEqual([]);
  });

  it('sees the same name JSON.parse gives the SDK when a key is repeated', () => {
    const body = JSON.parse(
      '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_orgs","name":"create_task"}}',
    ) as unknown;
    expect(toolCallsOf(body).map((c) => c.name)).toEqual(['create_task']);
  });

  it('echoes a single request id only', () => {
    expect(echoId({ id: 7 })).toBe(7);
    expect(echoId({ id: 'a' })).toBe('a');
    expect(echoId({ id: {} })).toBeNull();
    expect(echoId([{ id: 1 }])).toBeNull();
  });
});

describe('challenge and metadata', () => {
  it('names the better-auth issuer as the authorization server (ADR 0041)', () => {
    expect(mcpProtectedResourceMetadata(testConfig()).authorization_servers).toEqual([
      `${BASE_URL}/api/auth`,
    ]);
  });
});
