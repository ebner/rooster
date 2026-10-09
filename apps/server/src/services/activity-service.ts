import { uuidv7 } from '@rooster/core/ids';
import {
  type Activity,
  type ActivityItem,
  type ActivityPage,
  type ActivityQuery,
  type ActivityVia,
  activityViaSchema,
  PAGE_LIMIT_DEFAULT,
} from '@rooster/core/schemas';
import { and, desc, eq, isNull, lt, or } from 'drizzle-orm';
import { activity, comment, task } from '../db/schema/index.ts';
import { toCommentDto } from './comment-service.ts';
import { type Actor, readOnly, type ServiceDeps, type Tx } from './context.ts';
import { compareText, decodeCursor, encodeCursor, isTimeIdCursor } from './cursor.ts';
import { authorizeTaskRead, canReadTask } from './grant-access.ts';
import { requireTask } from './list-access.ts';
import type { MemberRemovalStep } from './org-service.ts';

type ActivityType = Activity['type'];

/** One activity entry to write: the type with its typed payload. */
export type ActivityDraft = {
  [K in ActivityType]: { type: K; data: Extract<Activity, { type: K }>['data'] };
}[ActivityType];

/** Who did it and through which client; `actorId` null with `via: 'system'` for jobs. */
export interface ActivityScope {
  actorId: string | null;
  via: ActivityVia;
  /** The grant of a PAT or CLI device write (11 §2.3), kept in the entry's data. */
  grantId?: string | null;
}

/** Client kinds a request may claim in `X-Rooster-Client`; `import` and `system` are server-side. */
const CLIENT_KINDS: ReadonlySet<string> = new Set<ActivityVia>(['web', 'pwa', 'cli', 'tui', 'mcp']);

/**
 * `via` from `X-Rooster-Client` (06 §1): the kind before `/` (`cli/1.2.0` → `cli`). A missing,
 * unknown or server-only kind counts as `web`.
 */
export function viaOf(client: string | null | undefined): ActivityVia {
  const kind = client?.split('/')[0];
  return kind !== undefined && CLIENT_KINDS.has(kind) ? (kind as ActivityVia) : 'web';
}

/**
 * `via` of a write: a PAT is `pat`; a CLI device is the kind it names in `X-Rooster-Client`
 * (`cli`, `tui`, `mcp`), else `cli`; the browser session as `viaOf`.
 */
export function viaFor(actor: Actor, meta: { client: string | null } | undefined): ActivityVia {
  if (actor.grant === null) return viaOf(meta?.client);
  if (actor.grant.kind === 'pat') return 'pat';
  const via = viaOf(meta?.client);
  return via === 'web' || via === 'pwa' ? 'cli' : via;
}

type ActivityRow = typeof activity.$inferSelect;

/** Other tasks an entry names: the added subtask, the old and new parent. */
function referencedTasks(entry: Activity): string[] {
  const data = entry.data as Record<string, unknown>;
  const ids =
    entry.type === 'subtask_added'
      ? [data.subtaskId]
      : entry.type === 'moved_parent'
        ? [data.from, data.to]
        : [];
  return ids.filter((id): id is string => typeof id === 'string');
}

function toActivityDto(row: ActivityRow): Activity {
  let stored: Record<string, unknown> = {};
  try {
    const value = JSON.parse(row.data) as unknown;
    if (value !== null && typeof value === 'object') stored = value as Record<string, unknown>;
  } catch {
    // An unreadable payload shows as an entry without details.
  }
  const { via, grantId: _grantId, ...data } = stored;
  const parsed = activityViaSchema.safeParse(via);
  return {
    id: row.id,
    taskId: row.taskId,
    actorId: row.actorId,
    via: parsed.success ? parsed.data : 'web',
    createdAt: row.createdAt,
    type: row.type,
    data,
  } as Activity;
}

interface FeedEntry {
  at: number;
  id: string;
  item: ActivityItem;
}

/** The activity log (FR-COL-5): raw entries, grouped by the client. */
export class ActivityService {
  constructor(private readonly deps: ServiceDeps) {}

