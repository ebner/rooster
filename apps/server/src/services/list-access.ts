import type { Group, Task } from '@rooster/core/schemas';
import { and, asc, eq, inArray, isNull, notInArray, sql } from 'drizzle-orm';
import { member, organization, placement, task, taskGroup, taskTag } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import type { Tx } from './context.ts';
import type { OrderDomain } from './ordering-service.ts';
import { indexTasks } from './search-index.ts';

export type TaskRow = typeof task.$inferSelect;
export type GroupRow = typeof taskGroup.$inferSelect;
export type PlacementRow = typeof placement.$inferSelect;

export const taskNotFound = () => new AppError('not_found', 404, 'Task not found.');
export const groupNotFound = () => new AppError('not_found', 404, 'Group not found.');
export const taskDeleted = () =>
  new AppError('conflict_deleted', 410, 'The task is deleted; restore it first.');

// --- field clocks (05 §4.4) ---------------------------------------------------------------

export type FieldClock = Record<string, number>;

export function parseClock(text: string): FieldClock {
  try {
    const value = JSON.parse(text) as unknown;
    if (value === null || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value).filter((e): e is [string, number] => typeof e[1] === 'number'),
    );
  } catch {
    return {};
  }
}

/** Per-field LWW: an edit applies when it is not older than the field's last applied edit. */
export function clockAllows(clock: FieldClock, key: string, editTime: number): boolean {
  return editTime >= (clock[key] ?? Number.NEGATIVE_INFINITY);
}

export const posClockKey = (userId: string) => `pos:${userId}`;

// --- access (04 §4.3) ---------------------------------------------------------------------

/** True when the user is a member of the live org. */
export function isMember(tx: Tx, userId: string, orgId: string): boolean {
  const row = tx
    .select({ id: member.id })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .where(
      and(
        eq(member.organizationId, orgId),
        eq(member.userId, userId),
        isNull(organization.deletedAt),
      ),
    )
    .get();
  return row !== undefined;
}

/**
 * A task the actor can see: it belongs to a live org the actor is a member of. Everyone
 * else gets the same 404 as for a missing task, so existence never leaks.
 */
export function requireTask(tx: Tx, userId: string, taskId: string): TaskRow {
  const row = tx.select().from(task).where(eq(task.id, taskId)).get();
  if (row === undefined || !isMember(tx, userId, row.orgId)) throw taskNotFound();
  return row;
}

/**
 * One of the actor's own groups (groups are personal: others get 404). Deleted groups are
 * only returned with `includeDeleted`.
 */
export function requireOwnGroup(
  tx: Tx,
  userId: string,
  groupId: string,
  options: { includeDeleted?: boolean; orgId?: string } = {},
): GroupRow {
  const row = tx.select().from(taskGroup).where(eq(taskGroup.id, groupId)).get();
  if (
    row === undefined ||
    row.userId !== userId ||
    (options.orgId !== undefined && row.orgId !== options.orgId) ||
    (row.deletedAt !== null && options.includeDeleted !== true) ||
    !isMember(tx, userId, row.orgId)
  ) {
    throw groupNotFound();
  }
  return row;
}

export function inboxOf(tx: Tx, userId: string, orgId: string): GroupRow {
  const row = tx
    .select()
    .from(taskGroup)
    .where(
      and(eq(taskGroup.userId, userId), eq(taskGroup.orgId, orgId), eq(taskGroup.kind, 'inbox')),
    )
    .get();
  // Every membership has an Inbox (05 §4.2); a missing one is a broken invariant.
  if (row === undefined) throw new Error(`no inbox for user ${userId} in org ${orgId}`);
  return row;
}

export function placementOf(tx: Tx, taskId: string): PlacementRow | undefined {
  return tx.select().from(placement).where(eq(placement.taskId, taskId)).get();
}

// --- ordering domains (04 §7) -------------------------------------------------------------

/**
 * The placements of one group: `placement(user, org, group)`. Soft-deleted tasks keep their
 * placement (05 §4.1), so they stay in the domain and keep their slot for a restore.
 */
export function placementDomain(
  tx: Tx,
  input: { userId: string; orgId: string; groupId: string; now: number },
  exclude: readonly string[] = [],
): OrderDomain {
  const items = tx
    .select({ id: placement.taskId, position: placement.position })
    .from(placement)
    .where(
      and(
        eq(placement.userId, input.userId),
        eq(placement.orgId, input.orgId),
        eq(placement.groupId, input.groupId),
        exclude.length > 0 ? notInArray(placement.taskId, [...exclude]) : undefined,
      ),
    )
    .orderBy(asc(placement.position), asc(placement.taskId))
    .all();
  return {
    items,
    write: (id, position) => {
      tx.update(placement)
        .set({ position, updatedAt: input.now })
        .where(eq(placement.taskId, id))
        .run();
    },
  };
}

