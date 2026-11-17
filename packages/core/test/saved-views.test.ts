import { describe, expect, it } from 'vitest';
import {
  isProjectView,
  matchesSavedView,
  remapViewQuery,
  savedViewCounts,
  selectSavedView,
} from '../src/saved-views.ts';
import type { Task } from '../src/schemas/list.ts';
import { type SavedViewQuery, savedViewQuerySchema } from '../src/schemas/views.ts';

const ME = '0190a000-0000-7000-8000-000000000001';
const AMARA = '0190a000-0000-7000-8000-000000000002';
const BO = '0190a000-0000-7000-8000-000000000003';
const GONE = '0190a000-0000-7000-8000-000000000004';
const JUNIPER = '0190a000-0000-7000-8000-00000000000a';
const LAUNCH = '0190a000-0000-7000-8000-00000000000b';
const due = { today: '2026-10-05', nowMs: Date.UTC(2026, 9, 5, 8), viewerTz: 'UTC' };
const members = [
  { userId: ME, name: 'Me' },
  { userId: BO, name: 'Bo' },
  { userId: AMARA, name: 'Amara' },
];
const ctx = { viewerId: ME, due, members, locale: 'en', isPersonal: false };

function task(id: string, extra: Partial<Task> = {}): Task {
  return {
    id,
    orgId: 'org',
    seq: 1,
    parentId: null,
    subtaskPosition: null,
    title: id,
    assigneeId: ME,
    createdBy: ME,
    dueDate: null,
    dueTime: null,
    dueTz: null,
    startDate: null,
    completedAt: null,
    tagIds: [],
    hasDescription: false,
    counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
    placement: null,
    createdAt: 10,
    updatedAt: 10,
    ...extra,
  };
}

const q = (input: Partial<SavedViewQuery>): SavedViewQuery => savedViewQuerySchema.parse(input);

const tasks = [
  task('mine-late', { tagIds: [JUNIPER], dueDate: '2026-10-01' }),
  task('mine-nodate', { tagIds: [JUNIPER], createdAt: 5 }),
  task('amara-1', { tagIds: [JUNIPER, LAUNCH], assigneeId: AMARA, dueDate: '2026-10-09' }),
  task('bo-done', { tagIds: [JUNIPER], assigneeId: BO, completedAt: 9 }),
  task('loose', { tagIds: [JUNIPER], assigneeId: null }),
  task('stranger', { tagIds: [JUNIPER], assigneeId: GONE }),
  task('untagged-parent', { assigneeId: AMARA }),
  task('tagged-sub', { tagIds: [JUNIPER], parentId: 'untagged-parent', assigneeId: AMARA }),
  task('other', { tagIds: [LAUNCH] }),
  task('trashed', { tagIds: [JUNIPER], deletedAt: 3 }),
];

describe('views (ADR 0073 B)', () => {
  it('fills a query with its defaults', () => {
    expect(savedViewQuerySchema.parse({})).toEqual({
      tags: [],
      tagMode: 'any',
      assignee: 'anyone',
      due: 'any',
      status: 'open',
    });
  });

  it('groups a project view by person: me, members alphabetically, others, Unassigned', () => {
    const sections = selectSavedView(tasks, q({ tags: [JUNIPER] }), ctx);
    expect(sections.map((s) => [s.assigneeId, s.taskIds, s.openCount])).toEqual([
      [ME, ['mine-late', 'mine-nodate'], 2],
      [AMARA, ['amara-1', 'tagged-sub'], 2],
      [BO, [], 0],
      [GONE, ['stranger'], 1],
      [null, ['loose'], 1],
    ]);
    expect(isProjectView(q({ tags: [JUNIPER] }))).toBe(true);
    expect(isProjectView(q({ tags: [JUNIPER, LAUNCH] }))).toBe(false);
    expect(isProjectView(q({}))).toBe(false);
  });

  it('shows completed tasks with showCompleted, or with status done/any', () => {
    const shown = selectSavedView(tasks, q({ tags: [JUNIPER] }), { ...ctx, showCompleted: true });
    expect(shown.find((s) => s.assigneeId === BO)?.taskIds).toEqual(['bo-done']);
    const done = selectSavedView(tasks, q({ tags: [JUNIPER], status: 'done' }), ctx);
    expect(done.flatMap((s) => s.taskIds)).toEqual(['bo-done']);
    expect(
      selectSavedView(tasks, q({ tags: [JUNIPER], status: 'any' }), ctx).flatMap((s) => s.taskIds),
    ).toContain('bo-done');
  });

  it('matches tags any/all, assignee and due', () => {
    const ids = (query: SavedViewQuery) =>
      tasks.filter((t) => matchesSavedView(t, query, ctx)).map((t) => t.id);
    expect(ids(q({ tags: [JUNIPER, LAUNCH], tagMode: 'all' }))).toEqual(['amara-1']);
    expect(ids(q({ tags: [JUNIPER, LAUNCH] }))).toHaveLength(7);
    expect(ids(q({ assignee: 'me', tags: [JUNIPER] }))).toEqual(['mine-late', 'mine-nodate']);
    expect(ids(q({ assignee: 'unassigned' }))).toEqual(['loose']);
    expect(ids(q({ assignee: AMARA, tags: [LAUNCH] }))).toEqual(['amara-1']);
    expect(ids(q({ due: 'overdue' }))).toEqual(['mine-late']);
    expect(ids(q({ due: 'today' }))).toEqual(['mine-late']);
    expect(ids(q({ due: 'week' }))).toEqual(['amara-1']);
    expect(ids(q({ due: 'none', tags: [LAUNCH] }))).toEqual(['other']);
  });

  it('narrows the sections to the person a view names', () => {
    expect(selectSavedView(tasks, q({ assignee: AMARA }), ctx).map((s) => s.assigneeId)).toEqual([
      AMARA,
    ]);
    expect(selectSavedView(tasks, q({ assignee: 'me' }), ctx).map((s) => s.assigneeId)).toEqual([
      ME,
    ]);
    expect(
      selectSavedView(tasks, q({ assignee: 'unassigned' }), ctx).map((s) => s.assigneeId),
    ).toEqual([null]);
  });

  it('has one section in a personal org', () => {
    const sections = selectSavedView(tasks, q({ tags: [LAUNCH] }), { ...ctx, isPersonal: true });
    expect(sections).toEqual([{ assigneeId: ME, taskIds: ['amara-1', 'other'], openCount: 2 }]);
  });

  it('counts open and done matches, ignoring the status filter', () => {
    expect(savedViewCounts(tasks, q({ tags: [JUNIPER], status: 'done' }), ctx)).toEqual({
      open: 6,
      done: 1,
    });
  });

  it('remaps deleted and merged tags', () => {
    const query = q({ tags: [JUNIPER, LAUNCH] });
    expect(remapViewQuery(query, {})).toBe(query);
    expect(remapViewQuery(query, { deleted: [LAUNCH] }).tags).toEqual([JUNIPER]);
    expect(remapViewQuery(query, { merged: { [LAUNCH]: JUNIPER } }).tags).toEqual([JUNIPER]);
    expect(remapViewQuery(query, { merged: { [JUNIPER]: 'x' } }).tags).toEqual(['x', LAUNCH]);
  });
});