  /**
   * Writes one entry in the caller's transaction (`data` stores the payload plus `via`).
   * Written in personal orgs too.
   */
  record(
    tx: Tx,
    target: { id: string; orgId: string },
    scope: ActivityScope,
    entry: ActivityDraft,
  ): void {
    tx.insert(activity)
      .values({
        id: uuidv7(),
        taskId: target.id,
        orgId: target.orgId,
        actorId: scope.actorId,
        type: entry.type,
        data: JSON.stringify({
          ...entry.data,
          via: scope.via,
          ...(scope.grantId == null ? {} : { grantId: scope.grantId }),
        }),
        createdAt: this.deps.clock(),
      })
      .run();
  }

  /**
   * GET /tasks/:id/activity: live comments and (with `filter=all`, the default) activity
   * entries, merged by time. Pages go back in time: the first page is the newest items,
   * `nextCursor` continues with older ones, and each page is oldest first. A task in Trash
   * still has its feed.
   */
  feed(actor: Actor, taskId: string, query: ActivityQuery): ActivityPage {
    return readOnly(this.deps.db, (tx) => {
      const row = requireTask(tx, actor.userId, taskId);
      authorizeTaskRead(tx, actor, row);
      const limit = query.limit ?? PAGE_LIMIT_DEFAULT;
      const before = decodeCursor(query.cursor, isTimeIdCursor);
      const entries: FeedEntry[] = tx
        .select()
        .from(comment)
        .where(
          and(
            eq(comment.taskId, row.id),
            isNull(comment.deletedAt),
            before === null
              ? undefined
              : or(
                  lt(comment.createdAt, before[0]),
                  and(eq(comment.createdAt, before[0]), lt(comment.id, before[1])),
                ),
          ),
        )
        .orderBy(desc(comment.createdAt), desc(comment.id))
        .limit(limit + 1)
        .all()
        .map((c) => ({
          at: c.createdAt,
          id: c.id,
          item: { kind: 'comment', comment: toCommentDto(c) },
        }));
      if (query.filter !== 'comments') {
        for (const a of tx
          .select()
          .from(activity)
          .where(
            and(
              eq(activity.taskId, row.id),
              before === null
                ? undefined
                : or(
                    lt(activity.createdAt, before[0]),
                    and(eq(activity.createdAt, before[0]), lt(activity.id, before[1])),
                  ),
            ),
          )
          .orderBy(desc(activity.createdAt), desc(activity.id))
          .limit(limit + 1)
          .all()) {
          entries.push({
            at: a.createdAt,
            id: a.id,
            item: { kind: 'activity', activity: toActivityDto(a) },
          });
        }
      }
      entries.sort((a, b) => b.at - a.at || compareText(b.id, a.id));
      const page = entries.slice(0, limit);
      const oldest = page[page.length - 1];
      // Entries naming another task (a subtask added, a move between parents) are left out
      // when the grant cannot read that task; the cursor still follows the whole page.
      const readable = (id: string) => {
        const other = tx
          .select({ id: task.id, parentId: task.parentId, orgId: task.orgId, title: task.title })
          .from(task)
          .where(eq(task.id, id))
          .get();
        return other !== undefined && canReadTask(tx, actor, other);
      };
      const shown = (e: FeedEntry) =>
        actor.grant === null ||
        e.item.kind !== 'activity' ||
        referencedTasks(e.item.activity).every(readable);
      return {
        items: page
          .reverse()
          .filter(shown)
          .map((e) => e.item),
        nextCursor:
          entries.length > limit && oldest !== undefined
            ? encodeCursor([oldest.at, oldest.id])
            : null,
      };
    });
  }

  /**
   * Member removal (05 §4.2): an `assigned` entry (`via: system`, no actor) for every task
   * the leaving member was assigned in the org. Runs before the unassignment step.
   */
  readonly memberRemovalStep: MemberRemovalStep = (tx, { orgId, userId }) => {
    const ids = tx
      .select({ id: task.id })
      .from(task)
      .where(and(eq(task.orgId, orgId), eq(task.assigneeId, userId)))
      .all();
    for (const { id } of ids) {
      this.record(
        tx,
        { id, orgId },
        { actorId: null, via: 'system' },
        { type: 'assigned', data: { from: userId, to: null } },
      );
    }
  };
}
