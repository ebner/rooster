import { describe, expect, it } from 'vitest';
import { FAKE_ENV, fakeApi, ME, ORG } from './support/fake-api.ts';
import { cliHarness } from './support/fake-io.ts';

const group = (id: string, name: string, kind = 'normal', position = 'a1') => ({
  id,
  orgId: ORG.id,
  kind,
  name,
  position,
  collapsed: false,
});
const INBOX = group('01a00000-0000-7000-8000-00000000000a', 'Inbox', 'inbox', 'a0');
const OLD = group('01a00000-0000-7000-8000-00000000000b', 'Archive');
const PRIO = group('01a00000-0000-7000-8000-00000000000c', 'Prio', 'normal', 'a2');

function oldCompletedTask(groupId: string) {
  return {
    id: '01a00000-0000-7000-8000-0000000000f1',
    orgId: ORG.id,
    seq: 9,
    parentId: null,
    subtaskPosition: null,
    title: 'Done long ago',
    hasDescription: false,
    assigneeId: ME.id,
    createdBy: ME.id,
    dueDate: null,
    dueTime: null,
    dueTz: null,
    startDate: null,
    completedAt: 1,
    tagIds: [],
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: { groupId, position: 'a0' },
    createdAt: 0,
    updatedAt: 0,
  };
}

async function run(routes: Parameters<typeof fakeApi>[0], argv: string[]) {
  const api = fakeApi({ 'GET /api/v1/me': ME, ...routes });
  const cli = cliHarness({}, { fetch: api.fetch });
  try {
    return { ...(await cli.run(argv, { env: FAKE_ENV })), calls: api.calls };
  } finally {
    cli.cleanup();
  }
}

describe('[P2] group rm', () => {
  // The default my-list window hides tasks completed more than 14 days ago; the server still
  // counts them, so the CLI asks for every completed task (completedSince=0).
  const myList = (call: { search: string }) => ({
    groups: [INBOX, OLD, PRIO],
    tasks: call.search.includes('completedSince=0') ? [oldCompletedTask(OLD.id)] : [],
    expandedTaskIds: [],
    serverTime: 0,
  });

  it('always forwards --delete-tasks, and counts old completed tasks for the confirmation', async () => {
    const result = await run(
      {
        'GET /api/v1/orgs/*/my-list': myList,
        'DELETE /api/v1/groups/*': undefined,
      },
      ['group', 'rm', 'Archive', '--delete-tasks', '--yes'],
    );
    expect(result.code).toBe(0);
    const del = result.calls.find((c) => c.method === 'DELETE');
    expect(del).toMatchObject({ path: `/api/v1/groups/${OLD.id}`, body: { deleteTasks: true } });
  });

  it('asks before deleting old completed tasks without --yes (no terminal: exit 2)', async () => {
    const result = await run(
      { 'GET /api/v1/orgs/*/my-list': myList, 'DELETE /api/v1/groups/*': undefined },
      ['group', 'rm', 'Archive', '--delete-tasks'],
    );
    expect(result.code).toBe(2);
    expect(result.calls.some((c) => c.method === 'DELETE')).toBe(false);
  });

  it('always forwards --move-to, and refuses a non-empty group without either option', async () => {
    const moved = await run(
      { 'GET /api/v1/orgs/*/my-list': myList, 'DELETE /api/v1/groups/*': undefined },
      ['group', 'rm', 'Archive', '--move-to', 'Prio'],
    );
    expect(moved.code).toBe(0);
    expect(moved.calls.find((c) => c.method === 'DELETE')?.body).toEqual({ moveTasksTo: PRIO.id });

    const neither = await run(
      { 'GET /api/v1/orgs/*/my-list': myList, 'DELETE /api/v1/groups/*': undefined },
      ['group', 'rm', 'Archive'],
    );
    expect(neither.code).toBe(5);
    expect(neither.stderr).toContain('has 1 task');
  });
});

describe('[P2] token create default write constraint', () => {
  const tokenRoute = (call: { body: unknown }) => ({
    token: 'rooster_pat_x',
    grant: {
      id: '01a00000-0000-7000-8000-0000000000e1',
      kind: 'pat',
      clientId: null,
      label: 'c',
      scopes: (call.body as { scopes: string[] }).scopes,
      constraints: (call.body as { constraints: unknown }).constraints,
      tokenPrefix: 'rooster_pat_x',
      createdAt: 0,
      updatedAt: 0,
      expiresAt: null,
      lastUsedAt: null,
      lastUsedIp: null,
      current: false,
    },
  });

  it.each([
    ['comments:write', 'all'],
    ['groups:write', 'all'],
    ['tasks:write', 'all'],
    ['tasks:read', 'none'],
    ['notifications:read', 'none'],
  ])('--scope %s --org acme writes %s', async (scope, write) => {
    const result = await run({ 'POST /api/v1/me/tokens': tokenRoute }, [
      'token',
      'create',
      'c',
      '--scope',
      scope,
      '--org',
      'acme',
    ]);
    expect(result.code).toBe(0);
    const body = result.calls.find((c) => c.path === '/api/v1/me/tokens')?.body;
    expect(body).toMatchObject({
      scopes: [scope],
      constraints: { orgs: [{ orgId: ORG.id, read: 'all', write }] },
    });
  });
});
