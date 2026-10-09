import type { Task } from '@rooster/core/schemas';
import { describe, expect, test } from 'vitest';
import { memberHandle, resolveAssigneeToken, suggestMembers } from './assignee-token';
import { everyoneSections, memberSectionId, sectionAssignee } from './everyone-model';
import { buildEveryoneRows } from './everyone-rows';
import { memberOptions, type Person, sortMembers } from './members';

const me = '01900000-0000-7000-8000-000000000001';
const anna = '01900000-0000-7000-8000-000000000002';
const annika = '01900000-0000-7000-8000-000000000003';
const bob = '01900000-0000-7000-8000-000000000004';

const people: Person[] = [
  { userId: bob, name: 'Bob Marsh', email: 'bob@example.com', image: null },
  { userId: annika, name: 'Annika Berg', email: 'annika@example.com', image: null },
  { userId: me, name: 'Zoe Me', email: 'zoe@example.com', image: null },
  { userId: anna, name: 'Anna Lindqvist', email: 'al@example.com', image: null },
];

function task(id: string, overrides: Partial<Task> = {}): Task {
  return {
    id,
    orgId: 'org',
    seq: 1,
    parentId: null,
    subtaskPosition: null,
    title: id,
    assigneeId: me,
    createdBy: me,
    dueDate: null,
    dueTime: null,
    dueTz: null,
    startDate: null,
    completedAt: null,
    tagIds: [],
    hasDescription: false,
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: null,
    createdAt: 0,
    updatedAt: 0,
    ...overrides,
  };
}

describe('members', () => {
  test('me first, then alphabetically by name', () => {
    expect(sortMembers(people, me).map((m) => m.name)).toEqual([
      'Zoe Me',
      'Anna Lindqvist',
      'Annika Berg',
      'Bob Marsh',
    ]);
  });

  test('the picker lists Unassigned first; a query filters by name, word or e-mail', () => {
    expect(memberOptions(people, me, '', 'Unassigned').map((o) => o.userId)).toEqual([
      null,
      me,
      anna,
      annika,
      bob,
    ]);
    expect(memberOptions(people, me, 'lind', 'Unassigned').map((o) => o.userId)).toEqual([anna]);
    expect(memberOptions(people, me, 'ann', 'Unassigned').map((o) => o.userId)).toEqual([
      anna,
      annika,
    ]);
    expect(memberOptions(people, me, 'una', 'Unassigned').map((o) => o.userId)).toEqual([null]);
    expect(memberOptions(people, me, 'xyz', 'Unassigned')).toEqual([]);
  });
});

describe('@name token (core findAssigneeToken)', () => {
  test('a unique name or prefix assigns; an ambiguous one stays text', () => {
    expect(resolveAssigneeToken('Call @anna', people, me)?.userId).toBe(anna);
    expect(resolveAssigneeToken('Call @"Annika Berg"', people, me)?.userId).toBe(annika);
    expect(resolveAssigneeToken('Call @bo tomorrow', people, me)?.userId).toBe(bob);
    expect(resolveAssigneeToken('Call @me', people, me)?.userId).toBe(me);
    expect(resolveAssigneeToken('Call @ann', people, me)).toBeNull();
    expect(resolveAssigneeToken('Call @nobody', people, me)).toBeNull();
    expect(resolveAssigneeToken('Call @anna', [], me)).toBeNull();
    expect(resolveAssigneeToken('Call @anna', people, me, [{ start: 5, end: 10 }])).toBeNull();
  });

  test('suggestions rank by core; the inserted handle resolves to the member', () => {
    expect(suggestMembers('ann', sortMembers(people, me), me).map((m) => m.userId)).toEqual([
      anna,
      annika,
    ]);
    const handle = memberHandle(people[3] as Person, people);
    expect(handle).toBe('@Anna');
    expect(resolveAssigneeToken(`Ask ${handle}`, people, me)?.userId).toBe(anna);
    const clash = [...people, { userId: 'x', name: 'Anna Berg', email: 'ab@x', image: null }];
    const quoted = memberHandle(people[3] as Person, clash);
    expect(quoted).toBe('@"Anna Lindqvist"');
    expect(resolveAssigneeToken(`Ask ${quoted}`, clash, me)?.userId).toBe(anna);
  });
});

