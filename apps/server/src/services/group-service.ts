import { canRead } from '@rooster/core/grants';
import { uuidv7 } from '@rooster/core/ids';
import type {
  Group,
  GroupCreate,
  GroupCreateResult,
  GroupDelete,
  GroupMoveResult,
  GroupPatch,
  OrderingIntent,
} from '@rooster/core/schemas';
import { and, asc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { placement, task, taskGroup } from '../db/schema/index.ts';
import type { Audience, DomainEventType } from '../events/bus.ts';
import { AppError } from '../lib/errors.ts';
import {
  type Actor,
  emitAfterCommit,
  immediate,
  type OpMeta,
  type ServiceDeps,
  type Tx,
} from './context.ts';
import { qk, selfAudience, taskAudiences, taskReach } from './event-audience.ts';
import {
  authorizeOrgWide,
  authorizeTaskWrite,
  canReadTask,
  requireReadableGroup,
  requireScope,
} from './grant-access.ts';
import {
  chunked,
  clockAllows,
  descendantsOf,
  type GroupRow,
  groupDomain,
  inboxOf,
  parseClock,
  placementDomain,
  placementOf,
  requireOwnGroup,
  requireTask,
  softDeleteTasks,
  taskDeleted,
  taskNotFound,
  toGroupDto,
} from './list-access.ts';
import type { OrderingService, OrderTarget } from './ordering-service.ts';
import { requireMembership } from './org-access.ts';
import type { PlacementService } from './placement-service.ts';
import { indexTasks } from './search-index.ts';

const inboxImmutable = () =>
  new AppError('inbox_immutable', 409, 'The Inbox cannot be renamed, moved or deleted.');

/** The user's live groups in an org: the Inbox first, then `ORDER BY position, id`. */
export function listGroups(tx: Tx, userId: string, orgId: string): GroupRow[] {
  return tx
    .select()
    .from(taskGroup)
    .where(
      and(eq(taskGroup.userId, userId), eq(taskGroup.orgId, orgId), isNull(taskGroup.deletedAt)),
    )
    .orderBy(
      sql`CASE WHEN ${taskGroup.kind} = 'inbox' THEN 0 ELSE 1 END`,
      asc(taskGroup.position),
      asc(taskGroup.id),
    )
    .all();
}

/** Personal groups in My tasks (FR-GRP, 05 §4.2). Groups are owned: others get 404. */
export class GroupService {
  constructor(
    private readonly deps: ServiceDeps,
    private readonly ordering: OrderingService,
    private readonly placements: PlacementService,
  ) {}

  /**
   * Groups are personal: a change goes to their owner only (04 §4.5). Tasks deleted or
   * restored together with a group reach everyone who can see them (`taskIds`).
   */
  private emit(
    tx: Tx,
    actor: Actor,
    type: DomainEventType,
    group: Pick<GroupRow, 'id' | 'orgId'>,
    taskIds: readonly string[] = [],
  ): void {
    const audiences: Audience[] = [
      selfAudience(actor.userId, group.orgId, [qk.myList(group.orgId)]),
    ];
    if (taskIds.length > 0) {
      audiences.push(
        ...taskAudiences(tx, {
          orgId: group.orgId,
          actorId: actor.userId,
          reach: taskReach(tx, taskIds),
          trash: true,
        }),
      );
    }
    emitAfterCommit(this.deps, tx, {
      type,
      orgId: group.orgId,
      actorId: actor.userId,
      subjects: [group.id],
      audiences,
    });
  }

  /**
   * Creates a group at the intent (default: the end). With `splitAfterTaskId` (Tab+N, 02 §4)
   * the group goes directly after that task's group (at the top when that is the Inbox), and
   * every placement below the task moves into it with its key unchanged, so the order is
   * kept exactly. A repeated create with the same client `id` returns the group again.
   */
  create(actor: Actor, orgRef: string, input: GroupCreate, _meta?: OpMeta): GroupCreateResult {
    return immediate(this.deps.db, (tx) => {
      const { org } = requireMembership(tx, actor.userId, orgRef);
      authorizeOrgWide(tx, actor, org.id, 'groups:write');
      const now = this.deps.clock();
      if (input.id !== undefined) {
        const existing = tx.select().from(taskGroup).where(eq(taskGroup.id, input.id)).get();
        if (existing !== undefined) {
          // A group the grant cannot read is simply "in use" (like anyone else's): its name is
          // never compared, nor its DTO returned.
          if (
            actor.grant !== null &&
            !canRead(actor.grant.constraints, existing.orgId, existing.id)
          ) {
            throw new AppError('id_conflict', 409, 'That ID is already in use.');
          }
          const same =
            existing.userId === actor.userId &&
            existing.orgId === org.id &&
            existing.name === input.name &&
            existing.deletedAt === null;
          if (!same) throw new AppError('id_conflict', 409, 'That ID is already in use.');
          return { group: toGroupDto(existing), moved: [] };
        }
      }

      let target: OrderTarget = readableIntent(actor, org.id, input);
      let movedIds: string[] = [];
      if (input.splitAfterTaskId !== undefined) {
        // The split moves tasks into the new group: a task move, beyond `groups:write`.
        requireScope(actor, 'tasks:write');
        const split = this.splitSource(tx, actor, org.id, input.splitAfterTaskId, now);
        target = split.source.kind === 'inbox' ? 'top' : { afterId: split.source.id };
        movedIds = split.below;
      }

      const domain = groupDomain(tx, { userId: actor.userId, orgId: org.id, now });
      const [position] = this.ordering.place(domain, target).keys as [string];
      const row: GroupRow = {
        id: input.id ?? uuidv7(),
        orgId: org.id,
        userId: actor.userId,
        kind: 'normal',
        name: input.name,
        position,
        collapsed: false,
        fieldClock: '{}',
        createdAt: now,
        updatedAt: now,
        deletedAt: null,
      };
      tx.insert(taskGroup).values(row).run();
      this.emit(tx, actor, 'group.created', row);

      if (movedIds.length === 0) return { group: toGroupDto(row), moved: [] };
      tx.update(placement)
        .set({ groupId: row.id, updatedAt: now })
        .where(inArray(placement.taskId, movedIds))
        .run();
      const moved = tx
        .select({
          taskId: placement.taskId,
          groupId: placement.groupId,
          position: placement.position,
        })
        .from(placement)
        .innerJoin(task, eq(task.id, placement.taskId))
        .where(and(inArray(placement.taskId, movedIds), isNull(task.deletedAt)))
        .orderBy(asc(placement.position), asc(placement.taskId))
        .all();
      return { group: toGroupDto(row), moved };
    });
  }

  /** The split task's group and every placement below the task in it (any state). */
  private splitSource(tx: Tx, actor: Actor, orgId: string, taskId: string, now: number) {
    const userId = actor.userId;
    const row = requireTask(tx, userId, taskId);
    if (row.orgId !== orgId) throw taskNotFound();
    // A task the grant cannot read is 404 before anything else about it (deleted or not).
    if (!canReadTask(tx, actor, row)) throw taskNotFound();
    if (row.deletedAt !== null) throw taskDeleted();
    const place = placementOf(tx, taskId);
    if (place === undefined || place.userId !== userId) throw taskNotFound();
    const source = requireOwnGroup(tx, userId, place.groupId);
    requireReadableGroup(actor, orgId, source.id);
    const { items } = placementDomain(tx, { userId, orgId, groupId: source.id, now });
    const index = items.findIndex((i) => i.id === taskId);
    return { source, below: items.slice(index + 1).map((i) => i.id) };
  }

  /** Rename and collapse, per-field LWW (`name`, `collapsed`). The Inbox keeps its name. */
  update(actor: Actor, groupId: string, patch: GroupPatch, meta: OpMeta): Group {
    return immediate(this.deps.db, (tx) => {
      const group = requireOwnGroup(tx, actor.userId, groupId);
      // A group the grant cannot read is 404, like an unknown one (11 §2.3).
      requireReadableGroup(actor, group.orgId, group.id);
      authorizeOrgWide(tx, actor, group.orgId, 'groups:write');
      if (patch.name !== undefined && group.kind === 'inbox') throw inboxImmutable();
      const clock = parseClock(group.fieldClock);
      const changes: Partial<GroupRow> = {};
      if (patch.name !== undefined && clockAllows(clock, 'name', meta.editTime)) {
        changes.name = patch.name;
        clock.name = meta.editTime;
      }
      if (patch.collapsed !== undefined && clockAllows(clock, 'collapsed', meta.editTime)) {
        changes.collapsed = patch.collapsed;
        clock.collapsed = meta.editTime;
      }
      if (Object.keys(changes).length === 0) return toGroupDto(group);
      const next = {
        ...changes,
        fieldClock: JSON.stringify(clock),
        updatedAt: this.deps.clock(),
      };
      tx.update(taskGroup).set(next).where(eq(taskGroup.id, group.id)).run();
      this.emit(tx, actor, 'group.updated', group);
      return toGroupDto({ ...group, ...next });
    });
  }

  /** Reorders a group among the user's normal groups (LWW key `pos`). */
  move(actor: Actor, groupId: string, intent: OrderingIntent, meta: OpMeta): GroupMoveResult {
    return immediate(this.deps.db, (tx) => {
      const group = requireOwnGroup(tx, actor.userId, groupId);
      // A group the grant cannot read is 404, like an unknown one (11 §2.3).
      requireReadableGroup(actor, group.orgId, group.id);
      authorizeOrgWide(tx, actor, group.orgId, 'groups:write');
      if (group.kind === 'inbox') throw inboxImmutable();
      const clock = parseClock(group.fieldClock);
      if (!clockAllows(clock, 'pos', meta.editTime)) return { position: group.position };
      const now = this.deps.clock();
      const domain = groupDomain(tx, { userId: actor.userId, orgId: group.orgId, now }, [group.id]);
      const [position] = this.ordering.place(domain, readableIntent(actor, group.orgId, intent))
        .keys as [string];
      clock.pos = meta.editTime;
      tx.update(taskGroup)
        .set({ position, fieldClock: JSON.stringify(clock), updatedAt: now })
        .where(eq(taskGroup.id, group.id))
        .run();
      this.emit(tx, actor, 'group.moved', group);
      return { position };
    });
  }

  /**
   * Deletes a group (05 §4.2, FR-GRP-3). A group with open tasks needs `moveTasksTo` (all
   * its placements, deleted tasks' included, go to the end of the target in order) or
   * `deleteTasks` (its tasks are soft-deleted together with it). Without either, completed
   * tasks left in the group move to the end of the Inbox. The last normal group stays.
   * LWW key `deleted`, shared with restore: a delete older than the last restore is a no-op.
   */
  remove(actor: Actor, groupId: string, input: GroupDelete, meta?: OpMeta): void {
    immediate(this.deps.db, (tx) => {
      const group = requireOwnGroup(tx, actor.userId, groupId);
      // A group the grant cannot read is 404, like an unknown one (11 §2.3).
      requireReadableGroup(actor, group.orgId, group.id);
      authorizeOrgWide(tx, actor, group.orgId, 'groups:write');
      requireScope(actor, 'tasks:delete');
      if (group.kind === 'inbox') throw inboxImmutable();
      const clock = parseClock(group.fieldClock);
      const editTime = meta?.editTime ?? this.deps.clock();
      if (input.moveTasksTo !== undefined && input.deleteTasks === true) {
        throw new AppError('validation_failed', 422, 'Choose moveTasksTo or deleteTasks.', [
          { path: 'moveTasksTo', message: 'Not allowed together with deleteTasks' },
        ]);
      }
      if (!clockAllows(clock, 'deleted', editTime)) return;
      clock.deleted = editTime;
      const now = this.deps.clock();
      const normals = groupDomain(tx, { userId: actor.userId, orgId: group.orgId, now }).items;
      if (normals.length <= 1) {
        throw new AppError('last_group', 409, 'Keep at least one group besides the Inbox.');
      }
      const placed = tx
        .select({
          id: placement.taskId,
          deletedAt: task.deletedAt,
          completedAt: task.completedAt,
        })
        .from(placement)
        .innerJoin(task, eq(task.id, placement.taskId))
        .where(eq(placement.groupId, group.id))
        .orderBy(asc(placement.position), asc(placement.taskId))
        .all();
      const live = placed.filter((p) => p.deletedAt === null);
      let deletedTaskIds: string[] = [];

      if (input.moveTasksTo !== undefined) {
        if (input.moveTasksTo === group.id) {
          throw new AppError('validation_failed', 422, 'Move the tasks to another group.', [
            { path: 'moveTasksTo', message: 'Must be a different group' },
          ]);
        }
        const target = requireOwnGroup(tx, actor.userId, input.moveTasksTo, {
          orgId: group.orgId,
        });
        requireReadableGroup(actor, group.orgId, target.id);
        this.placements.placeInGroup(tx, {
          userId: actor.userId,
          group: target,
          taskIds: placed.map((p) => p.id),
          target: 'end',
        });
      } else if (input.deleteTasks === true) {
        deletedTaskIds = live.map((p) => p.id);
        this.authorizeCascade(
          tx,
          actor,
          [...deletedTaskIds, ...descendantsOf(tx, deletedTaskIds, { deletedAt: null })],
          'tasks:delete',
        );
        softDeleteTasks(tx, deletedTaskIds, { userId: actor.userId, now });
      } else {
        if (live.some((p) => p.completedAt === null)) {
          throw new AppError(
            'group_not_empty',
            409,
            'The group has tasks: choose moveTasksTo or deleteTasks.',
          );
        }
        this.placements.placeInGroup(tx, {
          userId: actor.userId,
          group: inboxOf(tx, actor.userId, group.orgId),
          taskIds: live.map((p) => p.id),
          target: 'end',
        });
      }
      tx.update(taskGroup)
        .set({ deletedAt: now, updatedAt: now, fieldClock: JSON.stringify(clock) })
        .where(eq(taskGroup.id, group.id))
        .run();
      this.emit(tx, actor, 'group.deleted', group, deletedTaskIds);
    });
  }

  /**
   * A grant's group delete or restore must reach every task it cascades to, as a task delete or
   * restore must (TaskService `authorizeSubtree`): a subtask placed in a group the grant cannot
   * read, or cannot write, rejects the whole operation (the transaction rolls back).
   */
  private authorizeCascade(
    tx: Tx,
    actor: Actor,
    ids: readonly string[],
    scope: 'tasks:write' | 'tasks:delete',
  ): void {
    if (actor.grant === null || ids.length === 0) return;
    for (const chunk of chunked([...ids])) {
      for (const row of tx.select().from(task).where(inArray(task.id, chunk)).all()) {
        authorizeTaskWrite(tx, actor, row, scope);
      }
    }
  }

  /**
   * Undoes a delete: the group returns at its old position, together with the tasks that
   * were deleted with it (same `deleted_at`). LWW key `deleted`: a restore older than the
   * delete is a no-op that returns the group as it is.
   */
  restore(actor: Actor, groupId: string, meta?: OpMeta): Group {
    return immediate(this.deps.db, (tx) => {
      const group = requireOwnGroup(tx, actor.userId, groupId, { includeDeleted: true });
      // A group the grant cannot read is 404, like an unknown one (11 §2.3).
      requireReadableGroup(actor, group.orgId, group.id);
      authorizeOrgWide(tx, actor, group.orgId, 'groups:write');
      requireScope(actor, 'tasks:write');
      if (group.deletedAt === null) return toGroupDto(group);
      const clock = parseClock(group.fieldClock);
      const editTime = meta?.editTime ?? this.deps.clock();
      if (!clockAllows(clock, 'deleted', editTime)) return toGroupDto(group);
      clock.deleted = editTime;
      const deletedAt = group.deletedAt;
      const now = this.deps.clock();
      const fieldClock = JSON.stringify(clock);
      tx.update(taskGroup)
        .set({ deletedAt: null, updatedAt: now, fieldClock })
        .where(eq(taskGroup.id, group.id))
        .run();
      const ids = tx
        .select({ id: task.id })
        .from(placement)
        .innerJoin(task, eq(task.id, placement.taskId))
        .where(and(eq(placement.groupId, group.id), eq(task.deletedAt, deletedAt)))
        .all()
        .map((r) => r.id);
      const all = [...ids, ...descendantsOf(tx, ids, { deletedAt })];
      this.authorizeCascade(tx, actor, all, 'tasks:write');
      if (all.length > 0) {
        // Chunked: a group may hold more tasks than SQLite takes bound parameters.
        for (const chunk of chunked(all)) {
          tx.update(task)
            .set({ deletedAt: null, deletedBy: null, updatedAt: now })
            .where(inArray(task.id, chunk))
            .run();
        }
        indexTasks(tx, all);
      }
      this.emit(tx, actor, 'group.restored', group, ids);
      return toGroupDto({ ...group, deletedAt: null, updatedAt: now, fieldClock });
    });
  }
}

/** A client intent as an ordering target; no intent at all means the end of the domain. */
/**
 * `intentOf` for a grant: a neighbour group it cannot read counts as unknown (the end), so the
 * resulting position never tells a hidden group from a missing one.
 */
function readableIntent(actor: Actor, orgId: string, input: OrderingIntent): OrderTarget {
  const grant = actor.grant;
  if (grant !== null) {
    for (const id of [input.afterId, input.beforeId]) {
      if (typeof id === 'string' && !canRead(grant.constraints, orgId, id)) return 'end';
    }
  }
  return intentOf(input);
}

function intentOf(input: OrderingIntent): OrderTarget {
  const intent: OrderingIntent = {};
  if (input.afterId !== undefined) intent.afterId = input.afterId;
  if (input.beforeId !== undefined) intent.beforeId = input.beforeId;
  return intent;
}
