import { uuidv7 } from '@rooster/core/ids';
import {
  TAG_COLORS,
  type Tag,
  type TagColor,
  type TagCreate,
  type TagPatch,
  type Task,
  tagNameSchema,
} from '@rooster/core/schemas';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { tag, task, taskTag } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import {
  type Actor,
  emitAfterCommit,
  immediate,
  type OpMeta,
  type ServiceDeps,
  type Tx,
} from './context.ts';
import { isSharedOrg, memberIds, qk, taskAudiences, taskReach } from './event-audience.ts';
import { authorizeOrg, authorizeOrgWide, authorizeTaskWrite } from './grant-access.ts';
import { isMember, requireTask, type TaskRow, taskDeleted, taskDtoFor } from './list-access.ts';
import { requireMembership } from './org-access.ts';

export type TagRow = typeof tag.$inferSelect;

export const tagNotFound = () => new AppError('not_found', 404, 'Tag not found.');
/** `existingId` lets an offline outbox remap its own tag ID to the one that won (04 §6.2). */
const nameTaken = (existingId: string) =>
  new AppError(
    'tag_name_taken',
    409,
    'A tag with that name already exists in this organisation.',
    undefined,
    { existingId },
  );

export function toTagDto(row: TagRow): Tag {
  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    color: row.color as TagColor,
    createdAt: row.createdAt,
  };
}

/** A tag in a live org the actor is a member of; everyone else gets 404. */
export function requireTag(tx: Tx, userId: string, tagId: string): TagRow {
  const row = tx.select().from(tag).where(eq(tag.id, tagId)).get();
  if (row === undefined || !isMember(tx, userId, row.orgId)) throw tagNotFound();
  return row;
}

/**
 * The org's tag with this name, compared case-insensitively. The unique index uses SQLite's
 * NOCASE (ASCII only); comparing lower-cased names here also catches `Ärende`/`ärende`.
 */
export function findTagByName(tx: Tx, orgId: string, name: string): TagRow | undefined {
  const wanted = name.toLowerCase();
  return tx
    .select()
    .from(tag)
    .where(eq(tag.orgId, orgId))
    .all()
    .find((t) => t.name.toLowerCase() === wanted);
}

/** Round-robin over the palette per org (FR-TAG-1): the n-th tag gets colour n mod 10. */
function nextColor(tx: Tx, orgId: string): TagColor {
  const row = tx.select({ n: sql<number>`count(*)` }).from(tag).where(eq(tag.orgId, orgId)).get();
  return TAG_COLORS[(row?.n ?? 0) % TAG_COLORS.length] as TagColor;
}

