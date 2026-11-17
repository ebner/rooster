import { compareKeys } from '@rooster/core/ordering';
import type { TaskMoveToOrg, TaskMoveToOrgPreview } from '@rooster/core/schemas';
import { and, eq, inArray, isNull, ne, sql } from 'drizzle-orm';
import {
  activity,
  attachment,
  comment,
  follower,
  notification,
  organization,
  placement,
  tag,
  task,
  taskExpansion,
  taskFormerSeq,
  taskGroup,
  taskReminder,
  taskTag,
} from '../db/schema/index.ts';
import type { Audience } from '../events/bus.ts';
import { AppError } from '../lib/errors.ts';
import { viaFor } from './activity-service.ts';
import { type Actor, emitAfterCommit, type OpMeta, type ServiceDeps, type Tx } from './context.ts';
import { memberIds, qk, taskAudiences, taskReach } from './event-audience.ts';
import {
  authorizeGroupTarget,
  authorizeOrg,
  authorizeOrgWide,
  authorizeTaskWrite,
  capturePriorGroups,
  groupSnapshot,
  requireReadableGroup,
} from './grant-access.ts';
import { listGroups } from './group-service.ts';
import { forgetResponsesMentioning } from './idempotency-store.ts';
import {
  ancestorsOf,
  chunked,
  type GroupRow,
  inboxOf,
  parseClock,
  requireOwnGroup,
  requireTask,
  subtreeOf,
  type TaskRow,
  taskDeleted,
} from './list-access.ts';
import type { NotificationDraft } from './notification-service.ts';
import type { OrderTarget } from './ordering-service.ts';
import { requireMembership } from './org-access.ts';
import type { PlacementService } from './placement-service.ts';
import { indexTasks } from './search-index.ts';
import { insertTag, type TagRow } from './tag-service.ts';
import type { TaskCollab } from './task-service.ts';

/** `ids` of one move (06: bulk ids, 1–200). */
const MAX_IDS = 200;

const invalidIds = (message: string) =>
  new AppError('validation_failed', 422, message, [{ path: 'ids', message }]);

/** Everything a move (or its preview) decides before anything is written (ADR 0072). */
export interface OrgMovePlan {
  sourceId: string;
  target: { id: string; isPersonal: boolean };
  /** The moved roots, in request order. */
  roots: TaskRow[];
  /** Every moved task in tree order: each root, then its subtree depth-first by position. */
  ordered: TaskRow[];
  /** Each moved task's root. */
  rootOf: Map<string, string>;
  /** Each moved task's assignee after the move (ADR 0072 §8). */
  assignees: Map<string, string | null>;
  /** The actor's group the roots land in. */
  group: GroupRow;
  sourceMembers: Set<string>;
  targetMembers: Set<string>;
  /** Each source tag on the moved tasks, with its namesake in the target (if any). */
  tags: { id: string; name: string; match: TagRow | undefined }[];
  /** Tag names the target lacks (deduplicated case-insensitively). */
  newTags: string[];
}

/**
 * The checks shared by the move and its preview: every task live and writable for the actor
 * (404, 403, 410) and in one org (422), the target an org the actor is a member of (404) and
 * not the source (`422 same_org`), the landing group the actor's and writable, the whole subtree
 * writable, and org-wide write in the target when a tag must be created.
 */
