import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createRoosterClient } from '@rooster/api-client';
import type { GrantScope } from '@rooster/core/grants';
import { createRoosterMcpServer, type RoosterMcpOptions } from '../src/index.ts';

/** A recorded API call. */
export interface FakeCall {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}

type Handler = (call: FakeCall) => unknown;

/**
 * A scripted REST API: routes keyed `METHOD /path` (`*` matches one segment). Unrouted calls
 * are `404 not_found`, as an unreadable resource is on the real server.
 */
export function fakeApi(routes: Record<string, Handler | unknown>) {
  const calls: FakeCall[] = [];
  const compiled = Object.entries(routes).map(([key, handler]) => {
    const [method, path] = key.split(' ') as [string, string];
    const re = new RegExp(
      `^${path.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]+')}$`,
    );
    return { method, re, handler };
  });
  const fetchFn = async (input: Request): Promise<Response> => {
    const url = new URL(input.url);
    const text = input.method === 'GET' ? '' : await input.text();
    const call: FakeCall = {
      method: input.method,
      path: url.pathname,
      query: url.searchParams,
      body: text === '' ? undefined : JSON.parse(text),
    };
    calls.push(call);
    const route = compiled.find((r) => r.method === input.method && r.re.test(url.pathname));
    if (route === undefined) return problem(404, 'not_found', 'Not found.');
    const result =
      typeof route.handler === 'function' ? (route.handler as Handler)(call) : route.handler;
    if (result instanceof Response) return result;
    if (result === undefined) return new Response(null, { status: 204 });
    return Response.json(result);
  };
  const client = createRoosterClient({
    baseUrl: 'https://rooster.test',
    fetch: fetchFn as unknown as typeof fetch,
  });
  return { calls, client };
}

export function problem(status: number, code: string, detail: string, extra: object = {}) {
  return new Response(
    JSON.stringify({ type: 'about:blank', title: code, status, code, detail, ...extra }),
    { status, headers: { 'content-type': 'application/problem+json' } },
  );
}

export const ORG = {
  id: '01a00000-0000-7000-8000-000000000001',
  slug: 'acme',
  name: 'Acme',
  isPersonal: false,
  avatarEmoji: null,
  color: null,
  role: 'owner',
  position: 'a1',
  collapsed: false,
};

export const PERSONAL = {
  ...ORG,
  id: '01a00000-0000-7000-8000-000000000002',
  slug: 'ada',
  name: 'Ada',
  isPersonal: true,
  position: 'a0',
};

export const ME = {
  id: '01a00000-0000-7000-8000-0000000000aa',
  name: 'Ada Larkin',
  email: 'ada@example.com',
  image: null,
  locale: 'en',
  timezone: 'UTC',
  weekStart: 1,
  dateFormat: 'MMM d',
  timeFormat: '24h',
  prefs: {},
  isAdmin: false,
  orgs: [ORG, PERSONAL],
};

export const INBOX = {
  id: '01a00000-0000-7000-8000-0000000000b0',
  orgId: ORG.id,
  kind: 'inbox',
  name: 'Inbox',
  position: 'a0',
  collapsed: false,
};
export const PRIO = {
  ...INBOX,
  id: '01a00000-0000-7000-8000-0000000000b1',
  kind: 'normal',
  name: 'Prio',
  position: 'a1',
};

/** A task DTO with defaults (2026-10-09 is "today" in the tests). */
export function task(overrides: Record<string, unknown> = {}) {
  return {
    id: '01a00000-0000-7000-8000-0000000000c1',
    orgId: ORG.id,
    seq: 41,
    parentId: null,
    subtaskPosition: null,
    title: 'Reply to Anna',
    hasDescription: false,
    assigneeId: ME.id,
    createdBy: ME.id,
    dueDate: null,
    dueTime: null,
    dueTz: null,
    startDate: null,
    completedAt: null,
    tagIds: [],
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: { groupId: INBOX.id, position: 'a0' },
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

/** 2026-10-09 12:00 UTC: a Friday. */
export const NOW = Date.UTC(2026, 9, 9, 12, 0, 0);

export const ALL_SCOPES: GrantScope[] = [
  'tasks:read',
  'tasks:write',
  'comments:write',
  'tasks:assign',
  'groups:write',
  'tasks:delete',
  'notifications:read',
];

/** An MCP client connected in memory to a rooster MCP server over `client`. */
export async function connect(
  options: Partial<RoosterMcpOptions> & Pick<RoosterMcpOptions, 'client'>,
) {
  const server = createRoosterMcpServer({
    listing: { mode: 'granted', scopes: ALL_SCOPES },
    instanceUrl: 'https://rooster.test',
    version: '1.2.0',
    now: () => NOW,
    ...options,
  });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const mcp = new Client({ name: 'test', version: '1.0.0' });
  await mcp.connect(clientTransport);
  return {
    mcp,
    server,
    async close() {
      await mcp.close();
      await server.close();
    },
  };
}

/** The text blocks of a tool result. */
export function texts(result: { content?: unknown }): { text: string; annotations?: unknown }[] {
  return ((result.content ?? []) as { type: string; text: string; annotations?: unknown }[]).filter(
    (c) => c.type === 'text',
  );
}
