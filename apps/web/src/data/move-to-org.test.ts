import { BULK_MAX } from '@rooster/core/limits';
import type { TaskMoveToOrgPreview } from '@rooster/core/schemas';
import { afterEach, describe, expect, test, vi } from 'vitest';
import { api } from './http';
import { fetchMoveToOrgPreview } from './move-to-org';

const part = (over: Partial<TaskMoveToOrgPreview>): TaskMoveToOrgPreview => ({
  tasks: 0,
  subtasks: 0,
  comments: 0,
  attachments: 0,
  exposes: false,
  newTags: [],
  reassigned: 0,
  ...over,
});

afterEach(() => vi.restoreAllMocks());

describe('ADR 0072 the move preview', () => {
  test('a selection above the endpoint limit is previewed in chunks and added up', async () => {
    const answers = [
      part({ tasks: BULK_MAX, comments: 2, newTags: ['Client'], reassigned: 1 }),
      part({ tasks: 5, attachments: 1, exposes: true, newTags: ['client', 'Fresh'] }),
    ];
    const get = vi.spyOn(api, 'GET').mockImplementation((async () => ({
      data: answers.shift(),
      error: undefined,
      response: new Response(null, { status: 200 }),
    })) as never);
    const ids = Array.from({ length: BULK_MAX + 5 }, (_, i) => `id-${String(i).padStart(4, '0')}`);
    const preview = await fetchMoveToOrgPreview(ids, 'org-2');
    expect(get).toHaveBeenCalledTimes(2);
    const sent = get.mock.calls.map((call) =>
      (call[1] as { params: { query: { ids: string } } }).params.query.ids.split(','),
    );
    expect(sent.map((chunk) => chunk.length)).toEqual([BULK_MAX, 5]);
    expect(new Set(sent.flat()).size).toBe(BULK_MAX + 5);
    expect(preview).toEqual({
      tasks: BULK_MAX + 5,
      subtasks: 0,
      comments: 2,
      attachments: 1,
      exposes: true,
      newTags: ['Client', 'Fresh'],
      reassigned: 1,
    });
  });

  test('up to the limit it is one request', async () => {
    const get = vi.spyOn(api, 'GET').mockImplementation((async () => ({
      data: part({ tasks: 2 }),
      error: undefined,
      response: new Response(null, { status: 200 }),
    })) as never);
    expect((await fetchMoveToOrgPreview(['b', 'a', 'a'], 'org-2')).tasks).toBe(2);
    expect(get).toHaveBeenCalledTimes(1);
    expect(get.mock.calls[0]?.[1]).toMatchObject({
      params: { query: { ids: 'a,b', orgId: 'org-2' } },
    });
  });
});
