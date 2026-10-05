import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/ids.ts';
import {
  bulkOpSchema,
  groupCreateSchema,
  groupDeleteSchema,
  groupPatchSchema,
  myListSchema,
  taskCreateSchema,
  taskMoveSchema,
  taskPatchSchema,
} from '../src/schemas/list.ts';

const id = () => uuidv7();

describe('list schemas', () => {
  it('trims and strips control characters from titles', () => {
    const parsed = taskCreateSchema.parse({ title: '  Buy\tmilk  ' });
    expect(parsed.title).toBe('Buymilk');
  });

  it('rejects empty and over-long titles', () => {
    expect(taskCreateSchema.safeParse({ title: '   ' }).success).toBe(false);
    expect(taskCreateSchema.safeParse({ title: 'x'.repeat(501) }).success).toBe(false);
  });

  it('requires a date and timezone with a due time', () => {
    expect(taskCreateSchema.safeParse({ title: 'a', dueTime: '14:00' }).success).toBe(false);
    expect(
      taskCreateSchema.safeParse({ title: 'a', dueDate: '2026-10-10', dueTime: '14:00' }).success,
    ).toBe(false);
    expect(
      taskCreateSchema.safeParse({
        title: 'a',
        dueDate: '2026-10-10',
        dueTime: '14:00',
        dueTz: 'Europe/Stockholm',
      }).success,
    ).toBe(true);
  });

  it('requires a due date for a start date, not after it', () => {
    expect(taskPatchSchema.safeParse({ startDate: '2026-10-10' }).success).toBe(false);
    expect(
      taskPatchSchema.safeParse({ dueDate: '2026-10-09', startDate: '2026-10-10' }).success,
    ).toBe(false);
    expect(
      taskPatchSchema.safeParse({ dueDate: '2026-10-12', startDate: '2026-10-10' }).success,
    ).toBe(true);
  });

  it('rejects impossible calendar dates', () => {
    expect(taskCreateSchema.safeParse({ title: 'a', dueDate: '2026-02-30' }).success).toBe(false);
  });

  it('rejects empty patches but accepts clearing the due date', () => {
    expect(taskPatchSchema.safeParse({}).success).toBe(false);
    expect(taskPatchSchema.safeParse({ dueDate: null }).success).toBe(true);
    expect(taskPatchSchema.safeParse({ dueTime: '09:00' }).success).toBe(false);
  });

  it('accepts ordering intents with nulls', () => {
    expect(taskMoveSchema.parse({ groupId: id(), afterId: null, beforeId: id() })).toBeTruthy();
    expect(groupCreateSchema.parse({ name: 'Today', afterId: id() }).name).toBe('Today');
  });

  it('validates group patch and delete bodies', () => {
    expect(groupPatchSchema.safeParse({}).success).toBe(false);
    expect(groupPatchSchema.safeParse({ collapsed: true }).success).toBe(true);
    expect(groupDeleteSchema.safeParse({ deleteTasks: true }).success).toBe(true);
    expect(groupDeleteSchema.safeParse({ deleteTasks: false }).success).toBe(false);
  });

  it('discriminates bulk operations', () => {
    expect(bulkOpSchema.safeParse({ op: 'complete', ids: [id()] }).success).toBe(true);
    expect(bulkOpSchema.safeParse({ op: 'complete', ids: [] }).success).toBe(false);
    expect(
      bulkOpSchema.safeParse({ op: 'move', ids: [id()], args: { groupId: id() } }).success,
    ).toBe(true);
    expect(
      bulkOpSchema.safeParse({ op: 'setDue', ids: [id()], args: { dueTime: '10:00' } }).success,
    ).toBe(false);
    expect(bulkOpSchema.safeParse({ op: 'explode', ids: [id()] }).success).toBe(false);
  });

  it('parses a my-list payload', () => {
    const orgId = id();
    const groupId = id();
    const parsed = myListSchema.parse({
      groups: [
        { id: groupId, orgId, kind: 'inbox', name: 'Inbox', position: 'a0', collapsed: false },
      ],
      tasks: [
        {
          id: id(),
          orgId,
          seq: 1,
          parentId: null,
          subtaskPosition: null,
          title: 'Buy milk',
          assigneeId: id(),
          createdBy: id(),
          dueDate: null,
          dueTime: null,
          dueTz: null,
          startDate: null,
          completedAt: null,
          tagIds: [],
          counts: { subtasks: 0, subtasksDone: 0, comments: 0, attachments: 0 },
          placement: { groupId, position: 'a0' },
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      expandedTaskIds: [],
      serverTime: 1,
    });
    expect(parsed.tasks).toHaveLength(1);
  });
});

describe('sse schemas', () => {
  it('validates invalidate and hello events', async () => {
    const { sseInvalidateSchema, sseHelloSchema } = await import('../src/schemas/events.ts');
    expect(
      sseInvalidateSchema.safeParse({ org: id(), keys: [['my-list', id()]], origin: null }).success,
    ).toBe(true);
    expect(sseInvalidateSchema.safeParse({ org: null, keys: [], origin: null }).success).toBe(
      false,
    );
    expect(
      sseHelloSchema.safeParse({ version: '0.1.0', gitSha: 'dev', serverTime: 1 }).success,
    ).toBe(true);
  });
});