/** The actor's live normal groups in an org: `task_group(user, org)`, Inbox excluded. */
export function groupDomain(
  tx: Tx,
  input: { userId: string; orgId: string; now: number },
  exclude: readonly string[] = [],
): OrderDomain {
  const items = tx
    .select({ id: taskGroup.id, position: taskGroup.position })
    .from(taskGroup)
    .where(
      and(
        eq(taskGroup.userId, input.userId),
        eq(taskGroup.orgId, input.orgId),
        eq(taskGroup.kind, 'normal'),
        isNull(taskGroup.deletedAt),
        exclude.length > 0 ? notInArray(taskGroup.id, [...exclude]) : undefined,
      ),
    )
    .orderBy(asc(taskGroup.position), asc(taskGroup.id))
    .all();
  return {
    items,
    write: (id, position) => {
      tx.update(taskGroup)
        .set({ position, updatedAt: input.now })
        .where(eq(taskGroup.id, id))
        .run();
    },
  };
}

// --- DTOs (05 §5) -------------------------------------------------------------------------

export function toGroupDto(row: GroupRow): Group {
  return {
    id: row.id,
    orgId: row.orgId,
    kind: row.kind,
    name: row.name,
    position: row.position,
    collapsed: row.collapsed,
  };
}

/** Keeps `IN (…)` lists well below SQLite's bound-parameter limit. */
const IN_CHUNK = 500;

