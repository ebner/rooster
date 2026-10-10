import { canRead } from '@rooster/core/grants';
import type { Group, Task } from '@rooster/core/schemas';
import { and, asc, eq, inArray, isNotNull, isNull, min, notInArray, sql } from 'drizzle-orm';
import {
  comment,
  member,
  organization,
  placement,
  task,
  taskGroup,
  taskReminder,
  taskTag,
} from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import { attachmentCounts } from './attachment-queries.ts';
import type { Actor, Tx } from './context.ts';
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

/**
 * Derived TaskDTO fields loaded per batch: tag IDs in add order, subtask counts, live comment
 * and attachment counts, and (P10) the viewer's next pending reminder.
 */
export interface TaskExtras {
  tagIds: Map<string, string[]>;
  counts: Map<string, { subtasks: number; subtasksDone: number }>;
  comments: Map<string, number>;
  attachments: Map<string, number>;
  /** The viewer's earliest pending (not fired, not dormant) reminder per task (FR-REM-4). */
  nextReminderAt: Map<string, number>;
}

/**
 * Tags (ordered by `added_at`, then insertion), direct live subtask counts (FR-TASK-10), live
 * comment and attachment counts of `taskIds`, and `viewerId`'s next reminder on each (null:
 * nobody's, e.g. an export without a viewer). Completing a subtask counts it as done; deleted
 * subtasks, comments and attachments do not count.
 */
export function loadTaskExtras(
  tx: Tx,
  taskIds: readonly string[],
  viewer: TaskViewer | null,
): TaskExtras {
  const viewerId = viewer === null ? null : viewerIdOf(viewer);
  // A grant counts only the subtasks it may read (their number and done state are no hint).
  const visible = viewer === null ? null : taskVisibility(tx, viewer);
  const extras: TaskExtras = {
    tagIds: new Map(),
    counts: new Map(),
    comments: new Map(),
    attachments: attachmentCounts(tx, taskIds),
    nextReminderAt: new Map(),
  };
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
    if (visible === null) {
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
    } else {
      for (const child of tx
        .select({
          id: task.id,
          parentId: task.parentId,
          orgId: task.orgId,
          completedAt: task.completedAt,
        })
        .from(task)
        .where(and(inArray(task.parentId, ids), isNull(task.deletedAt)))
        .all()) {
        if (child.parentId === null || !visible(child)) continue;
        const c = extras.counts.get(child.parentId) ?? { subtasks: 0, subtasksDone: 0 };
        c.subtasks++;
        if (child.completedAt !== null) c.subtasksDone++;
        extras.counts.set(child.parentId, c);
      }
    }
    for (const c of tx
      .select({ taskId: comment.taskId, n: sql<number>`count(*)` })
      .from(comment)
      .where(and(inArray(comment.taskId, ids), isNull(comment.deletedAt)))
      .groupBy(comment.taskId)
      .all()) {
      extras.comments.set(c.taskId, c.n);
    }
    if (viewerId !== null) {
      for (const r of tx
        .select({ taskId: taskReminder.taskId, at: min(taskReminder.fireAt) })
        .from(taskReminder)
        .where(
          and(
            eq(taskReminder.userId, viewerId),
            inArray(taskReminder.taskId, ids),
            isNull(taskReminder.firedAt),
            isNotNull(taskReminder.fireAt),
          ),
        )
        .groupBy(taskReminder.taskId)
        .all()) {
        if (r.at !== null) extras.nextReminderAt.set(r.taskId, r.at);
      }
    }
  }
  return extras;
}

