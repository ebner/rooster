import { and, eq, inArray } from 'drizzle-orm';
import { member, organization, placement, task } from '../db/schema/index.ts';
import type { Audience, QueryKey } from '../events/bus.ts';
import type { Tx } from './context.ts';
import { chunked, subtreeOf, subtreePlacements } from './list-access.ts';

/** The query-key prefixes of the SSE contract (`@rooster/core/schemas/events.ts`). */
export const qk = {
  myList: (orgId: string): QueryKey => ['my-list', orgId],
  task: (taskId: string): QueryKey => ['task', taskId],
  tags: (orgId: string): QueryKey => ['tags', orgId],
  trash: (orgId: string): QueryKey => ['trash', orgId],
  orgMembers: (orgId: string): QueryKey => ['org-members', orgId],
  orgInvites: (orgId: string): QueryKey => ['org-invites', orgId],
  everyone: (orgId: string): QueryKey => ['everyone', orgId],
  activity: (taskId: string): QueryKey => ['activity', taskId],
  notifications: ['notifications'] as QueryKey,
  me: ['me'] as QueryKey,
  orgs: ['orgs'] as QueryKey,
} as const;

/** Whether the org is a shared one (Everyone's tasks, followers and activity keys exist). */
export function isSharedOrg(tx: Tx, orgId: string): boolean {
  const row = tx
    .select({ isPersonal: organization.isPersonal })
    .from(organization)
    .where(eq(organization.id, orgId))
    .get();
  return row !== undefined && !row.isPersonal;
}

/** Every member of the org (any role). */
export function memberIds(tx: Tx, orgId: string): string[] {
  return tx
    .select({ userId: member.userId })
    .from(member)
    .where(eq(member.organizationId, orgId))
    .all()
    .map((r) => r.userId);
}

export function ownerIds(tx: Tx, orgId: string): string[] {
  return tx
    .select({ userId: member.userId })
    .from(member)
    .where(and(eq(member.organizationId, orgId), eq(member.role, 'owner')))
    .all()
    .map((r) => r.userId);
}

/** One user's own keys (settings, sidebar, personal groups, expansions). */
export function selfAudience(userId: string, org: string | null, keys: QueryKey[]): Audience {
  return { org, userIds: [userId], keys };
}

/**
 * Where a set of tasks shows up: the tasks with their ancestors and descendants (a subtask
 * renders under its parent's row, and a placed subtask shows its parent chain), and every
 * user holding a placement on any of them, i.e. whose my-list can render one of the tasks
 * (06 §2.3 my-list rules).
 */
export interface TaskReach {
  taskIds: Set<string>;
  listUsers: Set<string>;
}

export function taskReach(tx: Tx, taskIds: readonly string[]): TaskReach {
  const family = new Set(taskIds);
  // Ancestors: walk up parent links.
  let frontier = [...taskIds];
  while (frontier.length > 0) {
    const parents: string[] = [];
    for (const chunk of chunked(frontier)) {
      for (const r of tx
        .select({ parentId: task.parentId })
        .from(task)
        .where(inArray(task.id, chunk))
        .all()) {
        if (r.parentId !== null && !family.has(r.parentId)) {
          family.add(r.parentId);
          parents.push(r.parentId);
        }
      }
    }
    frontier = parents;
  }
  // Descendants (any state) and the list users of the whole family: recursive statements,
  // so nothing scales an IN list with the subtree.
  const roots = new Set(taskIds);
  const ancestors = [...family].filter((id) => !roots.has(id));
  for (const r of subtreeOf(tx, taskIds)) family.add(r.id);
  const listUsers = new Set<string>();
  for (const p of subtreePlacements(tx, taskIds)) listUsers.add(p.userId);
  for (const chunk of chunked(ancestors)) {
    for (const r of tx
      .select({ userId: placement.userId })
      .from(placement)
      .where(inArray(placement.taskId, chunk))
      .all()) {
      listUsers.add(r.userId);
    }
  }
  return { taskIds: family, listUsers };
}

/** Union of two reaches (before and after a structural change). */
export function mergeReach(a: TaskReach, b: TaskReach): TaskReach {
  return {
    taskIds: new Set([...a.taskIds, ...b.taskIds]),
    listUsers: new Set([...a.listUsers, ...b.listUsers]),
  };
}

/**
 * The audiences of a task change (04 §4.5): `['my-list', org]` to the actor and every user
 * whose list can render the tasks; `['task', id]` for the whole family (plus `['trash', org]`
 * when Trash changed, and `['everyone', org]` in a shared org) to every member of the org.
 * `activity` adds `['activity', id]` of those tasks (their feed changed). Non-members never
 * appear.
 */
export function taskAudiences(
  tx: Tx,
  input: {
    orgId: string;
    actorId: string | null;
    reach: TaskReach;
    trash?: boolean;
    activity?: readonly string[];
  },
): Audience[] {
  const members = memberIds(tx, input.orgId);
  const memberSet = new Set(members);
  const listUsers = [
    ...new Set([...(input.actorId === null ? [] : [input.actorId]), ...input.reach.listUsers]),
  ].filter((u) => memberSet.has(u));
  const keys = [...input.reach.taskIds].map(qk.task);
  if (input.trash === true) keys.push(qk.trash(input.orgId));
  if (isSharedOrg(tx, input.orgId)) keys.push(qk.everyone(input.orgId));
  for (const id of input.activity ?? []) keys.push(qk.activity(id));
  return [
    { org: input.orgId, userIds: listUsers, keys: [qk.myList(input.orgId)] },
    { org: input.orgId, userIds: members, keys },
  ];
}
