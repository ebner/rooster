import { todayIn } from '@rooster/core/dates';
import { compareRows } from '@rooster/core/everyone';
import { uuidv7 } from '@rooster/core/ids';
import { compareKeys, generateNKeysBetween, rebalanceKeys } from '@rooster/core/ordering';
import {
  matchesSavedView,
  matchesViewFilters,
  remapViewQuery,
  type SavedViewContext,
  savedViewCounts,
} from '@rooster/core/saved-views';
import {
  type SavedView,
  type SavedViewCreate,
  type SavedViewListQuery,
  type SavedViewMove,
  type SavedViewPatch,
  type SavedViewQuery,
  type SavedViewTasks,
  type SavedViewTasksQuery,
  savedViewQuerySchema,
  type Task,
} from '@rooster/core/schemas';
import { and, asc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';
import {
  member,
  organization,
  savedView,
  savedViewPref,
  tag,
  task,
  taskTag,
  user,
} from '../db/schema/index.ts';
import type { Audience, DomainEventType } from '../events/bus.ts';
import { AppError, type FieldError } from '../lib/errors.ts';
import {
  type Actor,
  emitAfterCommit,
  immediate,
  type OpMeta,
  readOnly,
  type ServiceDeps,
  type Tx,
} from './context.ts';
import { memberIds, qk, selfAudience } from './event-audience.ts';
import { authorizeOrg, authorizeOrgWide, grantReachesOrg, readFilter } from './grant-access.ts';
import { isMember, type TaskExtras, type TaskRow, taskDtos, toTaskDto } from './list-access.ts';
import type { OrderingService, OrderTarget } from './ordering-service.ts';
import { requireMembership } from './org-access.ts';
import type { MemberRemovalStep } from './org-service.ts';

export type ViewRow = typeof savedView.$inferSelect;

const viewNotFound = () => new AppError('not_found', 404, 'View not found.');
const idConflict = () => new AppError('id_conflict', 409, 'That ID is already in use.');

/**
 * Bounded work (ADR 0056): an org holds at most this many shared views, and each member at most
 * this many private ones in it, archived ones included (the archived list is counted too). A
 * list request then counts at most 2 × VIEW_LIMIT views over the org's tasks.
 */
export const VIEW_LIMIT = 100;

const viewLimit = (shared: boolean) =>
  new AppError(
    'view_limit',
    409,
    shared
      ? `An organisation can have at most ${VIEW_LIMIT} shared views (archived ones included); delete some first.`
      : `You can have at most ${VIEW_LIMIT} private views in an organisation (archived ones included); delete some first.`,
  );

/** `409 view_limit` when the bucket a view is about to join (shared, or `ownerId`'s private) is full. */
function requireRoom(tx: Tx, orgId: string, shared: boolean, ownerId: string): void {
  const row = tx
    .select({ n: sql<number>`count(*)` })
    .from(savedView)
    .where(
      and(
        eq(savedView.orgId, orgId),
        shared
          ? eq(savedView.shared, true)
          : and(eq(savedView.shared, false), eq(savedView.createdBy, ownerId)),
      ),
    )
    .get();
  if ((row?.n ?? 0) >= VIEW_LIMIT) throw viewLimit(shared);
}

/** A view's stored query; one that no longer parses reads as the defaults (never a 500). */
function parseQuery(raw: string): SavedViewQuery {
  try {
    const parsed = savedViewQuerySchema.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    // Falls through to the defaults.
  }
  return savedViewQuerySchema.parse({});
}

/** The stored form: schema defaults applied, tags deduplicated, keys in schema order. */
function normaliseQuery(query: SavedViewQuery): SavedViewQuery {
  return savedViewQuerySchema.parse({ ...query, tags: [...new Set(query.tags)] });
}

/** Shared views of the org, and the actor's own private ones. */
const visibleTo = (userId: string) =>
  or(eq(savedView.shared, true), eq(savedView.createdBy, userId));

/** A view in an actor's order: its key, and whether that key is stored (`saved_view_pref`). */
interface Placed {
  row: ViewRow;
  position: string;
  stored: boolean;
}

/**
 * The views the user sees in an org, in their own order. Live views: the ones with a stored
 * key by key, then the rest (a shared view another member created, never ordered by this one)
 * after them in created order, with keys generated after the last stored one, so the order the
 * user sees is the one a later move materialises. Archived views: newest archive first, with
 * keys only to fill the field.
 */
function orderedViews(tx: Tx, userId: string, orgId: string, archived: boolean): Placed[] {
  const rows = tx
    .select({ view: savedView, position: savedViewPref.position })
    .from(savedView)
    .leftJoin(
      savedViewPref,
      and(eq(savedViewPref.viewId, savedView.id), eq(savedViewPref.userId, userId)),
    )
    .where(
      and(
        eq(savedView.orgId, orgId),
        archived ? isNotNull(savedView.archivedAt) : isNull(savedView.archivedAt),
        visibleTo(userId),
      ),
    )
    .all();
  if (archived) {
    rows.sort(
      (a, b) =>
        (b.view.archivedAt ?? 0) - (a.view.archivedAt ?? 0) || compareKeys(a.view.id, b.view.id),
    );
    const keys = rebalanceKeys(rows.length);
    return rows.map((r, i) => ({ row: r.view, position: keys[i] as string, stored: false }));
  }
  const stored = rows
    .filter((r): r is { view: ViewRow; position: string } => r.position !== null)
    .sort((a, b) => compareKeys(a.position, b.position) || compareKeys(a.view.id, b.view.id));
  const unstored = rows
    .filter((r) => r.position === null)
    .sort((a, b) => a.view.createdAt - b.view.createdAt || compareKeys(a.view.id, b.view.id));
  let keys: string[] | null = null;
  try {
    keys = generateNKeysBetween(stored.at(-1)?.position ?? null, null, unstored.length);
  } catch {
    // A malformed stored key: every view gets a fresh key (a move stores them, repairing it).
    keys = null;
  }
  if (keys === null) {
    const all = [...stored.map((r) => r.view), ...unstored.map((r) => r.view)];
    const fresh = rebalanceKeys(all.length);
    return all.map((row, i) => ({ row, position: fresh[i] as string, stored: false }));
  }
  return [
    ...stored.map((r) => ({ row: r.view, position: r.position, stored: true })),
    ...unstored.map((r, i) => ({ row: r.view, position: keys[i] as string, stored: false })),
  ];
}

function writePref(tx: Tx, userId: string, viewId: string, position: string): void {
  tx.insert(savedViewPref)
    .values({ userId, viewId, position })
    .onConflictDoUpdate({
      target: [savedViewPref.userId, savedViewPref.viewId],
      set: { position },
    })
    .run();
}

/** Stores the keys of the views the user has never ordered, so the domain is complete. */
function materialise(tx: Tx, userId: string, placed: readonly Placed[]): void {
  for (const p of placed) if (!p.stored) writePref(tx, userId, p.row.id, p.position);
}

/**
 * The org's live tasks the actor may read, as task DTOs carrying what the view matcher reads
 * (tags, assignee, dates, completion). Two queries whatever the size of the org; a grant that
 * reads only some groups filters them in memory (`readFilter`, as every list read).
 */
function readableOrgTasks(tx: Tx, actor: Actor, orgId: string): { rows: TaskRow[]; tasks: Task[] } {
  let rows = tx
    .select()
    .from(task)
    .where(and(eq(task.orgId, orgId), isNull(task.deletedAt)))
    .all();
  const readable = readFilter(tx, actor, orgId, rows);
  if (readable !== null) rows = rows.filter(readable);
  const extras: TaskExtras = {
    tagIds: new Map(),
    counts: new Map(),
    comments: new Map(),
    attachments: new Map(),
    nextReminderAt: new Map(),
  };
  for (const t of tx
    .select({ taskId: taskTag.taskId, tagId: taskTag.tagId })
    .from(taskTag)
    .innerJoin(task, eq(task.id, taskTag.taskId))
    .where(and(eq(task.orgId, orgId), isNull(task.deletedAt)))
    .orderBy(asc(taskTag.addedAt), sql`${taskTag}.rowid`)
    .all()) {
    const list = extras.tagIds.get(t.taskId);
    if (list === undefined) extras.tagIds.set(t.taskId, [t.tagId]);
    else list.push(t.tagId);
  }
  return { rows, tasks: rows.map((r) => toTaskDto(r, null, {}, extras)) };
}

const DUE_ONLY = savedViewQuerySchema.parse({ status: 'any' });

/**
 * Open/done counts of many views over the same tasks. Each task's due buckets (today, week,
 * overdue, none) are classified once per filter in use, with core's matcher on a query that
 * filters only by due; each view then checks only tags, assignee and completion (core's matcher
 * with `due: 'any'`, which skips the date work). The result equals `savedViewCounts`.
 */
function viewCounter(
  tasks: readonly Task[],
  ctx: SavedViewContext,
): (query: SavedViewQuery) => { open: number; done: number } {
  const buckets = new Map<SavedViewQuery['due'], Uint8Array>();
  const inBucket = (due: SavedViewQuery['due']): Uint8Array => {
    let hits = buckets.get(due);
    if (hits === undefined) {
      const query = { ...DUE_ONLY, due };
      hits = Uint8Array.from(tasks, (t) => (matchesViewFilters(t, query, ctx) ? 1 : 0));
      buckets.set(due, hits);
    }
    return hits;
  };
  return (query) => {
    const due = query.due === 'any' ? null : inBucket(query.due);
    const rest = query.due === 'any' ? query : { ...query, due: 'any' as const };
    const counts = { open: 0, done: 0 };
    tasks.forEach((t, i) => {
      if (due !== null && due[i] === 0) return;
      if (!matchesViewFilters(t, rest, ctx)) return;
      if (t.completedAt === null) counts.open++;
      else counts.done++;
    });
    return counts;
  };
}

/** The view filters' context: the viewer, and their today in their own timezone. */
function viewerContext(tx: Tx, userId: string, nowMs: number): SavedViewContext {
  const viewerTz =
    tx.select({ timezone: user.timezone }).from(user).where(eq(user.id, userId)).get()?.timezone ??
    'UTC';
  return { viewerId: userId, due: { today: todayIn(viewerTz, nowMs), nowMs, viewerTz } };
}

/**
 * The audience of a change to views: every member when any of them is (or was) shared, else
 * the owners of the private ones.
 */
function viewsAudience(
  tx: Tx,
  orgId: string,
  views: readonly Pick<ViewRow, 'shared' | 'createdBy'>[],
): Audience {
  const userIds = views.some((v) => v.shared)
    ? memberIds(tx, orgId)
    : [...new Set(views.map((v) => v.createdBy))];
  return { org: orgId, userIds, keys: [qk.views(orgId)] };
}

/**
 * B11: in the transaction of a tag delete or merge, every view query of the org drops the
 * deleted tags and points merged ones at the tag they went into (core `remapViewQuery`).
 * Archived views too. Returns the audience to tell (`['views', orgId]`), or null when no view
 * named the tags. Renames need nothing: views store tag IDs.
 */
export function remapViewsForTags(
  tx: Tx,
  orgId: string,
  change: { deleted?: readonly string[]; merged?: Readonly<Record<string, string>> },
  now: number,
): Audience | null {
  const changed: ViewRow[] = [];
  for (const row of tx.select().from(savedView).where(eq(savedView.orgId, orgId)).all()) {
    const query = parseQuery(row.query);
    const next = remapViewQuery(query, change);
    if (next === query) continue;
    tx.update(savedView)
      .set({ query: JSON.stringify(next), updatedAt: now })
      .where(eq(savedView.id, row.id))
      .run();
    changed.push(row);
  }
  return changed.length === 0 ? null : viewsAudience(tx, orgId, changed);
}

/**
 * Member removal (05 §3, ADR 0073 B): the member's private views in the org go, with every
 * member's order of them, and so does their own order of the org's shared views. Shared views
 * they created stay (`created_by` keeps naming them). Nobody else saw the private views, so
 * there is nothing to tell.
 */
export const viewRemovalStep: MemberRemovalStep = (tx, { orgId, userId }) => {
  const inOrg = tx.select({ id: savedView.id }).from(savedView).where(eq(savedView.orgId, orgId));
  tx.delete(savedViewPref)
    .where(and(eq(savedViewPref.userId, userId), inArray(savedViewPref.viewId, inOrg)))
    .run();
  tx.delete(savedView)
    .where(
      and(eq(savedView.orgId, orgId), eq(savedView.createdBy, userId), eq(savedView.shared, false)),
    )
    .run();
};

/**
 * Phase 13 (ADR 0073 B): views, saved queries in one org (`saved_view`, `saved_view_pref`).
 * Reading needs `tasks:read`, managing `groups:write` with write access to the whole org, as
 * for groups (11 §2). A private view is its creator's only: anyone else gets `404`, as for an
 * unknown view. Each member orders the views they see themselves.
 */
export class ViewService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly ordering: OrderingService,
  ) {}

  private now(): number {
    return this.deps.clock();
  }

  /**
   * A view the actor sees: in a live org they are a member of, shared or theirs, and in an
   * org their grant reaches. Everything else is the same `404`, so existence never leaks.
   */
  private requireView(tx: Tx, actor: Actor, viewId: string): { row: ViewRow; isPersonal: boolean } {
    const found = tx
      .select({ row: savedView, isPersonal: organization.isPersonal })
      .from(savedView)
      .innerJoin(organization, eq(organization.id, savedView.orgId))
      .innerJoin(
        member,
        and(eq(member.organizationId, savedView.orgId), eq(member.userId, actor.userId)),
      )
      .where(and(eq(savedView.id, viewId), isNull(organization.deletedAt)))
      .get();
    if (found === undefined) throw viewNotFound();
    const { row } = found;
    if (!row.shared && row.createdBy !== actor.userId) throw viewNotFound();
    if (!grantReachesOrg(actor, row.orgId)) throw viewNotFound();
    return found;
  }

  /** The DTO as the actor sees it: their key, and the open tasks they may read that match. */
  private dto(tx: Tx, actor: Actor, row: ViewRow, position?: string): SavedView {
    const placed =
      position ??
      orderedViews(tx, actor.userId, row.orgId, row.archivedAt !== null).find(
        (p) => p.row.id === row.id,
      )?.position ??
      rebalanceKeys(1)[0];
    const { tasks } = readableOrgTasks(tx, actor, row.orgId);
    const ctx = viewerContext(tx, actor.userId, this.now());
    return toViewDto(
      row,
      placed as string,
      savedViewCounts(tasks, parseQuery(row.query), ctx).open,
    );
  }

  private emit(
    tx: Tx,
    actor: Actor,
    type: DomainEventType,
    row: ViewRow,
    audience: Audience,
  ): void {
    emitAfterCommit(this.deps, tx, {
      type,
      orgId: row.orgId,
      actorId: actor.userId,
      subjects: [row.id],
      audiences: [audience],
    });
  }

  /** Tags must be the org's and a named assignee one of its members; only new values count. */
  private validateQuery(
    tx: Tx,
    orgId: string,
    query: SavedViewQuery,
    previous?: SavedViewQuery,
  ): void {
    const errors: FieldError[] = [];
    const added = query.tags.filter((id) => previous?.tags.includes(id) !== true);
    if (added.length > 0) {
      const known = new Set(
        tx
          .select({ id: tag.id })
          .from(tag)
          .where(and(eq(tag.orgId, orgId), inArray(tag.id, added)))
          .all()
          .map((t) => t.id),
      );
      query.tags.forEach((id, i) => {
        if (added.includes(id) && !known.has(id)) {
          errors.push({ path: `query.tags.${i}`, message: 'Not a tag of this organisation' });
        }
      });
    }
    const assignee = query.assignee;
    if (
      assignee !== 'anyone' &&
      assignee !== 'me' &&
      assignee !== 'unassigned' &&
      assignee !== previous?.assignee &&
      !isMember(tx, assignee, orgId)
    ) {
      errors.push({ path: 'query.assignee', message: 'Not a member of this organisation' });
    }
    if (errors.length > 0) {
      throw new AppError(
        'validation_failed',
        422,
        'The view names a tag or person outside this organisation.',
        errors,
      );
    }
  }

  /**
   * The org's live views the actor sees, in their own order (`archived=true`: the archived
   * ones, newest first), each with its open count over the tasks the actor may read.
   */
  list(actor: Actor, orgRef: string, query: SavedViewListQuery): SavedView[] {
    return readOnly(this.deps.db, (tx) => {
      const { org } = requireMembership(tx, actor.userId, orgRef);
      authorizeOrg(actor, org.id, 'tasks:read');
      const placed = orderedViews(tx, actor.userId, org.id, query.archived === 'true');
      if (placed.length === 0) return [];
      const { tasks } = readableOrgTasks(tx, actor, org.id);
      const count = viewCounter(tasks, viewerContext(tx, actor.userId, this.now()));
      return placed.map((p) => toViewDto(p.row, p.position, count(parseQuery(p.row.query)).open));
    });
  }

  /**
   * Creates a view at the end of the creator's order. Other members have no key for it, so a
   * shared view shows at the end of theirs too. A personal org's views are always private. A
   * repeated create with the same `id` and content returns the view; anything else under that
   * ID is `409 id_conflict` (a view the actor cannot see included, without telling it apart).
   */
  create(actor: Actor, orgRef: string, input: SavedViewCreate, _meta?: OpMeta): SavedView {
    return immediate(this.deps.db, (tx) => {
      const { org } = requireMembership(tx, actor.userId, orgRef);
      authorizeOrgWide(tx, actor, org.id, 'groups:write');
      const query = normaliseQuery(input.query);
      const shared = !org.isPersonal && input.shared === true;
      if (input.id !== undefined) {
        const existing = tx.select().from(savedView).where(eq(savedView.id, input.id)).get();
        if (existing !== undefined) {
          const same =
            existing.orgId === org.id &&
            existing.createdBy === actor.userId &&
            existing.name === input.name &&
            existing.shared === shared &&
            JSON.stringify(parseQuery(existing.query)) === JSON.stringify(query);
          if (!same) throw idConflict();
          return this.dto(tx, actor, existing);
        }
      }
      this.validateQuery(tx, org.id, query);
      requireRoom(tx, org.id, shared, actor.userId);
      const now = this.now();
      const row: ViewRow = {
        id: input.id ?? uuidv7(),
        orgId: org.id,
        createdBy: actor.userId,
        shared,
        name: input.name,
        query: JSON.stringify(query),
        archivedAt: null,
        createdAt: now,
        updatedAt: now,
      };
      tx.insert(savedView).values(row).run();
      const position = this.placeForActor(tx, actor.userId, row, 'end');
      this.emit(tx, actor, 'view.created', row, viewsAudience(tx, org.id, [row]));
      return this.dto(tx, actor, row, position);
    });
  }

  /**
   * Puts `row` at `target` in the user's own order of the org's live views, storing the keys of
   * every view they see first (the domain must be complete to place between two of them, and a
   * view they never ordered keeps its place when `row` lands after it).
   */
  private placeForActor(tx: Tx, userId: string, row: ViewRow, target: OrderTarget): string {
    const others = orderedViews(tx, userId, row.orgId, false).filter((p) => p.row.id !== row.id);
    materialise(tx, userId, others);
    const domain = {
      items: others.map((p) => ({ id: p.row.id, position: p.position })),
      write: (id: string, position: string) => writePref(tx, userId, id, position),
    };
    const [position] = this.ordering.place(domain, target).keys as [string];
    writePref(tx, userId, row.id, position);
    return position;
  }

  /**
   * Renames a view, changes its query, or shares or unshares it. Any member may change a shared
   * view, only the creator a private one (anyone else: `404`). Unsharing makes the view private
   * to its creator, by whoever does it: the other members' keys for it are deleted, so sharing
   * it again puts it at the end of their orders. A personal org's views stay private. A shared
   * view whose creator has left cannot be unshared (`422`): it would be nobody's.
   */
  update(actor: Actor, viewId: string, patch: SavedViewPatch, _meta?: OpMeta): SavedView {
    return immediate(this.deps.db, (tx) => {
      const { row, isPersonal } = this.requireView(tx, actor, viewId);
      authorizeOrgWide(tx, actor, row.orgId, 'groups:write');
      // The actor's key before the change: an unshare by another member hides the view from
      // them, and the response still describes it as they last saw it.
      const before = orderedViews(tx, actor.userId, row.orgId, row.archivedAt !== null).find(
        (p) => p.row.id === row.id,
      )?.position;
      const changes: Partial<ViewRow> = {};
      if (patch.name !== undefined && patch.name !== row.name) changes.name = patch.name;
      if (patch.query !== undefined) {
        const previous = parseQuery(row.query);
        const query = normaliseQuery(patch.query);
        if (JSON.stringify(query) !== JSON.stringify(previous)) {
          this.validateQuery(tx, row.orgId, query, previous);
          changes.query = JSON.stringify(query);
        }
      }
      if (patch.shared !== undefined && !isPersonal && patch.shared !== row.shared) {
        // Private to a creator who has left, nobody would ever see it again.
        if (!patch.shared && !isMember(tx, row.createdBy, row.orgId)) {
          throw new AppError(
            'validation_failed',
            422,
            'Whoever made this view has left the organisation: delete it instead.',
            [{ path: 'shared', message: 'Its creator is no longer a member' }],
          );
        }
        // The view joins the shared views, or its creator's private ones.
        requireRoom(tx, row.orgId, patch.shared, row.createdBy);
        changes.shared = patch.shared;
      }
      if (Object.keys(changes).length === 0) return this.dto(tx, actor, row, before);
      const next: ViewRow = { ...row, ...changes, updatedAt: this.now() };
      tx.update(savedView)
        .set({ ...changes, updatedAt: next.updatedAt })
        .where(eq(savedView.id, row.id))
        .run();
      if (changes.shared === false) {
        tx.delete(savedViewPref)
          .where(and(eq(savedViewPref.viewId, row.id), ne(savedViewPref.userId, row.createdBy)))
          .run();
      }
      if (changes.shared === true && next.archivedAt === null) {
        // Newly visible to the other members: at the end of each one's order, however old.
        for (const userId of memberIds(tx, row.orgId)) {
          if (userId !== row.createdBy) this.placeForActor(tx, userId, next, 'end');
        }
      }
      this.emit(tx, actor, 'view.updated', next, viewsAudience(tx, row.orgId, [row, next]));
      return this.dto(tx, actor, next, before);
    });
  }

  /** Deletes a view and every member's key for it; its tasks and tags are untouched. */
  remove(actor: Actor, viewId: string, _meta?: OpMeta): void {
    immediate(this.deps.db, (tx) => {
      const { row } = this.requireView(tx, actor, viewId);
      authorizeOrgWide(tx, actor, row.orgId, 'groups:write');
      tx.delete(savedView).where(eq(savedView.id, row.id)).run();
      this.emit(tx, actor, 'view.deleted', row, viewsAudience(tx, row.orgId, [row]));
    });
  }

  /**
   * Moves a view in the actor's own order. `afterId`/`beforeId` must be live views the actor
   * sees; any other ID (a private view of someone else included) counts as unknown and the view
   * goes to the end, as for every ordering intent (04 §7). An archived view has no place in any
   * order: the move is a no-op.
   */
  move(actor: Actor, viewId: string, intent: SavedViewMove, _meta?: OpMeta): SavedView {
    return immediate(this.deps.db, (tx) => {
      const { row } = this.requireView(tx, actor, viewId);
      authorizeOrgWide(tx, actor, row.orgId, 'groups:write');
      if (row.archivedAt !== null) return this.dto(tx, actor, row);
      const target: OrderTarget = {};
      if (intent.afterId !== undefined) target.afterId = intent.afterId;
      if (intent.beforeId !== undefined) target.beforeId = intent.beforeId;
      const position = this.placeForActor(tx, actor.userId, row, target);
      this.emit(
        tx,
        actor,
        'view.moved',
        row,
        selfAudience(actor.userId, row.orgId, [qk.views(row.orgId)]),
      );
      return this.dto(tx, actor, row, position);
    });
  }

  /**
   * Archive (it leaves every sidebar, and every member's key for it goes) or restore (back at
   * the end of the order of everyone who sees it). Idempotent.
   */
  setArchived(actor: Actor, viewId: string, archived: boolean, _meta?: OpMeta): SavedView {
    return immediate(this.deps.db, (tx) => {
      const { row } = this.requireView(tx, actor, viewId);
      authorizeOrgWide(tx, actor, row.orgId, 'groups:write');
      if ((row.archivedAt !== null) === archived) return this.dto(tx, actor, row);
      const now = this.now();
      const next: ViewRow = { ...row, archivedAt: archived ? now : null, updatedAt: now };
      tx.update(savedView)
        .set({ archivedAt: next.archivedAt, updatedAt: now })
        .where(eq(savedView.id, row.id))
        .run();
      tx.delete(savedViewPref).where(eq(savedViewPref.viewId, row.id)).run();
      let position: string | undefined;
      if (!archived) {
        // Back at the end of every order that shows it (each member's for a shared view),
        // however old the view is: each order is stored first, so it stays as it was seen.
        const userIds = next.shared ? memberIds(tx, row.orgId) : [row.createdBy];
        for (const userId of userIds) {
          const key = this.placeForActor(tx, userId, next, 'end');
          if (userId === actor.userId) position = key;
        }
      }
      this.emit(
        tx,
        actor,
        archived ? 'view.archived' : 'view.restored',
        next,
        viewsAudience(tx, row.orgId, [row]),
      );
      return this.dto(tx, actor, next, position);
    });
  }

  /**
   * The view's rows: every live task of the org matching its query (subtasks are rows of their
   * own; a matching parent does not pull in its subtasks), among the tasks the actor may read,
   * with the actor's placement, by due date then created. `completed=true` also lists completed
   * matches. `counts` are the readable matches of the filters by completion. Dates are judged
   * in the actor's timezone; `me` is the actor. After the rows come the readable ancestors of
   * matching subtasks that are not rows themselves (breadcrumbs): not rows and not counted, and
   * every client regroups with core `selectSavedView`, which drops them again.
   */
  tasks(actor: Actor, viewId: string, query: SavedViewTasksQuery): SavedViewTasks {
    return readOnly(this.deps.db, (tx) => {
      const { row } = this.requireView(tx, actor, viewId);
      authorizeOrg(actor, row.orgId, 'tasks:read');
      const viewQuery = parseQuery(row.query);
      const ctx = viewerContext(tx, actor.userId, this.now());
      const { rows, tasks } = readableOrgTasks(tx, actor, row.orgId);
      const showCompleted = query.completed === 'true';
      const matched = tasks
        .filter((t) => matchesSavedView(t, viewQuery, { ...ctx, showCompleted }))
        .sort(compareRows);
      const byId = new Map(rows.map((r) => [r.id, r]));
      const matchedRows = matched.flatMap((t) => {
        const r = byId.get(t.id);
        return r === undefined ? [] : [r];
      });
      // The parent chains of matching subtasks, for their breadcrumbs (as my-list does for
      // orphan subtasks): readable live ancestors only (`byId` holds the readable tasks), so a
      // chain stops at a parent the grant cannot read, which the child's DTO hides too.
      const included = new Set(matchedRows.map((r) => r.id));
      const ancestors: TaskRow[] = [];
      for (const r of matchedRows) {
        for (let at = r.parentId; at !== null && !included.has(at); ) {
          const parent = byId.get(at);
          if (parent === undefined) break;
          included.add(at);
          ancestors.push(parent);
          at = parent.parentId;
        }
      }
      return {
        items: taskDtos(tx, actor, [...matchedRows, ...ancestors]),
        counts: savedViewCounts(tasks, viewQuery, ctx),
      };
    });
  }
}

function toViewDto(row: ViewRow, position: string, openCount: number): SavedView {
  return {
    id: row.id,
    orgId: row.orgId,
    createdBy: row.createdBy,
    shared: row.shared,
    name: row.name,
    query: parseQuery(row.query),
    archivedAt: row.archivedAt,
    position,
    openCount,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