function normaliseName(raw: string): string {
  const parsed = tagNameSchema.safeParse(raw.replace(/^#+/, ''));
  if (!parsed.success) {
    throw new AppError('validation_failed', 422, 'Invalid tag name.', [
      { path: 'name', message: 'Expected 1–40 characters' },
    ]);
  }
  return parsed.data;
}

export function insertTag(
  tx: Tx,
  input: { orgId: string; name: string; color?: TagColor; id?: string; now: number },
): TagRow {
  const name = normaliseName(input.name);
  const existing = findTagByName(tx, input.orgId, name);
  if (existing !== undefined) throw nameTaken(existing.id);
  const row: TagRow = {
    id: input.id ?? uuidv7(),
    orgId: input.orgId,
    name,
    color: input.color ?? nextColor(tx, input.orgId),
    createdAt: input.now,
  };
  tx.insert(tag).values(row).run();
  return row;
}

/**
 * Tag IDs for a task create (06 §2.4): `tagIds` must be tags of the org (else 422), and
 * `tagNames` are matched case-insensitively or created with the next palette colour.
 * Duplicates are dropped; the order is `tagIds`, then `tagNames`.
 */
export function resolveTagsForCreate(
  tx: Tx,
  input: { orgId: string; tagIds?: readonly string[]; tagNames?: readonly string[]; now: number },
): string[] {
  const out: string[] = [];
  for (const id of input.tagIds ?? []) {
    const row = tx.select({ orgId: tag.orgId }).from(tag).where(eq(tag.id, id)).get();
    if (row === undefined || row.orgId !== input.orgId) {
      throw new AppError('validation_failed', 422, 'Unknown tag.', [
        { path: 'tagIds', message: `No tag ${id} in this organisation` },
      ]);
    }
    if (!out.includes(id)) out.push(id);
  }
  for (const raw of input.tagNames ?? []) {
    const name = normaliseName(raw);
    const row =
      findTagByName(tx, input.orgId, name) ??
      insertTag(tx, { orgId: input.orgId, name, now: input.now });
    if (!out.includes(row.id)) out.push(row.id);
  }
  return out;
}

/**
 * Adds tags to a task (set semantics). `added_at` plus insertion order keep the chip order,
 * so tags added in one call keep the given order.
 */
export function attachTags(
  tx: Tx,
  taskId: string,
  tagIds: readonly string[],
  now: number,
): boolean {
  let changed = false;
  for (const tagId of tagIds) {
    changed =
      tx.insert(taskTag).values({ taskId, tagId, addedAt: now }).onConflictDoNothing().run()
        .changes > 0 || changed;
  }
  return changed;
}

export function detachTag(tx: Tx, taskId: string, tagId: string): boolean {
  return (
    tx
      .delete(taskTag)
      .where(and(eq(taskTag.taskId, taskId), eq(taskTag.tagId, tagId)))
      .run().changes > 0
  );
}

/**
 * Adds or removes one tag on a live task; the tag must belong to the task's org (else 404).
 * Shared by `PUT/DELETE /tasks/:id/tags/:tagId` and the bulk `addTag`/`removeTag`.
 */
export function setTaskTag(
  tx: Tx,
  input: {
    actor: Actor;
    taskId: string;
    tagId: string;
    on: boolean;
    now: number;
    /** The chip-order time of an added tag: the request's edit time. Default `now`. */
    addedAt?: number;
  },
): { row: TaskRow; changed: boolean } {
  const row = requireTask(tx, input.actor.userId, input.taskId);
  authorizeTaskWrite(tx, input.actor, row);
  if (row.deletedAt !== null) throw taskDeleted();
  const t = tx.select({ orgId: tag.orgId }).from(tag).where(eq(tag.id, input.tagId)).get();
  if (t === undefined || t.orgId !== row.orgId) throw tagNotFound();
  const changed = input.on
    ? attachTags(tx, row.id, [input.tagId], input.addedAt ?? input.now)
    : detachTag(tx, row.id, input.tagId);
  if (changed) {
    tx.update(task).set({ updatedAt: input.now }).where(eq(task.id, row.id)).run();
    row.updatedAt = input.now;
  }
  return { row, changed };
}

/** Bumps `updated_at` of every task carrying the tag; returns their IDs. */
function touchTasksWithTag(tx: Tx, tagId: string, now: number): string[] {
  const ids = tx
    .select({ id: taskTag.taskId })
    .from(taskTag)
    .where(eq(taskTag.tagId, tagId))
    .all()
    .map((r) => r.id);
  if (ids.length > 0) tx.update(task).set({ updatedAt: now }).where(inArray(task.id, ids)).run();
  return ids;
}

/**
 * Org tags (FR-TAG, 06 §2.5). Any member of the org may manage its tags. Tags have no field
 * clocks (05 §4.4 lists none): renames and recolours are plain last-arrival-wins.
 */
export class TagService {
  constructor(private readonly deps: ServiceDeps) {}

  private now(): number {
    return this.deps.clock();
  }

  /**
   * Tag changes go to every member (04 §4.5): `['tags', org]`, `['my-list', org]` (chips), and
   * `['task', id]` for each task whose tag set changed (plus `['everyone', org]` in a shared
   * org when there are any).
   */
  private emit(
    tx: Tx,
    actor: Actor,
    type: 'tag.created' | 'tag.updated' | 'tag.deleted' | 'tag.merged',
    orgId: string,
    tagIds: string[],
    taskIds: readonly string[] = [],
  ): void {
    emitAfterCommit(this.deps, tx, {
      type,
      orgId,
      actorId: actor.userId,
      subjects: tagIds,
      audiences: [
        {
          org: orgId,
          userIds: memberIds(tx, orgId),
          keys: [
            qk.tags(orgId),
            qk.myList(orgId),
            ...taskIds.map(qk.task),
            ...(taskIds.length > 0 && isSharedOrg(tx, orgId) ? [qk.everyone(orgId)] : []),
          ],
        },
      ],
    });
  }

  /** The org's tags by name (case-insensitive, then ID). */
  list(actor: Actor, orgRef: string): Tag[] {
    return immediate(this.deps.db, (tx) => {
      const { org } = requireMembership(tx, actor.userId, orgRef);
      authorizeOrg(actor, org.id, 'tasks:read');
      return tx
        .select()
        .from(tag)
        .where(eq(tag.orgId, org.id))
        .orderBy(sql`${tag.name} COLLATE NOCASE`, asc(tag.id))
        .all()
        .map(toTagDto);
    });
  }

  /**
   * Creates a tag; without a colour it gets the next palette colour. A repeated create with
   * the same `id` and name returns the tag; a taken name is `409 tag_name_taken`.
   */
  create(actor: Actor, orgRef: string, input: TagCreate, _meta?: OpMeta): Tag {
    return immediate(this.deps.db, (tx) => {
      const { org } = requireMembership(tx, actor.userId, orgRef);
      authorizeOrgWide(tx, actor, org.id, 'tasks:write');
      if (input.id !== undefined) {
        const existing = tx.select().from(tag).where(eq(tag.id, input.id)).get();
        if (existing !== undefined) {
          if (existing.orgId === org.id && existing.name === normaliseName(input.name)) {
            return toTagDto(existing);
          }
          throw new AppError('id_conflict', 409, 'That ID is already in use.');
        }
      }
      const row = insertTag(tx, {
        orgId: org.id,
        name: input.name,
        ...(input.color === undefined ? {} : { color: input.color }),
        ...(input.id === undefined ? {} : { id: input.id }),
        now: this.now(),
      });
      this.emit(tx, actor, 'tag.created', org.id, [row.id]);
      return toTagDto(row);
    });
  }

  /** Rename and/or recolour. Renaming to another tag's name (any case) is `409`. */
  update(actor: Actor, tagId: string, input: TagPatch, _meta?: OpMeta): Tag {
    return immediate(this.deps.db, (tx) => {
      const row = requireTag(tx, actor.userId, tagId);
      authorizeOrgWide(tx, actor, row.orgId, 'tasks:write');
      const changes: Partial<TagRow> = {};
      if (input.name !== undefined) {
        const name = normaliseName(input.name);
        const clash = findTagByName(tx, row.orgId, name);
        if (clash !== undefined && clash.id !== row.id) throw nameTaken(clash.id);
        changes.name = name;
      }
      if (input.color !== undefined) changes.color = input.color;
      tx.update(tag).set(changes).where(eq(tag.id, row.id)).run();
      touchTasksWithTag(tx, row.id, this.now());
      this.emit(tx, actor, 'tag.updated', row.orgId, [row.id]);
      return toTagDto({ ...row, ...changes });
    });
  }

  /** Deletes the tag and removes it from every task (FR-TAG-3). */
  remove(actor: Actor, tagId: string, _meta?: OpMeta): void {
    immediate(this.deps.db, (tx) => {
      const row = requireTag(tx, actor.userId, tagId);
      authorizeOrgWide(tx, actor, row.orgId, 'tasks:write');
      const tasks = touchTasksWithTag(tx, row.id, this.now());
      tx.delete(tag).where(eq(tag.id, row.id)).run();
      this.emit(tx, actor, 'tag.deleted', row.orgId, [row.id], tasks);
    });
  }

  /**
   * Every task tagged with `tagId` gets `intoId` (keeping the merged tag's slot in its chip
   * order unless it already had `intoId`), then `tagId` is deleted. Both tags must be in the
   * same org; merging a tag into itself is `422`.
   */
  merge(actor: Actor, tagId: string, intoId: string, _meta?: OpMeta): Tag {
    return immediate(this.deps.db, (tx) => {
      const from = requireTag(tx, actor.userId, tagId);
      const into = requireTag(tx, actor.userId, intoId);
      if (into.orgId !== from.orgId) throw tagNotFound();
      authorizeOrgWide(tx, actor, from.orgId, 'tasks:write');
      if (into.id === from.id) {
        throw new AppError('validation_failed', 422, 'A tag cannot be merged into itself.', [
          { path: 'intoId', message: 'Pick another tag' },
        ]);
      }
      const tasks = touchTasksWithTag(tx, from.id, this.now());
      const tagged = tx
        .select()
        .from(taskTag)
        .where(eq(taskTag.tagId, from.id))
        .orderBy(asc(taskTag.addedAt), sql`${taskTag}.rowid`)
        .all();
      for (const t of tagged) {
        tx.insert(taskTag)
          .values({ taskId: t.taskId, tagId: into.id, addedAt: t.addedAt })
          .onConflictDoNothing()
          .run();
      }
      tx.delete(tag).where(eq(tag.id, from.id)).run();
      this.emit(tx, actor, 'tag.merged', into.orgId, [from.id, into.id], tasks);
      return toTagDto(into);
    });
  }

  /**
   * `PUT`/`DELETE /tasks/:id/tags/:tagId`: idempotent set semantics; returns the task. An
   * added tag's `added_at` is the (clamped) edit time, so offline adds keep their chip order.
   */
  setOnTask(actor: Actor, taskId: string, tagId: string, on: boolean, meta?: OpMeta): Task {
    return immediate(this.deps.db, (tx) => {
      const { row, changed } = setTaskTag(tx, {
        actor,
        taskId,
        tagId,
        on,
        now: this.now(),
        ...(meta === undefined ? {} : { addedAt: meta.editTime }),
      });
      if (changed) emitTaskTagged(this.deps, tx, actor, row);
      return taskDtoFor(tx, actor.userId, row);
    });
  }
}

/** A task's tag set changed: a plain task update for its audiences. */
export function emitTaskTagged(deps: ServiceDeps, tx: Tx, actor: Actor, row: TaskRow): void {
  emitAfterCommit(deps, tx, {
    type: 'task.updated',
    orgId: row.orgId,
    actorId: actor.userId,
    subjects: [row.id],
    audiences: taskAudiences(tx, {
      orgId: row.orgId,
      actorId: actor.userId,
      reach: taskReach(tx, [row.id]),
    }),
  });
}
