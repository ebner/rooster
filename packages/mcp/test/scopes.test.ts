import type { GrantScope } from '@rooster/core/grants';
import { describe, expect, it } from 'vitest';
import { listedTools } from '../src/server.ts';
import {
  isAssigneeMe,
  READ_ONLY_TOOLS,
  requiredScopes,
  TOOL_NAMES,
  type ToolName,
} from '../src/tools.ts';

const ctx = { userId: '01a0-me', email: 'Ada@Example.com', name: 'Ada Larkin' };

describe('requiredScopes (11 §5.2)', () => {
  const base: [ToolName, GrantScope][] = [
    ['list_orgs', 'tasks:read'],
    ['list_tasks', 'tasks:read'],
    ['get_task', 'tasks:read'],
    ['search_tasks', 'tasks:read'],
    ['list_groups', 'tasks:read'],
    ['create_task', 'tasks:write'],
    ['update_task', 'tasks:write'],
    ['complete_task', 'tasks:write'],
    ['move_task', 'tasks:write'],
    ['create_group', 'groups:write'],
    ['add_comment', 'comments:write'],
    ['list_notifications', 'notifications:read'],
    ['delete_task', 'tasks:delete'],
  ];
  it.each(base)('%s needs %s', (tool, scope) => {
    expect(requiredScopes(tool, {}, ctx)).toEqual([scope]);
  });

  it('covers every tool', () => {
    expect(base.map(([tool]) => tool).sort()).toEqual([...TOOL_NAMES].sort());
  });

  it.each([
    ['me'],
    ['ME'],
    [' mig '],
    ['01a0-me'],
    ['ada@example.com'],
    ['ADA@EXAMPLE.COM'],
    ['ada larkin'],
  ])('assignee %j is the user: tasks:write only', (assignee) => {
    expect(requiredScopes('create_task', { title: 'x', assignee }, ctx)).toEqual(['tasks:write']);
    expect(requiredScopes('update_task', { ref: '1', assignee }, ctx)).toEqual(['tasks:write']);
  });

  it.each([['bob@example.com'], ['Bob'], ['none'], ['ingen'], [''], ['Ada'], [null], [42]])(
    'assignee %j is someone else (or nobody): also tasks:assign',
    (assignee) => {
      expect(requiredScopes('create_task', { title: 'x', assignee }, ctx)).toEqual([
        'tasks:write',
        'tasks:assign',
      ]);
      expect(requiredScopes('update_task', { ref: '1', assignee }, ctx)).toEqual([
        'tasks:write',
        'tasks:assign',
      ]);
    },
  );

  it('only create_task and update_task look at the assignee', () => {
    expect(requiredScopes('complete_task', { assignee: 'bob' }, ctx)).toEqual(['tasks:write']);
  });

  it('tolerates arguments that are not an object', () => {
    expect(requiredScopes('update_task', null, ctx)).toEqual(['tasks:write']);
    expect(requiredScopes('update_task', 'x', ctx)).toEqual(['tasks:write']);
  });

  it('the unassign words win over a user named like one (agrees with resolveAssignee)', () => {
    for (const name of ['none', 'Nobody', 'ingen']) {
      const named = { userId: 'u', email: `${name}@example.com`, name };
      expect(isAssigneeMe(name, named)).toBe(false);
      expect(requiredScopes('update_task', { ref: '1', assignee: name }, named)).toEqual([
        'tasks:write',
        'tasks:assign',
      ]);
    }
  });

  it('knows the user by id alone when there is no email or name', () => {
    expect(isAssigneeMe('01A0-ME', { userId: '01a0-me' })).toBe(true);
    expect(isAssigneeMe('ada@example.com', { userId: '01a0-me' })).toBe(false);
    expect(isAssigneeMe('', { userId: '01a0-me', name: '' })).toBe(false);
  });
});

describe('tool listing (ADR 0042 §6)', () => {
  it('granted: only tools the scopes allow, with implications', () => {
    expect(listedTools({ listing: { mode: 'granted', scopes: ['tasks:read'] } })).toEqual([
      'list_orgs',
      'list_tasks',
      'get_task',
      'search_tasks',
      'list_groups',
    ]);
    const assign = listedTools({ listing: { mode: 'granted', scopes: ['tasks:assign'] } });
    expect(assign).toContain('create_task');
    expect(assign).not.toContain('delete_task');
    expect(assign).not.toContain('add_comment');
    expect(
      listedTools({ listing: { mode: 'granted', scopes: ['tasks:delete', 'notifications:read'] } }),
    ).toContain('delete_task');
  });

  it('read-only keeps the list, get and search tools only', () => {
    const tools = listedTools({
      listing: {
        mode: 'granted',
        scopes: ['tasks:delete', 'groups:write', 'comments:write', 'notifications:read'],
      },
      readOnly: true,
    });
    expect(tools).toEqual([...READ_ONLY_TOOLS]);
    expect(tools).not.toContain('delete_task');
  });

  it('step-up: everything but delete_task without tasks:delete', () => {
    const tools = listedTools({ listing: { mode: 'step-up', scopes: ['tasks:read'] } });
    expect(tools).toEqual(TOOL_NAMES.filter((t) => t !== 'delete_task'));
    expect(listedTools({ listing: { mode: 'step-up', scopes: ['tasks:delete'] } })).toEqual([
      ...TOOL_NAMES,
    ]);
  });
});
