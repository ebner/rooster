import type { ApplyContext } from './reducers/apply.ts';
import type { ListOpSpec } from './reducers/ops.ts';
import type {
  Activity,
  ActivityItem,
  ActivityPage,
  ActivityType,
  Comment,
} from './schemas/collab.ts';

/**
 * The task feed of the detail pane (02 §9.2, FR-COL-5): comments interleaved with activity.
 * Pure helpers for rendering it and for keeping the `['activity', taskId]` cache optimistic.
 *
 * The cache is TanStack's `InfiniteData<ActivityPage>`: `pages[0]` is the newest page (fetched
 * without a cursor), later pages are older, and each page's items are oldest first (06 §2.6).
 */

/** Structurally TanStack's `InfiniteData<ActivityPage, string | null>`. */
export interface ActivityFeed {
  pages: ActivityPage[];
  pageParams: unknown[];
}

/** Every loaded item, oldest first. */
export function feedItems(feed: Pick<ActivityFeed, 'pages'>): ActivityItem[] {
  const out: ActivityItem[] = [];
  for (let i = feed.pages.length - 1; i >= 0; i--) out.push(...(feed.pages[i]?.items ?? []));
  return out;
}

/** The "Comments only" toggle. */
export function filterComments(items: readonly ActivityItem[]): ActivityItem[] {
  return items.filter((item) => item.kind === 'comment');
}

export function itemTime(item: ActivityItem): number {
  return item.kind === 'comment' ? item.comment.createdAt : item.activity.createdAt;
}

export function itemId(item: ActivityItem): string {
  return item.kind === 'comment' ? item.comment.id : item.activity.id;
}

/** One rendered entry of the feed. */
export type FeedEntry =
  | { kind: 'comment'; key: string; comment: Comment }
  | {
      kind: 'activity';
      /** The first entry's ID (stable while the group grows). */
      key: string;
      type: ActivityType;
      actorId: string | null;
      /** At least one, oldest first. A grouped `renamed` reads from the first's `from` to the last's `to`. */
      entries: Activity[];
    };

export interface GroupActivityOptions {
  /** FR-COL-5: entries of the same kind by the same actor within this window are grouped. */
  windowMs?: number;
}

export const ACTIVITY_GROUP_WINDOW_MS = 5 * 60_000;

/**
 * Groups consecutive activity entries (FR-COL-5): the same `type` by the same actor, each within
 * `windowMs` of the group's first entry. Comments are never grouped and break a run, so the
 * feed keeps its time order. `description_edited` is collapsed: a run of edits by one actor is
 * one entry however long it took (each autosave would otherwise be a line).
 */
export function groupActivity(
  items: readonly ActivityItem[],
  options: GroupActivityOptions = {},
): FeedEntry[] {
  const windowMs = options.windowMs ?? ACTIVITY_GROUP_WINDOW_MS;
  const out: FeedEntry[] = [];
  for (const item of items) {
    if (item.kind === 'comment') {
      out.push({ kind: 'comment', key: item.comment.id, comment: item.comment });
      continue;
    }
    const entry = item.activity;
    const last = out.at(-1);
    if (
      last?.kind === 'activity' &&
      last.type === entry.type &&
      last.actorId === entry.actorId &&
      (entry.type === 'description_edited' ||
        entry.createdAt - (last.entries[0] as Activity).createdAt <= windowMs)
    ) {
      last.entries.push(entry);
      continue;
    }
    out.push({
      kind: 'activity',
      key: entry.id,
      type: entry.type,
      actorId: entry.actorId,
      entries: [entry],
    });
  }
  return out;
}

// ---------------------------------------------------------------------------------------------
// The optimistic reducer for the `['activity', taskId]` cache
// ---------------------------------------------------------------------------------------------

export interface CommentContext extends ApplyContext {
  /** A comment this cache lost to a delete (the pipeline remembers it), for an undo. */
  recall?: ((commentId: string) => Comment | undefined) | undefined;
}

/** The task whose feed a comment op changes (null for other ops). */
export function commentTaskId(op: ListOpSpec): string | null {
  switch (op.kind) {
    case 'comment.create':
      return op.entityId;
    case 'comment.patch':
    case 'comment.delete':
    case 'comment.restore':
      return op.taskId;
    default:
      return null;
  }
}

/** The comment a comment op is about (null for other ops). */
export function commentIdOf(op: ListOpSpec): string | null {
  if (op.kind === 'comment.create') return op.payload.id;
  return commentTaskId(op) === null ? null : op.entityId;
}

/** The loaded comment with this ID, if any. */
export function findComment(feed: Pick<ActivityFeed, 'pages'>, id: string): Comment | undefined {
  for (const page of feed.pages) {
    for (const item of page.items) {
      if (item.kind === 'comment' && item.comment.id === id) return item.comment;
    }
  }
  return undefined;
}

