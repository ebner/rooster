import { describe, expect, it } from 'vitest';
import {
  type ActivityFeed,
  applyCommentOp,
  type CommentContext,
  commentIdOf,
  commentTaskId,
  feedItems,
  filterComments,
  findComment,
  groupActivity,
  itemId,
  mergeCommentResponse,
} from '../src/activity.ts';
import { listOps } from '../src/reducers.ts';
import type { Activity, ActivityItem, Comment } from '../src/schemas/collab.ts';

const ME = 'u-me';
const BOB = 'u-bob';
const T = 'task-1';
const MIN = 60_000;

const comment = (id: string, createdAt: number, extra: Partial<Comment> = {}): ActivityItem => ({
  kind: 'comment',
  comment: { id, taskId: T, authorId: BOB, body: id, createdAt, editedAt: null, ...extra },
});

function act(
  id: string,
  type: Activity['type'],
  createdAt: number,
  actorId: string | null = BOB,
): ActivityItem {
  const data =
    type === 'renamed' ? { from: `${id}-from`, to: `${id}-to` } : ({} as Record<string, never>);
  return {
    kind: 'activity',
    activity: { id, taskId: T, actorId, via: 'web', createdAt, type, data } as Activity,
  };
}

describe('groupActivity (FR-COL-5)', () => {
  it('groups consecutive entries of one type by one actor within 5 minutes of the first', () => {
    const items = [
      act('a1', 'renamed', 0),
      act('a2', 'renamed', 2 * MIN),
      act('a3', 'renamed', 5 * MIN),
      act('a4', 'renamed', 6 * MIN),
      act('a5', 'renamed', 6 * MIN, ME),
      act('a6', 'completed', 6 * MIN, ME),
    ];
    const groups = groupActivity(items);
    expect(groups.map((g) => (g.kind === 'activity' ? g.entries.map((e) => e.id) : []))).toEqual([
      ['a1', 'a2', 'a3'],
      ['a4'],
      ['a5'],
      ['a6'],
    ]);
    expect(groups[0]).toMatchObject({ key: 'a1', type: 'renamed', actorId: BOB });
  });

  it('keeps comments ungrouped and in order; they break a run', () => {
    const items = [act('a1', 'completed', 0), comment('c1', 1), act('a2', 'completed', 2)];
    expect(groupActivity(items).map((g) => g.key)).toEqual(['a1', 'c1', 'a2']);
  });

  it('collapses a run of description edits by one actor however long it took', () => {
    const items = [
      act('d1', 'description_edited', 0),
      act('d2', 'description_edited', 30 * MIN),
      act('d3', 'description_edited', 31 * MIN, ME),
    ];
    const groups = groupActivity(items);
    expect(groups.map((g) => g.key)).toEqual(['d1', 'd3']);
    expect(groupActivity(items, { windowMs: 0 })).toHaveLength(2);
  });

  it('groups system entries (no actor) together', () => {
    const items = [act('s1', 'completed', 0, null), act('s2', 'completed', 1, null)];
    expect(groupActivity(items)).toHaveLength(1);
  });

  it('flattens pages oldest first and filters comments', () => {
    const feed = {
      pages: [
        { items: [comment('c3', 30), act('a4', 'completed', 40)], nextCursor: 'x' },
        { items: [act('a1', 'created', 10), comment('c2', 20)], nextCursor: null },
      ],
    };
    const items = feedItems(feed);
    expect(items.map(itemId)).toEqual(['a1', 'c2', 'c3', 'a4']);
    expect(filterComments(items).map(itemId)).toEqual(['c2', 'c3']);
    expect(feedItems({ pages: [] })).toEqual([]);
  });
});