describe("Everyone's tasks", () => {
  test('section ids round-trip their assignee', () => {
    expect(sectionAssignee(memberSectionId(anna))).toBe(anna);
    expect(sectionAssignee(memberSectionId(null))).toBeNull();
    expect(sectionAssignee('today')).toBeUndefined();
    expect(sectionAssignee(undefined)).toBeUndefined();
  });

  const due = { today: '2026-10-09', nowMs: Date.UTC(2026, 9, 9, 10), viewerTz: 'UTC' };
  const tasks = [
    task('a-late', { assigneeId: anna, dueDate: '2026-10-01', createdAt: 5 }),
    task('a-none', { assigneeId: anna, createdAt: 1 }),
    task('a-soon', { assigneeId: anna, dueDate: '2026-10-10', createdAt: 2 }),
    task('mine', { dueDate: '2026-10-09' }),
    task('loose', { assigneeId: null }),
    task('done', { assigneeId: anna, completedAt: 3 }),
  ];
  const ctx = {
    viewerId: me,
    members: people,
    locale: 'en',
    filters: { due: 'any' as const, members: [] },
    tagIds: [],
    due,
    showCompleted: false,
  };

  test('me first, members alphabetically, Unassigned last; rows by due date (none last)', () => {
    const sections = everyoneSections(tasks, ctx);
    expect(sections.map((s) => s.assigneeId)).toEqual([me, anna, annika, bob, null]);
    expect(sections.map((s) => s.taskIds)).toEqual([
      ['mine'],
      ['a-late', 'a-soon', 'a-none'],
      [],
      [],
      ['loose'],
    ]);
    expect(sections[1]?.member?.name).toBe('Anna Lindqvist');
    expect(sections[1]?.id).toBe(memberSectionId(anna));
  });

  test('completed tasks stay only while their completion holds', () => {
    const sections = everyoneSections(tasks, { ...ctx, keep: { done: 'hold' } });
    expect(sections[1]?.taskIds).toContain('done');
  });

  test('the member and due filters narrow the sections and rows', () => {
    const sections = everyoneSections(tasks, {
      ...ctx,
      filters: { due: 'overdue', members: [anna, null] },
    });
    expect(sections.map((s) => [s.assigneeId, s.taskIds])).toEqual([
      [anna, ['a-late']],
      [null, []],
    ]);
  });

  test('rows: a member header, the rows with breadcrumbs, drafts and "+ Add task"', () => {
    const child = task('child', { assigneeId: anna, parentId: 'mine' });
    const sections = everyoneSections([...tasks, child], ctx);
    const rows = buildEveryoneRows(sections.slice(0, 2), {
      tasks: Object.fromEntries([...tasks, child].map((t) => [t.id, t])),
      drafts: [{ id: 'draft', groupId: 'inbox', afterId: 'a-late', sectionId: sections[1]?.id }],
      draftTask: () => task('draft'),
      inboxId: 'inbox',
    });
    expect(rows.map((r) => r.id)).toEqual([
      `section:${memberSectionId(me)}`,
      'mine',
      `add:section:${memberSectionId(me)}`,
      `section:${memberSectionId(anna)}`,
      'a-late',
      'draft',
      'a-soon',
      'child',
      'a-none',
      `add:section:${memberSectionId(anna)}`,
    ]);
    const header = rows[3];
    expect(header?.kind === 'section' && [header.assigneeId, header.count]).toEqual([anna, 4]);
    const childRow = rows.find((r) => r.id === 'child');
    expect(childRow?.kind === 'task' && childRow.breadcrumb).toBe('mine');
  });
});