export function planOrgMove(
  tx: Tx,
  actor: Actor,
  input: {
    ids: readonly string[];
    orgId: string;
    groupId?: string | null | undefined;
    afterId?: string | null | undefined;
    beforeId?: string | null | undefined;
  },
): OrgMovePlan {
  const ids = [...new Set(input.ids)];
  if (ids.length === 0) throw invalidIds('Name at least one task');
  if (ids.length > MAX_IDS) throw invalidIds(`At most ${MAX_IDS} tasks`);
  const selected = ids.map((id) => {
    const row = requireTask(tx, actor.userId, id);
    authorizeTaskWrite(tx, actor, row);
    if (row.deletedAt !== null) throw taskDeleted();
    return row;
  });
  const sourceId = (selected[0] as TaskRow).orgId;
  if (selected.some((r) => r.orgId !== sourceId)) {
    throw invalidIds('All tasks must be in the same organisation');
  }
  const { org: target } = requireMembership(tx, actor.userId, input.orgId);
  authorizeOrg(actor, target.id, 'tasks:write');
  if (target.id === sourceId) {
    throw new AppError('same_org', 422, 'The tasks are already in that organisation.');
  }

  // A selected task whose ancestor is selected too travels with the ancestor.
  const selectedIds = new Set(ids);
  const roots = selected.filter((r) => !ancestorsOf(tx, r).some((a) => selectedIds.has(a.id)));

  // The whole subtrees, deleted descendants included (05 §4.3: a subtask stays with its parent).
  const subtree = subtreeOf(
    tx,
    roots.map((r) => r.id),
  );
  const rows = new Map<string, TaskRow>();
  for (const chunk of chunked(subtree.map((r) => r.id))) {
    for (const r of tx.select().from(task).where(inArray(task.id, chunk)).all()) rows.set(r.id, r);
  }
  const children = new Map<string, TaskRow[]>();
  for (const r of rows.values()) {
    if (r.parentId === null || !rows.has(r.parentId)) continue;
    const list = children.get(r.parentId) ?? [];
    list.push(r);
    children.set(r.parentId, list);
  }
  for (const list of children.values()) {
    list.sort(
      (a, b) =>
        compareKeys(a.subtaskPosition ?? '', b.subtaskPosition ?? '') || compareKeys(a.id, b.id),
    );
  }
  const rootIds = new Set(roots.map((r) => r.id));
  const ordered: TaskRow[] = [];
  const rootOf = new Map<string, string>();
  const visit = (row: TaskRow, root: string) => {
    if (rootOf.has(row.id)) return;
    rootOf.set(row.id, root);
    ordered.push(row);
    for (const child of children.get(row.id) ?? []) {
      if (!rootIds.has(child.id)) visit(child, root);
    }
  };
  for (const root of roots) visit(rows.get(root.id) ?? root, root.id);

  // A grant needs write on every moved task, not only the selected ones (like delete).
  if (actor.grant !== null) {
    for (const r of ordered) if (!rootIds.has(r.id)) authorizeTaskWrite(tx, actor, r);
  }

  let group: GroupRow;
  if (input.groupId !== undefined && input.groupId !== null) {
    group = requireOwnGroup(tx, actor.userId, input.groupId, { orgId: target.id });
    requireReadableGroup(actor, target.id, group.id);
  } else if (typeof input.afterId === 'string' || typeof input.beforeId === 'string') {
    // An intent without a group (undo, the later chunks of a big selection): the group of the
    // anchor task in the actor's list in the target org.
    const field = typeof input.afterId === 'string' ? 'afterId' : 'beforeId';
    const anchor = (input.afterId ?? input.beforeId) as string;
    const placed = tx
      .select({ group: taskGroup })
      .from(placement)
      .innerJoin(taskGroup, eq(taskGroup.id, placement.groupId))
      .where(
        and(
          eq(placement.taskId, anchor),
          eq(placement.userId, actor.userId),
          eq(placement.orgId, target.id),
          isNull(taskGroup.deletedAt),
        ),
      )
      .get();
    if (placed === undefined) {
      const message = 'Not a task in your list in the target organisation';
      throw new AppError('validation_failed', 422, 'The ordering anchor is not in your list.', [
        { path: field, message },
      ]);
    }
    group = placed.group;
    requireReadableGroup(actor, target.id, group.id);
  } else {
    group =
      listGroups(tx, actor.userId, target.id).find((g) => g.kind === 'normal') ??
      inboxOf(tx, actor.userId, target.id);
  }
  authorizeGroupTarget(tx, actor, target.id, group.id);

  const sourceMembers = new Set(memberIds(tx, sourceId));
  const targetMembers = new Set(memberIds(tx, target.id));

  // Roots become the mover's; a descendant keeps an assignee who is a target member, else
  // takes its new parent's. Unassigned stays unassigned, except in a personal org (FR-COL-6).
  const assignees = new Map<string, string | null>();
  for (const r of ordered) {
    let next: string | null;
    if (rootIds.has(r.id) || target.isPersonal) next = actor.userId;
    else if (r.assigneeId === null || targetMembers.has(r.assigneeId)) next = r.assigneeId;
    else next = assignees.get(r.parentId ?? '') ?? null;
    assignees.set(r.id, next);
  }

  const targetTags = new Map(
    tx
      .select()
      .from(tag)
      .where(eq(tag.orgId, target.id))
      .all()
      .map((t) => [t.name.toLowerCase(), t]),
  );
  const tags = new Map<string, { id: string; name: string; match: TagRow | undefined }>();
  for (const chunk of chunked(ordered.map((r) => r.id))) {
    for (const t of tx
      .select({ id: tag.id, name: tag.name })
      .from(taskTag)
      .innerJoin(tag, eq(tag.id, taskTag.tagId))
      .where(inArray(taskTag.taskId, chunk))
      .all()) {
      if (!tags.has(t.id)) tags.set(t.id, { ...t, match: targetTags.get(t.name.toLowerCase()) });
    }
  }
  const newTags: string[] = [];
  const seen = new Set<string>();
  for (const t of tags.values()) {
    const key = t.name.toLowerCase();
    if (t.match !== undefined || seen.has(key)) continue;
    seen.add(key);
    newTags.push(t.name);
  }
  // Creating a tag is an org-wide write (as for `tagNames` on create).
  if (newTags.length > 0) authorizeOrgWide(tx, actor, target.id, 'tasks:write');

  return {
    sourceId,
    target: { id: target.id, isPersonal: target.isPersonal },
    roots,
    ordered,
    rootOf,
    assignees,
    group,
    sourceMembers,
    targetMembers,
    tags: [...tags.values()],
    newTags,
  };
}

