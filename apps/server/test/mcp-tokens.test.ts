// Phase 12 WP 12.3 (11 §9.7, ADR 0065): MCP tokens, personal access tokens with the audience
// `mcp`, accepted at the remote MCP endpoint only.
import type { CallToolResult } from '@modelcontextprotocol/client';
import type { Grant, Task, TokenCreated } from '@rooster/core/schemas';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { activity } from '../src/db/schema/index.ts';
import { bearer } from './grant-helpers.ts';
import { listCtx } from './list-helpers.ts';
import { challenge, mcpClient, rpc } from './mcp-helpers.ts';

function toolCall(name: string, args: Record<string, unknown> = {}) {
  return { jsonrpc: '2.0', id: 7, method: 'tools/call', params: { name, arguments: args } };
}

describe('AC-12.3 MCP tokens', () => {
  it('AC-12.3 an MCP token works at /mcp only, within its scopes, until revoked', async () => {
    const ctx = listCtx();
    const owner = ctx.user('ann@example.com', 'Ann');
    await owner.ok<Task>('POST', '/api/v1/orgs/personal/tasks', { title: 'Water plants' }, 201);
    const { token, grant } = await owner.ok<TokenCreated>(
      'POST',
      '/api/v1/me/tokens',
      {
        name: 'Claude Code',
        scopes: ['tasks:read'],
        constraints: { orgs: 'all' },
        audience: 'mcp',
      },
      201,
    );
    expect(grant.audience).toBe('mcp');

    // A client given only a static Authorization header.
    const client = await mcpClient(ctx.app, token);
    const listed = (await client.callTool({ name: 'list_tasks', arguments: {} })) as CallToolResult;
    expect(listed.isError).toBeFalsy();
    expect(JSON.stringify(listed.content)).toContain('Water plants');
    await client.close();

    // No step-up for a token: the 403 names the scopes and says where to widen it.
    const write = await rpc(ctx.app, token, toolCall('create_task', { title: 'Nope' }));
    expect(write.status).toBe(403);
    expect(challenge(write)).toMatchObject({ error: 'insufficient_scope', scope: 'tasks:write' });
    const message = ((await write.json()) as { error: { message: string } }).error.message;
    expect(message).toContain('tasks:write');
    expect(message).toContain('Settings → Connected apps');

    // Refused by /api/v1.
    expect((await bearer(ctx, token).call('GET', '/api/v1/me')).status).toBe(401);

    // Revoked: the next call fails with 401.
    await owner.ok('DELETE', `/api/v1/me/grants/${grant.id}`, undefined, 204);
    const after = await rpc(ctx.app, token, toolCall('list_orgs'));
    expect(after.status).toBe(401);
  });

  it('AC-12.3 an API token is refused by /mcp', async () => {
    const ctx = listCtx();
    const owner = ctx.user('ann@example.com');
    const { token, grant } = await owner.ok<TokenCreated>(
      'POST',
      '/api/v1/me/tokens',
      { name: 'Script', scopes: ['tasks:read'], constraints: { orgs: 'all' } },
      201,
    );
    expect(grant.audience).toBe('api');
    const res = await rpc(ctx.app, token, toolCall('list_orgs'));
    expect(res.status).toBe(401);
    expect(challenge(res)?.error).toBe('invalid_token');
    expect((await bearer(ctx, token).call('GET', '/api/v1/me')).status).toBe(200);
  });

  it('an MCP token never carries admin', async () => {
    const ctx = listCtx();
    const admin = ctx.user('admin@example.com');
    const res = await admin.call('POST', '/api/v1/me/tokens', {
      name: 'Agent',
      scopes: ['tasks:read', 'admin'],
      constraints: { orgs: 'all' },
      audience: 'mcp',
    });
    expect(res.status).toBe(422);
    expect(((await res.json()) as { code: string }).code).toBe('admin_not_for_mcp');
  });

  it('records MCP-token writes as via mcp, and lists the audience in Connected apps', async () => {
    const ctx = listCtx();
    const owner = ctx.user('ann@example.com');
    const { token } = await owner.ok<TokenCreated>(
      'POST',
      '/api/v1/me/tokens',
      {
        name: 'Agent',
        scopes: ['tasks:write'],
        constraints: { orgs: 'all' },
        audience: 'mcp',
      },
      201,
    );
    const client = await mcpClient(ctx.app, token);
    const created = (await client.callTool({
      name: 'create_task',
      arguments: { title: 'From the agent' },
    })) as CallToolResult;
    expect(created.isError, JSON.stringify(created.content)).toBeFalsy();
    await client.close();
    const tasks = await owner.ok<{ items: Task[] }>('GET', '/api/v1/orgs/personal/tasks');
    const task = tasks.items.find((t) => t.title === 'From the agent');
    expect(task).toBeDefined();
    const vias = ctx.db.orm
      .select({ data: activity.data })
      .from(activity)
      .where(eq(activity.taskId, task?.id ?? ''))
      .all()
      .map((r) => (JSON.parse(r.data) as { via?: string }).via);
    expect(vias).toEqual(['mcp']);
    const grants = await owner.ok<Grant[]>('GET', '/api/v1/me/grants');
    expect(grants.map((g) => g.audience)).toEqual(['mcp']);
  });
});