/**
 * Applies one comment op to a feed (other ops, and ops on other tasks' feeds, return it
 * unchanged): a create is appended to the newest page, a patch edits the body and marks it
 * edited, a delete removes the comment and a restore puts the recalled comment back in time
 * order. Idempotent, so queued ops can be replayed over a refetched feed.
 */
export function applyCommentOp<F extends ActivityFeed>(
  feed: F,
  op: ListOpSpec,
  ctx: CommentContext,
): F {
  switch (op.kind) {
    case 'comment.create': {
      const newest = feed.pages[0];
      if (!newest || findComment(feed, op.payload.id)) return feed;
      const comment: Comment = {
        id: op.payload.id,
        taskId: op.entityId,
        authorId: ctx.userId,
        body: op.payload.body,
        createdAt: ctx.now,
        editedAt: null,
      };
      const items = [...newest.items, { kind: 'comment' as const, comment }];
      return withPages(feed, [{ ...newest, items }, ...feed.pages.slice(1)]);
    }
    case 'comment.patch': {
      const body = op.payload.body;
      return mapComment(feed, op.entityId, (c) =>
        c.body === body ? c : { ...c, body, editedAt: ctx.now },
      );
    }
    case 'comment.delete': {
      let changed = false;
      const pages = feed.pages.map((page) => {
        const items = page.items.filter(
          (item) => item.kind !== 'comment' || item.comment.id !== op.entityId,
        );
        if (items.length === page.items.length) return page;
        changed = true;
        return { ...page, items };
      });
      return changed ? withPages(feed, pages) : feed;
    }
    case 'comment.restore': {
      if (findComment(feed, op.entityId)) return feed;
      const comment = ctx.recall?.(op.entityId);
      return comment ? insertComment(feed, comment) : feed;
    }
    default:
      return feed;
  }
}

const isComment = (v: unknown): v is Comment =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Comment).id === 'string' &&
  typeof (v as Comment).body === 'string' &&
  typeof (v as Comment).createdAt === 'number';

/**
 * Merges the server's CommentDTO into a feed the op was applied to: it replaces the optimistic
 * comment (its `createdAt` and `editedAt` are the server's). A create or restore whose comment
 * is missing (the optimistic apply found no feed, or a refetch raced it) is inserted.
 */
export function mergeCommentResponse<F extends ActivityFeed>(
  feed: F,
  op: ListOpSpec,
  response: unknown,
): F {
  if (!isComment(response)) return feed;
  switch (op.kind) {
    case 'comment.create':
    case 'comment.restore':
    case 'comment.patch': {
      if (!findComment(feed, response.id)) {
        return op.kind === 'comment.patch' ? feed : insertComment(feed, response);
      }
      // A create keeps its optimistic spot: the server's `createdAt` may sort it a little
      // earlier, but moving it under the user's eyes is worse; a refetch settles it.
      return mapComment(feed, response.id, () => response);
    }
    default:
      return feed;
  }
}

function withPages<F extends ActivityFeed>(feed: F, pages: ActivityPage[]): F {
  return { ...feed, pages };
}

function mapComment<F extends ActivityFeed>(
  feed: F,
  id: string,
  update: (comment: Comment) => Comment,
): F {
  let changed = false;
  const pages = feed.pages.map((page) => {
    let pageChanged = false;
    const items = page.items.map((item) => {
      if (item.kind !== 'comment' || item.comment.id !== id) return item;
      const comment = update(item.comment);
      if (comment === item.comment) return item;
      pageChanged = true;
      return { ...item, comment };
    });
    if (!pageChanged) return page;
    changed = true;
    return { ...page, items };
  });
  return changed ? withPages(feed, pages) : feed;
}

const compareItems = (a: ActivityItem, b: ActivityItem) =>
  itemTime(a) - itemTime(b) || (itemId(a) < itemId(b) ? -1 : itemId(a) > itemId(b) ? 1 : 0);

/**
 * Puts a comment back in time order: into the newest page it is not older than, or at the
 * front of a page when it falls between that page and the next older one. Older than
 * everything loaded, it goes to the oldest page only when that page is the start of the feed;
 * otherwise it belongs to a page not loaded yet.
 */
function insertComment<F extends ActivityFeed>(feed: F, comment: Comment): F {
  const item: ActivityItem = { kind: 'comment', comment };
  const notAfter = (other: ActivityItem | undefined) =>
    other !== undefined && compareItems(other, item) <= 0;
  let index = feed.pages.findIndex(
    (page, i) => notAfter(page.items[0]) || notAfter(feed.pages[i + 1]?.items.at(-1)),
  );
  if (index < 0) {
    const last = feed.pages.length - 1;
    if (last < 0 || feed.pages[last]?.nextCursor !== null) return feed;
    index = last;
  }
  const page = feed.pages[index] as ActivityPage;
  const at = page.items.findIndex((other) => compareItems(item, other) < 0);
  const items =
    at < 0 ? [...page.items, item] : [...page.items.slice(0, at), item, ...page.items.slice(at)];
  const pages = [...feed.pages];
  pages[index] = { ...page, items };
  return withPages(feed, pages);
}