/** GET /tasks/move-to-org/preview (ADR 0072 §19). */
export function previewOrgMove(tx: Tx, actor: Actor, plan: OrgMovePlan): TaskMoveToOrgPreview {
  const ids = plan.ordered.map((r) => r.id);
  let comments = 0;
  let attachments = 0;
  for (const chunk of chunked(ids)) {
    comments +=
      tx
        .select({ n: sql<number>`count(*)` })
        .from(comment)
        .where(
          and(
            inArray(comment.taskId, chunk),
            isNull(comment.deletedAt),
            ne(comment.authorId, actor.userId),
          ),
        )
        .get()?.n ?? 0;
    attachments +=
      tx
        .select({ n: sql<number>`count(*)` })
        .from(attachment)
        .where(
          and(
            inArray(attachment.taskId, chunk),
            isNull(attachment.deletedAt),
            ne(attachment.uploaderId, actor.userId),
          ),
        )
        .get()?.n ?? 0;
  }
  const newcomer = [...plan.targetMembers].some((u) => !plan.sourceMembers.has(u));
  return {
    tasks: plan.roots.length,
    subtasks: plan.ordered.length - plan.roots.length,
    comments,
    attachments,
    exposes: comments + attachments > 0 && newcomer,
    newTags: plan.newTags,
    reassigned: plan.ordered.filter((r) => plan.assignees.get(r.id) !== r.assigneeId).length,
  };
}

/** Who and what a move writes with. */
export interface OrgMoveContext {
  deps: ServiceDeps;
  placements: PlacementService;
  collab: TaskCollab;
}

/**
 * POST /tasks/move-to-org (ADR 0072), inside the caller's transaction, after `planOrgMove`.
 * Returns every moved task's ID in tree order.
 */