export function toTaskDto(
  row: TaskRow,
  place: Pick<PlacementRow, 'groupId' | 'position'> | null,
  options: { description?: boolean; trash?: boolean; parentHidden?: boolean } = {},
  extras?: TaskExtras,
): Task {
  const counts = extras?.counts.get(row.id);
  return {
    id: row.id,
    orgId: row.orgId,
    seq: row.seq,
    // A parent the viewer's grant cannot read is not named (its existence would leak).
    parentId: options.parentHidden === true ? null : row.parentId,
    subtaskPosition: row.subtaskPosition,
    title: row.title,
    ...(options.description === true ? { description: row.description } : {}),
    hasDescription: row.description.trim() !== '',
    assigneeId: row.assigneeId,
    createdBy: row.createdBy,
    dueDate: row.dueDate,
    dueTime: row.dueTime,
    dueTz: row.dueTz,
    startDate: row.startDate,
    recurrence: row.recurrence,
    recurrenceBasis: row.recurrenceBasis,
    // Done and deleted tasks never remind (FR-REM-3): no bell, though a reopen brings it back.
    nextReminderAt:
      row.completedAt === null && row.deletedAt === null
        ? (extras?.nextReminderAt.get(row.id) ?? null)
        : null,
    completedAt: row.completedAt,
    tagIds: [...(extras?.tagIds.get(row.id) ?? [])],
    counts: {
      subtasks: counts?.subtasks ?? 0,
      subtasksDone: counts?.subtasksDone ?? 0,
      comments: extras?.comments.get(row.id) ?? 0,
      attachments: extras?.attachments.get(row.id) ?? 0,
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
export function taskDtoFor(tx: Tx, viewer: TaskViewer, row: TaskRow): Task {
  const userId = viewerIdOf(viewer);
  const place = placementOf(tx, row.id);
  return toTaskDto(
    row,
    place !== undefined && place.userId === userId ? place : null,
    { description: true, parentHidden: hiddenParents(tx, viewer, [row]).has(row.id) },
    loadTaskExtras(tx, [row.id], viewer),
  );
}

/** IDs of `rows` whose parent the viewer's grant cannot read. */
export function hiddenParents(
  tx: Tx,
  viewer: TaskViewer,
  rows: readonly Pick<TaskRow, 'id' | 'parentId'>[],
): Set<string> {
  const hidden = new Set<string>();
  const visible = taskVisibility(tx, viewer);
  if (visible === null) return hidden;
  const parentIds = [...new Set(rows.map((r) => r.parentId).filter((p) => p !== null))];
  const parents = new Map<string, VisibilityRow>();
  for (const chunk of chunked(parentIds)) {
    for (const p of tx
      .select({ id: task.id, parentId: task.parentId, orgId: task.orgId })
      .from(task)
      .where(inArray(task.id, chunk))
      .all()) {
      parents.set(p.id, p);
    }
  }
  for (const r of rows) {
    if (r.parentId === null) continue;
    const parent = parents.get(r.parentId);
    if (parent === undefined || !visible(parent)) hidden.add(r.id);
  }
  return hidden;
}

/** DTOs for many rows with `userId`'s placements (or the given ones) and the extras. */
export function taskDtos(
  tx: Tx,
  viewer: TaskViewer,
  rows: readonly TaskRow[],
  options: { trash?: boolean; places?: ReadonlyMap<string, PlacementRow | null> } = {},
): Task[] {
  const ids = rows.map((r) => r.id);
  const places = options.places ?? placementsFor(tx, viewerIdOf(viewer), ids);
  const extras = loadTaskExtras(tx, ids, viewer);
  const hidden = hiddenParents(tx, viewer, rows);
  return rows.map((r) =>
    toTaskDto(
      r,
      places.get(r.id) ?? null,
      {
        ...(options.trash === true ? { trash: true } : {}),
        ...(hidden.has(r.id) ? { parentHidden: true } : {}),
      },
      extras,
    ),
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

/** A row of a subtree walk: `depth` 0 for the roots. */
export interface SubtreeRow {
  id: string;
  parentId: string | null;
  depth: number;
}

/** Subtasks nest at most a few levels; the walk stops well past that, cycles or not. */
const SUBTREE_DEPTH_GUARD = 32;

/**
 * Every descendant of `rootIds` (deleted ones included) with the roots, in one recursive
 * statement per chunk of roots over the full `task(parent_id)` index: no IN list grows with
 * the subtree.
 */
export function subtreeOf(tx: Tx, rootIds: readonly string[]): SubtreeRow[] {
  const out: SubtreeRow[] = [];
  const seen = new Set<string>();
  for (const chunk of chunked([...new Set(rootIds)])) {
    const roots = sql.join(
      chunk.map((id) => sql`${id}`),
      sql`, `,
    );
    for (const r of tx.all<{ id: string; parent_id: string | null; depth: number }>(
      sql`WITH RECURSIVE d(id, parent_id, depth) AS (
            SELECT id, parent_id, 0 FROM task WHERE id IN (${roots})
            UNION ALL
            SELECT c.id, c.parent_id, d.depth + 1 FROM task c JOIN d ON c.parent_id = d.id
            WHERE d.depth < ${SUBTREE_DEPTH_GUARD}
          ) SELECT id, parent_id, depth FROM d`,
    )) {
      if (seen.has(r.id)) continue;
      seen.add(r.id);
      out.push({ id: r.id, parentId: r.parent_id, depth: r.depth });
    }
  }
  return out;
}

/**
 * The placements (any user) of `rootIds` and all their descendants, joined in the same
 * recursive statement as `subtreeOf`.
 */
export function subtreePlacements(
  tx: Tx,
  rootIds: readonly string[],
): { taskId: string; userId: string; groupId: string }[] {
  const out: { taskId: string; userId: string; groupId: string }[] = [];
  for (const chunk of chunked([...new Set(rootIds)])) {
    const roots = sql.join(
      chunk.map((id) => sql`${id}`),
      sql`, `,
    );
    // Appended row by row: one root can have more descendants than a spread may pass.
    const rows = tx.all<{ taskId: string; userId: string; groupId: string }>(
      sql`WITH RECURSIVE d(id, depth) AS (
              SELECT id, 0 FROM task WHERE id IN (${roots})
              UNION
              SELECT c.id, d.depth + 1 FROM task c JOIN d ON c.parent_id = d.id
              WHERE d.depth < ${SUBTREE_DEPTH_GUARD}
            ) SELECT p.task_id AS taskId, p.user_id AS userId, p.group_id AS groupId
              FROM placement p JOIN d ON p.task_id = d.id`,
    );
    for (const row of rows) out.push(row);
  }
  return out;
}

/** Levels of descendants below `id` (deleted ones included, they may come back): 0 = a leaf. */
export function subtreeHeight(tx: Tx, id: string): number {
  return subtreeOf(tx, [id]).reduce((max, r) => Math.max(max, r.depth), 0);
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
    // Chunked: a parent may have more children than SQLite takes bound parameters.
    const children = chunked(frontier).flatMap((chunk) =>
      tx
        .select({ id: task.id, deletedAt: task.deletedAt })
        .from(task)
        .where(inArray(task.parentId, chunk))
        .all(),
    );
    const matching = children.filter(
      (c) => filter.deletedAt === undefined || c.deletedAt === filter.deletedAt,
    );
    for (const c of matching) out.push(c.id);
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
  for (const chunk of chunked(all)) {
    tx.update(task)
      .set({ deletedAt: input.now, deletedBy: input.userId, updatedAt: input.now })
      .where(and(inArray(task.id, chunk), isNull(task.deletedAt)))
      .run();
  }
  indexTasks(tx, all);
}

/** What a new task row needs; the rest (sequence number, clocks, timestamps) is filled in. */
export type NewTaskRow = Pick<
  TaskRow,
  | 'id'
  | 'orgId'
  | 'parentId'
  | 'subtaskPosition'
  | 'title'
  | 'description'
  | 'assigneeId'
  | 'createdBy'
  | 'dueDate'
  | 'dueTime'
  | 'dueTz'
  | 'startDate'
> &
  Partial<Pick<TaskRow, 'recurrence' | 'recurrenceBasis' | 'seriesId'>> & { now: number };

/**
 * Inserts a task row with the next org sequence number and fresh clocks, and indexes it. A
 * task created with a rule starts its own series (ADR 0049: `series_id` is the first
 * instance's id) unless `seriesId` names the series it continues.
 */
export function insertTaskRow(tx: Tx, input: NewTaskRow): TaskRow {
  const seq = tx
    .update(organization)
    .set({ taskSeq: sql`${organization.taskSeq} + 1` })
    .where(eq(organization.id, input.orgId))
    .returning({ taskSeq: organization.taskSeq })
    .get();
  const { now, ...fields } = input;
  const recurrence = input.recurrence ?? null;
  const row: TaskRow = {
    ...fields,
    seq: seq?.taskSeq ?? null,
    recurrence,
    recurrenceBasis: recurrence === null ? null : (input.recurrenceBasis ?? 'due'),
    seriesId: input.seriesId ?? (recurrence === null ? null : input.id),
    completedAt: null,
    completedBy: null,
    fieldClock: '{}',
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    deletedBy: null,
  };
  tx.insert(task).values(row).run();
  indexTasks(tx, [row.id]);
  return row;
}

/**
 * Where a task sits for the grant (11 §2.2): the user's own placement of the task, else of its
 * nearest ancestor (a subtask counts as part of the row it shows under; an orphan subtask has
 * its own placement). Null when neither the task nor any ancestor is in the user's list.
 */
export class GrantGroups {
  private readonly placed = new Map<string, string | null>();
  private readonly parents = new Map<string, string | null>();

  constructor(
    private readonly tx: Tx,
    private readonly userId: string,
  ) {}

  /** Preloads the placements and parents of `rows` (list reads), one query per chunk. */
  prime(rows: readonly Pick<TaskRow, 'id' | 'parentId'>[]): this {
    for (const r of rows) this.parents.set(r.id, r.parentId);
    const ids = rows.map((r) => r.id).filter((id) => !this.placed.has(id));
    for (const chunk of chunked(ids)) {
      for (const id of chunk) this.placed.set(id, null);
      for (const p of this.tx
        .select({ taskId: placement.taskId, groupId: placement.groupId })
        .from(placement)
        .where(and(eq(placement.userId, this.userId), inArray(placement.taskId, chunk)))
        .all()) {
        this.placed.set(p.taskId, p.groupId);
      }
    }
    return this;
  }

  groupOf(row: Pick<TaskRow, 'id' | 'parentId'>): string | null {
    const seen = new Set<string>();
    let id: string | null = row.id;
    this.parents.set(row.id, row.parentId);
    while (id !== null && !seen.has(id)) {
      seen.add(id);
      if (!this.placed.has(id)) this.loadPlacement(id);
      const group = this.placed.get(id) ?? null;
      if (group !== null) return group;
      id = this.parentOf(id);
    }
    return null;
  }

  private loadPlacement(taskId: string): void {
    const p = this.tx
      .select({ groupId: placement.groupId })
      .from(placement)
      .where(and(eq(placement.taskId, taskId), eq(placement.userId, this.userId)))
      .get();
    this.placed.set(taskId, p?.groupId ?? null);
  }

  private parentOf(taskId: string): string | null {
    if (!this.parents.has(taskId)) {
      const r = this.tx
        .select({ parentId: task.parentId })
        .from(task)
        .where(eq(task.id, taskId))
        .get();
      this.parents.set(taskId, r?.parentId ?? null);
    }
    return this.parents.get(taskId) ?? null;
  }
}

/**
 * Who a task DTO is for: a user ID (the browser session, full access) or the actor, whose grant
 * then decides which related tasks the DTO may reveal (subtask counts, the parent reference).
 */
export type TaskViewer = string | Pick<Actor, 'userId' | 'grant'>;

export function viewerIdOf(viewer: TaskViewer): string {
  return typeof viewer === 'string' ? viewer : viewer.userId;
}

type VisibilityRow = Pick<TaskRow, 'id' | 'parentId' | 'orgId'>;

/**
 * Whether a grant may read a task (the `canReadTask` rule; 11 §2.2), or null when the viewer
 * reads everything (the browser session).
 */
export function taskVisibility(
  tx: Tx,
  viewer: TaskViewer,
): ((row: VisibilityRow) => boolean) | null {
  if (typeof viewer === 'string' || viewer.grant === null) return null;
  const constraints = viewer.grant.constraints;
  const groups = new GrantGroups(tx, viewer.userId);
  return (row) =>
    canRead(constraints, row.orgId, null) || canRead(constraints, row.orgId, groups.groupOf(row));
}
