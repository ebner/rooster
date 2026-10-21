import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';
import { addDays, todayIn } from '@rooster/core/dates';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runCli } from '../src/run.ts';
import { approveDevice, pendingDevice } from './support/device.ts';
import { fakeIo } from './support/fake-io.ts';
import { type RoosterServer, startServer, type TestUser } from './support/rooster-server.ts';

const CLI_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');

let server: RoosterServer;
beforeAll(async () => {
  server = await startServer();
});
afterAll(async () => {
  await server?.close();
});

/** The private home `rooster mcp setup` signs the `agent` profile into. */
function envFor(home: string): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '',
    HOME: home,
    XDG_CONFIG_HOME: join(home, 'config'),
    XDG_STATE_HOME: join(home, 'state'),
    XDG_CACHE_HOME: join(home, 'cache'),
    ROOSTER_KEYRING: 'off',
    LANG: 'en_US.UTF-8',
  };
}

/**
 * `rooster mcp setup --client print`, approved on the device page the way the web app would:
 * the requested scopes, every org.
 */
async function setupAgent(user: TestUser, home: string, extra: string[] = []) {
  const io = fakeIo(home, {
    // The server's own interval: it answers slow_down to polls that come sooner.
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  });
  const setup = runCli(['mcp', 'setup', '--no-browser', '--server', server.url, ...extra], io);
  let code: string | undefined;
  for (let i = 0; i < 300 && code === undefined; i++) {
    code = /Code: (\S+)/.exec(io.out.join(''))?.[1];
    if (code === undefined) await new Promise((r) => setTimeout(r, 10));
  }
  expect(code).toBeDefined();
  const { requestedScopes } = await pendingDevice(user, code ?? '');
  const approved = await approveDevice(user, code ?? '', {
    scopes: requestedScopes,
    constraints: { orgs: 'all' },
  });
  expect(approved.status).toBe(200);
  expect(await setup).toBe(0);
  return { io, requested: requestedScopes };
}

/** An MCP client talking to `rooster mcp` over a real stdio pipe (a child process). */
async function spawnMcp(home: string, args: string[] = []) {
  const stderr: string[] = [];
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', join(CLI_DIR, 'src/main.ts'), 'mcp', '--profile', 'agent', ...args],
    cwd: CLI_DIR,
    env: envFor(home),
    stderr: 'pipe',
  });
  transport.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk.toString()));
  const client = new Client({ name: 'ac-9.2', version: '1.0.0' });
  await client.connect(transport);
  return { client, stderr, close: () => client.close() };
}

function dataOf(result: unknown): Record<string, unknown> {
  return (result as { structuredContent: Record<string, unknown> }).structuredContent;
}

describe('AC-9.2 rooster mcp over stdio', () => {
  it('AC-9.2 setup creates the agent profile; list_tasks, create_task with an NL date and complete_task work; activity shows via mcp', async () => {
    const user = await server.user('ac92@example.com', 'Ada');
    const home = mkdtempSync(join(tmpdir(), 'rooster-mcp-'));
    try {
      const { io, requested } = await setupAgent(user, home);
      // A dedicated, narrower grant: no assigning others, no deleting (11 §5.1, ADR 0041).
      expect(requested).toEqual(
        expect.arrayContaining([
          'comments:write',
          'groups:write',
          'notifications:read',
          'tasks:write',
        ]),
      );
      expect(requested).not.toContain('tasks:assign');
      expect(requested).not.toContain('tasks:delete');
      // `print`: the client config and the official Claude Code command, never a token.
      const printed = io.out.join('');
      expect(printed).toContain('"mcpServers"');
      expect(printed).toContain('"rooster"');
      expect(printed).toContain('claude mcp add --scope user rooster --');
      expect(printed).toContain('mcp --profile agent');
      expect(printed).not.toMatch(/rooster_pat_|Bearer|token/i);
      // The agent profile is not made the default one.
      const config = readFileSync(join(home, 'config', 'rooster', 'config.toml'), 'utf8');
      expect(config).toContain('[profiles.agent]');
      expect(config).not.toContain('default_profile');

      const mcp = await spawnMcp(home);
      try {
        const names = (await mcp.client.listTools()).tools.map((t) => t.name);
        expect(names).toContain('create_task');
        expect(names).not.toContain('delete_task');
        expect(mcp.client.getInstructions()).toContain('rooster');

        const created = await mcp.client.callTool({
          name: 'create_task',
          arguments: { title: 'Book dentist', due: 'tomorrow' },
        });
        expect(created.isError).toBeFalsy();
        const task = dataOf(created).task as { ref: string; due: string };
        const { data: me } = await user.api<{ timezone: string }>('GET', '/api/v1/me');
        expect(task.due).toBe(addDays(todayIn(me.timezone, Date.now()), 1));

        const listed = await mcp.client.callTool({ name: 'list_tasks', arguments: {} });
        const rows = dataOf(listed).tasks as { ref: string; title: string }[];
        expect(rows.find((r) => r.ref === task.ref)?.title).toBe('Book dentist');

        const done = await mcp.client.callTool({
          name: 'complete_task',
          arguments: { ref: task.ref },
        });
        expect(done.isError).toBeFalsy();

        const { data: resolved } = await user.api<{ id: string; completedAt: number | null }>(
          'GET',
          `/api/v1/tasks/resolve?ref=${encodeURIComponent(task.ref)}`,
        );
        expect(resolved.completedAt).not.toBeNull();
        const { data: activity } = await user.api<{
          items: { kind: string; activity?: { type: string; via: string } }[];
        }>('GET', `/api/v1/tasks/${resolved.id}/activity`);
        const entries = activity.items.flatMap((i) =>
          i.activity === undefined ? [] : [i.activity],
        );
        expect(entries.map((e) => e.type)).toEqual(
          expect.arrayContaining(['created', 'completed']),
        );
        expect(entries.every((e) => e.via === 'mcp')).toBe(true);
      } finally {
        await mcp.close();
      }
      // Nothing but protocol went to stdout: the client parsed every line. Logs, if any, are on stderr.
      expect(mcp.stderr.join('')).not.toContain('jsonrpc');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('AC-9.2 --read-only hides the mutating tools', async () => {
    const user = await server.user('ac92ro@example.com', 'Bea');
    const home = mkdtempSync(join(tmpdir(), 'rooster-mcp-'));
    try {
      await setupAgent(user, home, ['--allow-delete']);
      const mcp = await spawnMcp(home, ['--read-only']);
      try {
        const names = (await mcp.client.listTools()).tools.map((t) => t.name).sort();
        expect(names).toEqual(
          [
            'get_task',
            'list_groups',
            'list_notifications',
            'list_orgs',
            'list_tasks',
            'search_tasks',
          ].sort(),
        );
        const call = await mcp.client
          .callTool({ name: 'create_task', arguments: { title: 'nope' } })
          .catch((error: unknown) => ({ isError: true, error }));
        expect(call.isError).toBe(true);
      } finally {
        await mcp.close();
      }
      // With --allow-delete (and without --read-only) the delete tool is there.
      const full = await spawnMcp(home);
      try {
        expect((await full.client.listTools()).tools.map((t) => t.name)).toContain('delete_task');
      } finally {
        await full.close();
      }
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it('a profile without a login fails before serving, on stderr only', async () => {
    const home = mkdtempSync(join(tmpdir(), 'rooster-mcp-'));
    try {
      const io = fakeIo(home);
      expect(await runCli(['mcp', '--profile', 'nobody'], io)).toBe(3);
      expect(io.out.join('')).toBe('');
      expect(io.err.join('')).toContain('not signed in');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