describe('the activity cache reducer', () => {
  const ctx: CommentContext = { userId: ME, now: 1_000 };
  const feed = (): ActivityFeed => ({
    pages: [
      { items: [comment('c3', 300), act('a4', 'completed', 400)], nextCursor: 'older' },
      { items: [comment('c1', 100), comment('c2', 200)], nextCursor: null },
    ],
    pageParams: [null, 'older'],
  });
  const ids = (f: ActivityFeed) => f.pages.map((p) => p.items.map(itemId));

  it('names the task and the comment of a comment op', () => {
    expect(commentTaskId(listOps.createComment(T, { id: 'c', body: 'x' }))).toBe(T);
    expect(commentTaskId(listOps.deleteComment('c', T))).toBe(T);
    expect(commentTaskId(listOps.deleteTask(T))).toBeNull();
    expect(commentIdOf(listOps.createComment(T, { id: 'c', body: 'x' }))).toBe('c');
    expect(commentIdOf(listOps.patchComment('c', T, { body: 'y' }))).toBe('c');
    expect(commentIdOf(listOps.deleteTask(T))).toBeNull();
  });

  it('appends a created comment to the end of the newest page, once', () => {
    const op = listOps.createComment(T, { id: 'new', body: 'Hello' });
    const next = applyCommentOp(feed(), op, ctx);
    expect(ids(next)).toEqual([
      ['c3', 'a4', 'new'],
      ['c1', 'c2'],
    ]);
    expect(findComment(next, 'new')).toEqual({
      id: 'new',
      taskId: T,
      authorId: ME,
      body: 'Hello',
      createdAt: 1_000,
      editedAt: null,
    });
    expect(applyCommentOp(next, op, ctx)).toBe(next);
    const empty = { pages: [], pageParams: [] };
    expect(applyCommentOp(empty, op, ctx)).toBe(empty);
  });

  it('edits a body and marks it edited; deletes; ignores other ops', () => {
    const f = feed();
    const edited = applyCommentOp(f, listOps.patchComment('c1', T, { body: 'New' }), ctx);
    expect(findComment(edited, 'c1')).toMatchObject({ body: 'New', editedAt: 1_000 });
    expect(applyCommentOp(f, listOps.patchComment('c1', T, { body: 'c1' }), ctx)).toBe(f);
    expect(applyCommentOp(f, listOps.patchComment('zz', T, { body: 'x' }), ctx)).toBe(f);
    const deleted = applyCommentOp(f, listOps.deleteComment('c2', T), ctx);
    expect(ids(deleted)).toEqual([['c3', 'a4'], ['c1']]);
    expect(applyCommentOp(deleted, listOps.deleteComment('c2', T), ctx)).toBe(deleted);
    expect(applyCommentOp(f, listOps.deleteTask(T), ctx)).toBe(f);
  });

  it('restores a recalled comment in time order', () => {
    const f = feed();
    const c2 = findComment(f, 'c2') as Comment;
    const c3 = findComment(f, 'c3') as Comment;
    const recall = (id: string) => (id === 'c2' ? c2 : id === 'c3' ? c3 : undefined);
    const gone = applyCommentOp(f, listOps.deleteComment('c2', T), ctx);
    const flat = (x: ActivityFeed) => feedItems(x).map(itemId);
    const back = applyCommentOp(gone, listOps.restoreComment('c2', T), { ...ctx, recall });
    // Between two pages, it joins the newer one: either is in time order.
    expect(ids(back)).toEqual([['c2', 'c3', 'a4'], ['c1']]);
    expect(flat(back)).toEqual(flat(f));
    const gone3 = applyCommentOp(f, listOps.deleteComment('c3', T), ctx);
    expect(ids(applyCommentOp(gone3, listOps.restoreComment('c3', T), { ...ctx, recall }))).toEqual(
      ids(f),
    );
    // Present already, or nothing to recall: unchanged.
    expect(applyCommentOp(f, listOps.restoreComment('c2', T), { ...ctx, recall })).toBe(f);
    expect(applyCommentOp(gone, listOps.restoreComment('c2', T), ctx)).toBe(gone);
  });

  it('a restored comment older than the loaded pages waits for its page', () => {
    const partial: ActivityFeed = {
      pages: [{ items: [comment('c3', 300)], nextCursor: 'older' }],
      pageParams: [null],
    };
    const old = (comment('c0', 5) as { comment: Comment }).comment;
    const op = listOps.restoreComment('c0', T);
    expect(applyCommentOp(partial, op, { ...ctx, recall: () => old })).toBe(partial);
    const start: ActivityFeed = { pages: [{ items: [], nextCursor: null }], pageParams: [null] };
    expect(ids(applyCommentOp(start, op, { ...ctx, recall: () => old }))).toEqual([['c0']]);
  });

  it("merges the server's comment over the optimistic one", () => {
    const op = listOps.createComment(T, { id: 'new', body: 'Hi' });
    const optimistic = applyCommentOp(feed(), op, ctx);
    const dto: Comment = {
      id: 'new',
      taskId: T,
      authorId: ME,
      body: 'Hi',
      createdAt: 999,
      editedAt: null,
    };
    const merged = mergeCommentResponse(optimistic, op, dto);
    expect(findComment(merged, 'new')).toBe(dto);
    expect(ids(merged)[0]).toEqual(['c3', 'a4', 'new']);
    // Missing (a refetch raced it): inserted in time order.
    const inserted = mergeCommentResponse(feed(), op, { ...dto, createdAt: 350 });
    expect(ids(inserted)[0]).toEqual(['c3', 'new', 'a4']);
    const patch = listOps.patchComment('zz', T, { body: 'x' });
    const f = feed();
    expect(mergeCommentResponse(f, patch, { ...dto, id: 'zz' })).toBe(f);
    expect(mergeCommentResponse(f, op, undefined)).toBe(f);
    expect(mergeCommentResponse(f, listOps.deleteComment('c1', T), dto)).toBe(f);
  });
});