export function chunked<T>(items: readonly T[], size = IN_CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Derived TaskDTO fields loaded per batch: tag IDs in add order and subtask counts. */
export interface TaskExtras {
  tagIds: Map<string, string[]>;
  counts: Map<string, { subtasks: number; subtasksDone: number }>;
}

/**
 * Tags (ordered by `added_at`, then insertion) and direct live subtask counts of `taskIds`
 * (FR-TASK-10). Completing a subtask counts it as done; deleted subtasks do not count.
 */
export function loadTaskExtras(tx: Tx, taskIds: readonly string[]): TaskExtras {
  const extras: TaskExtras = { tagIds: new Map(), counts: new Map() };
  for (const ids of chunked([...new Set(taskIds)])) {
    const tags = tx
      .select({ taskId: taskTag.taskId, tagId: taskTag.tagId })
      .from(taskTag)
      .where(inArray(taskTag.taskId, ids))
      .orderBy(asc(taskTag.addedAt), sql`${taskTag}.rowid`)
      .all();
    for (const t of tags) {
      const list = extras.tagIds.get(t.taskId);
      if (list === undefined) extras.tagIds.set(t.taskId, [t.tagId]);
      else list.push(t.tagId);
    }
    const counts = tx
      .select({
        parentId: task.parentId,
        subtasks: sql<number>`count(*)`,
        subtasksDone: sql<number>`coalesce(sum(${task.completedAt} IS NOT NULL), 0)`,
      })
      .from(task)
      .where(and(inArray(task.parentId, ids), isNull(task.deletedAt)))
      .groupBy(task.parentId)
      .all();
    for (const c of counts) {
      if (c.parentId !== null) {
        extras.counts.set(c.parentId, { subtasks: c.subtasks, subtasksDone: c.subtasksDone });
      }
    }
  }
  return extras;
}

export function toTaskDto(
  row: TaskRow,
  place: Pick<PlacementRow, 'groupId' | 'position'> | null,
  options: { description?: boolean; trash?: boolean } = {},
  extras?: TaskExtras,
): Task {
  const counts = extras?.counts.get(row.id);
  return {
    id: row.id,
    orgId: row.orgId,
    seq: row.seq,
    parentId: row.parentId,
    subtaskPosition: row.subtaskPosition,
    title: row.title,
    ...(options.description === true ? { description: row.description } : {}),
    assigneeId: row.assigneeId,
    createdBy: row.createdBy,
    dueDate: row.dueDate,
    dueTime: row.dueTime,
    dueTz: row.dueTz,
    startDate: row.startDate,
    completedAt: row.completedAt,
    tagIds: [...(extras?.tagIds.get(row.id) ?? [])],
    // Comments (P6) and attachments (P10) do not exist yet.
    counts: {
      subtasks: counts?.subtasks ?? 0,
      subtasksDone: counts?.subtasksDone ?? 0,
      comments: 0,
      attachments: 0,
    },
    placement: place === null ? null : { groupId: place.groupId, position: place.position },
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(options.trash === true && row.deletedAt !== null
      ? {
          deletedAt: row.deletedAt,
          ...(row.deletedBy === null ? {} : { deletedBy: row.deletedBy }),
        }
      : {}),
  };
}

/** The given user's placements of `taskIds`, by task ID. */
export function placementsFor(
  tx: Tx,
  userId: string,
  taskIds: readonly string[],
): Map<string, PlacementRow> {
  const out = new Map<string, PlacementRow>();
  for (const ids of chunked(taskIds)) {
    const rows = tx
      .select()
      .from(placement)
      .where(and(eq(placement.userId, userId), inArray(placement.taskId, ids)))
      .all();
    for (const r of rows) out.set(r.taskId, r);
  }
  return out;
}

/** Task DTO with the actor's placement, as returned by single-task mutations. */
export function taskDtoFor(tx: Tx, userId: string, row: TaskRow): Task {
  const place = placementOf(tx, row.id);
  return toTaskDto(
    row,
    place !== undefined && place.userId === userId ? place : null,
    { description: true },
    loadTaskExtras(tx, [row.id]),
  );
}

/** DTOs for many rows with `userId`'s placements (or the given ones) and the extras. */
export function taskDtos(
  tx: Tx,
  userId: string,
  rows: readonly TaskRow[],
  options: { trash?: boolean; places?: ReadonlyMap<string, PlacementRow | null> } = {},
): Task[] {
  const ids = rows.map((r) => r.id);
  const places = options.places ?? placementsFor(tx, userId, ids);
  const extras = loadTaskExtras(tx, ids);
  return rows.map((r) =>
    toTaskDto(r, places.get(r.id) ?? null, options.trash === true ? { trash: true } : {}, extras),
  );
}

/** Live rows by ID (any order; missing and deleted IDs are skipped). */
export function liveTasksById(tx: Tx, ids: readonly string[]): TaskRow[] {
  const out: TaskRow[] = [];
  for (const chunk of chunked([...new Set(ids)])) {
    out.push(
      ...tx
        .select()
        .from(task)
        .where(and(inArray(task.id, chunk), isNull(task.deletedAt)))
        .all(),
    );
  }
  return out;
}

/** Ancestors of a task, from its direct parent up to the root. */
export function ancestorsOf(tx: Tx, row: Pick<TaskRow, 'id' | 'parentId'>): TaskRow[] {
  const out: TaskRow[] = [];
  const seen = new Set([row.id]);
  let parentId = row.parentId;
  while (parentId !== null && !seen.has(parentId)) {
    const parent = tx.select().from(task).where(eq(task.id, parentId)).get();
    if (parent === undefined) break;
    out.push(parent);
    seen.add(parent.id);
    parentId = parent.parentId;
  }
  return out;
}

/** Levels of descendants below `id` (deleted ones included, they may come back): 0 = a leaf. */
export function subtreeHeight(tx: Tx, id: string): number {
  let height = 0;
  let frontier = [id];
  const seen = new Set(frontier);
  while (frontier.length > 0) {
    const next: string[] = [];
    for (const chunk of chunked(frontier)) {
      for (const c of tx
        .select({ id: task.id })
        .from(task)
        .where(inArray(task.parentId, chunk))
        .all()) {
        if (!seen.has(c.id)) {
          seen.add(c.id);
          next.push(c.id);
        }
      }
    }
    if (next.length === 0) break;
    height++;
    frontier = next;
  }
  return height;
}

/**
 * The siblings of a parent's subtasks: `task(parent_id)` ordered by `subtask_position, id`.
 * Soft-deleted subtasks keep their key so a restore returns them to their slot.
 */
export function subtaskDomain(
  tx: Tx,
  input: { parentId: string; now: number },
  exclude: readonly string[] = [],
): OrderDomain {
  const items = tx
    .select({ id: task.id, position: task.subtaskPosition })
    .from(task)
    .where(
      and(
        eq(task.parentId, input.parentId),
        exclude.length > 0 ? notInArray(task.id, [...exclude]) : undefined,
      ),
    )
    .orderBy(asc(task.subtaskPosition), asc(task.id))
    .all()
    .map((r) => ({ id: r.id, position: r.position ?? '' }));
  return {
    items,
    write: (id, position) => {
      tx.update(task)
        .set({ subtaskPosition: position, updatedAt: input.now })
        .where(eq(task.id, id))
        .run();
    },
  };
}

/**
 * Every descendant of `ids` (subtasks, P3), optionally only those whose `deleted_at` equals
 * `deletedAt` (a restore brings back exactly what was deleted together, 05 §4.3).
 */
export function descendantsOf(
  tx: Tx,
  ids: readonly string[],
  filter: { deletedAt?: number | null } = {},
): string[] {
  const out: string[] = [];
  let frontier = [...ids];
  while (frontier.length > 0) {
    const children = tx
      .select({ id: task.id, deletedAt: task.deletedAt })
      .from(task)
      .where(inArray(task.parentId, frontier))
      .all();
    const matching = children.filter(
      (c) => filter.deletedAt === undefined || c.deletedAt === filter.deletedAt,
    );
    out.push(...matching.map((c) => c.id));
    frontier = matching.map((c) => c.id);
  }
  return out;
}

/** Soft-deletes the tasks and their live descendants with one shared `deleted_at`. */
export function softDeleteTasks(
  tx: Tx,
  ids: readonly string[],
  input: { userId: string; now: number },
): void {
  if (ids.length === 0) return;
  const all = [...ids, ...descendantsOf(tx, ids, { deletedAt: null })];
  tx.update(task)
    .set({ deletedAt: input.now, deletedBy: input.userId, updatedAt: input.now })
    .where(and(inArray(task.id, all), isNull(task.deletedAt)))
    .run();
  indexTasks(tx, all);
}