export function executeOrgMove(
  ctx: OrgMoveContext,
  tx: Tx,
  actor: Actor,
  plan: OrgMovePlan,
  input: Pick<TaskMoveToOrg, 'afterId' | 'beforeId'>,
  meta: OpMeta,
): string[] {
  const { deps, placements, collab } = ctx;
  const now = deps.clock();
  const sourceId = plan.sourceId;
  const targetId = plan.target.id;
  const allIds = plan.ordered.map((r) => r.id);
  const rootIds = plan.roots.map((r) => r.id);
  const rootSet = new Set(rootIds);
  const losing = (userId: string) => !plan.targetMembers.has(userId);

  // Who could see the tasks before (the source org's lists, the old parents of detached
  // subtasks) and, for grant streams reading only some groups, where the tasks were.
  const before = taskReach(tx, rootIds);
  const priors = deps.events.hasRestrictedGrantStream(sourceId)
    ? capturePriorGroups(tx, rootIds)
    : undefined;

  // ADR 0072 §15: the assignees and active followers of the moved (live) tasks who lose them.
  const told = new Map<string, Set<string>>();
  const tell = (userId: string | null, taskId: string) => {
    if (userId === null || userId === actor.userId || !losing(userId)) return;
    const root = plan.rootOf.get(taskId);
    if (root === undefined) return;
    const users = told.get(root) ?? new Set<string>();
    users.add(userId);
    told.set(root, users);
  };
  const live = plan.ordered.filter((r) => r.deletedAt === null);
  for (const r of live) tell(r.assigneeId, r.id);
  for (const chunk of chunked(live.map((r) => r.id))) {
    for (const f of tx
      .select({ taskId: follower.taskId, userId: follower.userId })
      .from(follower)
      .where(and(inArray(follower.taskId, chunk), eq(follower.muted, false)))
      .all()) {
      tell(f.userId, f.taskId);
    }
  }

  // §14: rows bound to a membership go for people outside the target; a personal target has
  // no followers at all.
  const inbox = new Set<string>();
  for (const chunk of chunked(allIds)) {
    const followerUsers = tx
      .selectDistinct({ userId: follower.userId })
      .from(follower)
      .where(inArray(follower.taskId, chunk))
      .all()
      .map((r) => r.userId)
      .filter((u) => plan.target.isPersonal || losing(u));
    if (followerUsers.length > 0) {
      tx.delete(follower)
        .where(and(inArray(follower.taskId, chunk), inArray(follower.userId, followerUsers)))
        .run();
    }
    const reminderUsers = tx
      .selectDistinct({ userId: taskReminder.userId })
      .from(taskReminder)
      .where(inArray(taskReminder.taskId, chunk))
      .all()
      .map((r) => r.userId)
      .filter(losing);
    if (reminderUsers.length > 0) {
      tx.delete(taskReminder)
        .where(
          and(inArray(taskReminder.taskId, chunk), inArray(taskReminder.userId, reminderUsers)),
        )
        .run();
    }
    const expansionUsers = tx
      .selectDistinct({ userId: taskExpansion.userId })
      .from(taskExpansion)
      .where(inArray(taskExpansion.taskId, chunk))
      .all()
      .map((r) => r.userId)
      .filter(losing);
    if (expansionUsers.length > 0) {
      tx.delete(taskExpansion)
        .where(
          and(inArray(taskExpansion.taskId, chunk), inArray(taskExpansion.userId, expansionUsers)),
        )
        .run();
    }
    for (const n of tx
      .select({ id: notification.id, userId: notification.userId })
      .from(notification)
      .where(inArray(notification.taskId, chunk))
      .all()) {
      inbox.add(n.userId);
      if (losing(n.userId)) tx.delete(notification).where(eq(notification.id, n.id)).run();
    }
  }

  // §7: new numbers in tree order; a task that was in the target before gets its number back.
  const seqs = new Map<string, number | null>();
  for (const r of plan.ordered) {
    const former = tx
      .select({ seq: taskFormerSeq.seq })
      .from(taskFormerSeq)
      .where(and(eq(taskFormerSeq.taskId, r.id), eq(taskFormerSeq.orgId, targetId)))
      .get();
    let seq: number | null;
    if (former !== undefined) {
      tx.delete(taskFormerSeq)
        .where(and(eq(taskFormerSeq.orgId, targetId), eq(taskFormerSeq.seq, former.seq)))
        .run();
      seq = former.seq;
    } else {
      seq =
        tx
          .update(organization)
          .set({ taskSeq: sql`${organization.taskSeq} + 1` })
          .where(eq(organization.id, targetId))
          .returning({ taskSeq: organization.taskSeq })
          .get()?.taskSeq ?? null;
    }
    seqs.set(r.id, seq);
    if (r.seq !== null) {
      const values = { orgId: sourceId, seq: r.seq, taskId: r.id, movedAt: now };
      tx.insert(taskFormerSeq)
        .values(values)
        .onConflictDoUpdate({
          target: [taskFormerSeq.orgId, taskFormerSeq.seq],
          set: { taskId: r.id, movedAt: now },
        })
        .run();
    }
  }

  // The rows: org, number, assignee; a detached root leaves its parent (§3); `pos:*` clocks
  // named the old placements (§10).
  const stamp = (clock: Record<string, number>, key: string) => {
    clock[key] = Math.max(clock[key] ?? Number.NEGATIVE_INFINITY, meta.editTime);
  };
  for (const r of plan.ordered) {
    const clock = parseClock(r.fieldClock);
    for (const key of Object.keys(clock)) if (key.startsWith('pos:')) delete clock[key];
    const detach = rootSet.has(r.id) && r.parentId !== null;
    if (detach) stamp(clock, 'parent');
    const assigneeId = plan.assignees.get(r.id) ?? null;
    if (assigneeId !== r.assigneeId) stamp(clock, 'assignee');
    tx.update(task)
      .set({
        orgId: targetId,
        seq: seqs.get(r.id) ?? null,
        assigneeId,
        ...(detach ? { parentId: null, subtaskPosition: null } : {}),
        fieldClock: JSON.stringify(clock),
        updatedAt: now,
      })
      .where(eq(task.id, r.id))
      .run();
  }

  // §9: tags by name in the target, created when missing (chip order kept).
  const created = new Map<string, TagRow>();
  for (const t of plan.tags) {
    const key = t.name.toLowerCase();
    let to = t.match ?? created.get(key);
    if (to === undefined) {
      to = insertTag(tx, { orgId: targetId, name: t.name, now });
      created.set(key, to);
    }
    for (const chunk of chunked(allIds)) {
      const tagged = tx
        .select({ taskId: taskTag.taskId, addedAt: taskTag.addedAt })
        .from(taskTag)
        .where(and(eq(taskTag.tagId, t.id), inArray(taskTag.taskId, chunk)))
        .orderBy(sql`${taskTag}.rowid`)
        .all();
      if (tagged.length === 0) continue;
      tx.delete(taskTag)
        .where(
          and(
            eq(taskTag.tagId, t.id),
            inArray(
              taskTag.taskId,
              tagged.map((x) => x.taskId),
            ),
          ),
        )
        .run();
      for (const x of tagged) {
        tx.insert(taskTag)
          .values({ taskId: x.taskId, tagId: to.id, addedAt: x.addedAt })
          .onConflictDoNothing()
          .run();
      }
    }
  }

  // §12, §14: the task's history and files follow; kept notifications are re-pointed.
  for (const chunk of chunked(allIds)) {
    tx.update(activity).set({ orgId: targetId }).where(inArray(activity.taskId, chunk)).run();
    tx.update(attachment).set({ orgId: targetId }).where(inArray(attachment.taskId, chunk)).run();
  }
  for (const r of plan.ordered) {
    tx.update(notification)
      .set({
        orgId: targetId,
        data: sql`json_set(${notification.data}, '$.taskSeq', ${seqs.get(r.id) ?? null})`,
      })
      .where(eq(notification.taskId, r.id))
      .run();
  }

  // §6: every old placement goes; the roots land together in the mover's group, and the
  // descendants are reconciled against their new assignees (all target members by now).
  for (const chunk of chunked(allIds)) {
    tx.delete(placement).where(inArray(placement.taskId, chunk)).run();
  }
  const intent: OrderTarget =
    input.afterId !== undefined || input.beforeId !== undefined
      ? {
          ...(input.afterId === undefined ? {} : { afterId: input.afterId }),
          ...(input.beforeId === undefined ? {} : { beforeId: input.beforeId }),
        }
      : 'top';
  placements.placeInGroup(tx, {
    userId: actor.userId,
    group: plan.group,
    taskIds: rootIds,
    target: intent,
  });
  placements.reconcilePlacements(tx, allIds);
  // Every moved task the mover now has in their list must sit where the grant may write.
  if (actor.grant !== null) {
    for (const [, group] of groupSnapshot(tx, actor.userId, allIds)) {
      authorizeGroupTarget(tx, actor, targetId, group);
    }
  }

  indexTasks(tx, allIds);

  const scope = {
    actorId: actor.userId,
    via: viaFor(actor, meta),
    grantId: actor.grant?.id ?? null,
  };
  for (const root of plan.roots) {
    collab.activity.record(tx, { id: root.id, orgId: targetId }, scope, {
      type: 'org_moved',
      data: { fromOrgId: sourceId, toOrgId: targetId },
    });
  }
  for (const r of plan.ordered) {
    const assigneeId = plan.assignees.get(r.id) ?? null;
    const users: (string | null)[] = rootSet.has(r.id) ? [actor.userId] : [];
    if (assigneeId !== r.assigneeId) users.push(assigneeId);
    if (users.length > 0) collab.followers.autoFollow(tx, { id: r.id, orgId: targetId }, users);
  }

  const drafts: NotificationDraft[] = [];
  for (const root of plan.roots) {
    for (const userId of told.get(root.id) ?? []) {
      drafts.push({
        userId,
        orgId: sourceId,
        type: 'moved_away',
        taskId: null,
        actorId: actor.userId,
        data: { taskTitle: root.title },
      });
    }
  }
  collab.notifications.notify(tx, drafts);

  // Replays must not hand the moved tasks back to people who lost them (as on member removal).
  forgetResponsesMentioning(tx, [...plan.sourceMembers].filter(losing), allIds);

  // §17: both orgs' audiences, and the inboxes whose notifications went or changed.
  const audiences: Audience[] = [
    ...taskAudiences(tx, { orgId: sourceId, actorId: actor.userId, reach: before, trash: true }),
    ...taskAudiences(tx, {
      orgId: targetId,
      actorId: actor.userId,
      reach: taskReach(tx, rootIds),
      trash: true,
      activity: rootIds,
    }),
  ];
  if (created.size > 0) {
    audiences.push({ org: targetId, userIds: memberIds(tx, targetId), keys: [qk.tags(targetId)] });
  }
  emitAfterCommit(deps, tx, {
    type: 'task.org_moved',
    orgId: sourceId,
    actorId: actor.userId,
    subjects: rootIds,
    audiences,
    ...(priors === undefined ? {} : { priorGroups: priors }),
  });
  collab.notifications.announceRemoved(tx, [...inbox], actor.userId);
  return allIds;
}
