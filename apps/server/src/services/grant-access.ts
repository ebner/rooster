import {
  canRead,
  canWrite,
  canWriteOrg,
  type GrantScope,
  grantsOrg,
  hasScope,
} from '@rooster/core/grants';
import { and, eq, inArray } from 'drizzle-orm';
import { placement, task, taskGroup } from '../db/schema/index.ts';
import { AppError } from '../lib/errors.ts';
import type { Actor, ActorGrant, Tx } from './context.ts';
import { chunked, groupNotFound, type TaskRow, taskNotFound } from './list-access.ts';
import { notFound } from './org-access.ts';

/**
 * Grant enforcement (11 §2.3, `authorizeGrant`): runs in services after the membership check.
 * The browser session (`actor.grant === null`) passes every check. Order: a target the grant
 * cannot see is `404` (existence never leaks), a missing capability `403 forbidden_scope`, a
 * target outside the write constraints `403 outside_grant`.
 */

export const forbiddenScope = (scope: GrantScope) =>
  new AppError(
    'forbidden_scope',
    403,
    `This token or app lacks the "${scope}" permission. Widen it in Settings → Connected apps.`,
  );

const sessionOnly = () =>
  new AppError(
    'forbidden_scope',
    403,
    'Only the signed-in browser can do this; tokens, CLI devices and apps cannot.',
  );

/** Settings, org administration, admin, export, tokens and push (11 §2.1). */
export function requireBrowserSession(actor: Actor): void {
  if (actor.grant !== null) throw sessionOnly();
}

export function requireScope(actor: Actor, scope: GrantScope): void {
  if (actor.grant !== null && !hasScope(actor.grant.scopes, scope)) throw forbiddenScope(scope);
}

export function grantReachesOrg(actor: Actor, orgId: string): boolean {
  return actor.grant === null || grantsOrg(actor.grant.constraints, orgId);
}

/** The orgs a grant lists; undefined when it reaches every org (or for the browser). */
export function reachedOrgIds(actor: Actor): readonly string[] | undefined {
  const orgs = actor.grant?.constraints.orgs;
  return orgs === undefined || orgs === 'all' ? undefined : orgs.map((o) => o.orgId);
}

/** The org is reachable (else the usual `404`) and the grant has `scope`. */
export function authorizeOrg(actor: Actor, orgId: string, scope: GrantScope): void {
  if (!grantReachesOrg(actor, orgId)) throw notFound();
  requireScope(actor, scope);
}

/** Org-wide writes (groups, tags, tasks outside the user's list) need `write: "all"`. */
export function authorizeOrgWide(tx: Tx, actor: Actor, orgId: string, scope: GrantScope): void {
  authorizeOrg(actor, orgId, scope);
  const grant = actor.grant;
  if (grant !== null && !canWriteOrg(grant.constraints, orgId)) {
    throw outsideGrant(
      tx,
      actor.userId,
      grant,
      orgId,
      'This needs write access to the whole organisation.',
    );
  }
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

export function grantGroupOf(tx: Tx, userId: string, row: Pick<TaskRow, 'id' | 'parentId'>) {
  return new GrantGroups(tx, userId).groupOf(row);
}

type TaskTarget = Pick<TaskRow, 'id' | 'parentId' | 'orgId' | 'title'>;

/** Whether the grant may read the task (org reached, read constraint met). */
export function canReadTask(tx: Tx, actor: Actor, row: TaskTarget): boolean {
  const grant = actor.grant;
  if (grant === null) return true;
  return canRead(grant.constraints, row.orgId, grantGroupOf(tx, actor.userId, row));
}

/** Reads: `404` when the grant cannot see the task, `403` without `tasks:read`. */
export function authorizeTaskRead(tx: Tx, actor: Actor, row: TaskTarget): void {
  if (actor.grant === null) return;
  if (!canReadTask(tx, actor, row)) throw taskNotFound();
  requireScope(actor, 'tasks:read');
}

/**
 * Writes to an existing task: visible (`404`), `scope` (`403 forbidden_scope`) and placed in a
 * writable group (`403 outside_grant`; a task outside the user's list needs `write: "all"`).
 */
export function authorizeTaskWrite(
  tx: Tx,
  actor: Actor,
  row: TaskTarget,
  scope: GrantScope = 'tasks:write',
): void {
  const grant = actor.grant;
  if (grant === null) return;
  const group = grantGroupOf(tx, actor.userId, row);
  if (!canRead(grant.constraints, row.orgId, group)) throw taskNotFound();
  requireScope(actor, scope);
  if (!canWrite(grant.constraints, row.orgId, group)) {
    const where = group === null ? 'is not in your list' : `is in ${groupName(tx, group)}`;
    throw outsideGrant(tx, actor.userId, grant, row.orgId, `"${row.title}" ${where}.`);
  }
}

/**
 * A destination (create into, move into, a task's new place): `groupId` is the user's group the
 * task ends up in, null for "not in the user's list".
 */
export function authorizeGroupTarget(
  tx: Tx,
  actor: Actor,
  orgId: string,
  groupId: string | null,
): void {
  const grant = actor.grant;
  if (grant === null || canWrite(grant.constraints, orgId, groupId)) return;
  const where =
    groupId === null
      ? 'That task would not be in your list.'
      : `${groupName(tx, groupId)} is not one of them.`;
  throw outsideGrant(tx, actor.userId, grant, orgId, where);
}

/**
 * Whether the grant may see a notification (or its SSE preview): its org is reached and its
 * task, if any, is readable. A task that is gone counts by its org alone.
 */
export function canReadNotification(
  tx: Tx,
  actor: Actor,
  item: { orgId: string; taskId: string | null },
): boolean {
  if (actor.grant === null) return true;
  if (!grantsOrg(actor.grant.constraints, item.orgId)) return false;
  if (item.taskId === null || canRead(actor.grant.constraints, item.orgId, null)) return true;
  const row = tx
    .select({ id: task.id, parentId: task.parentId, orgId: task.orgId, title: task.title })
    .from(task)
    .where(eq(task.id, item.taskId))
    .get();
  return row === undefined || canReadTask(tx, actor, row);
}

/**
 * The SSE query keys a grant's stream may receive (11 §2.3): nothing of an org it does not
 * reach; task-level keys only with `tasks:read`, and for an unreadable task only the bare
 * `['task']`/`['activity']` prefix; the inbox only with
 * `notifications:read`; org administration never.
 */
export function visibleKeys(
  tx: Tx,
  actor: Actor,
  org: string | null,
  keys: readonly (readonly string[])[],
): (readonly string[])[] {
  const grant = actor.grant;
  if (grant === null) return [...keys];
  if (org !== null && !grantsOrg(grant.constraints, org)) return [];
  const reads = hasScope(grant.scopes, 'tasks:read');
  const out: (readonly string[])[] = [];
  const seen = new Set<string>();
  const push = (key: readonly string[]) => {
    const id = JSON.stringify(key);
    if (seen.has(id)) return;
    seen.add(id);
    out.push(key);
  };
  for (const key of keys) {
    switch (key[0]) {
      case 'task':
      case 'activity': {
        const id = key[1];
        if (!reads) break;
        if (id === undefined) {
          push(key);
          break;
        }
        const row = tx
          .select({ id: task.id, parentId: task.parentId, orgId: task.orgId, title: task.title })
          .from(task)
          .where(eq(task.id, id))
          .get();
        // A task the grant cannot read (any more: purged, or moved out of its groups) is
        // invalidated by the bare prefix, so a cached copy goes stale without naming it.
        push(row !== undefined && canReadTask(tx, actor, row) ? key : [key[0]]);
        break;
      }
      case 'my-list':
      case 'everyone':
      case 'tags':
      case 'trash':
      case 'org-members':
        if (reads) push(key);
        break;
      case 'notifications':
        if (hasScope(grant.scopes, 'notifications:read')) push(key);
        break;
      case 'org-invites':
        break;
      default:
        push(key);
    }
  }
  return out;
}

/** The direct children of a task (deleted ones too). */
export function childIds(tx: Tx, taskId: string): string[] {
  return tx
    .select({ id: task.id })
    .from(task)
    .where(eq(task.parentId, taskId))
    .all()
    .map((r) => r.id);
}

/** Each task's grant group (see `GrantGroups`) at this moment. */
export function groupSnapshot(
  tx: Tx,
  userId: string,
  ids: readonly string[],
): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const id of ids) {
    const row = tx
      .select({ id: task.id, parentId: task.parentId })
      .from(task)
      .where(eq(task.id, id))
      .get();
    if (row !== undefined) out.set(id, grantGroupOf(tx, userId, row));
  }
  return out;
}

/**
 * After a change that reconciles placements: every task in `before` whose group changed must
 * leave a writable group for a writable one, else `403 outside_grant` (rolling the change
 * back). `leaving` may leave the list altogether (assigned to someone else).
 */
export function authorizeGroupMoves(
  tx: Tx,
  actor: Actor,
  orgId: string,
  before: ReadonlyMap<string, string | null>,
  options: { leaving?: string | null } = {},
): void {
  if (actor.grant === null) return;
  const after = groupSnapshot(tx, actor.userId, [...before.keys()]);
  for (const [id, from] of before) {
    const to = after.get(id) ?? null;
    if (to === from) continue;
    if (id === options.leaving && to === null) continue;
    authorizeGroupTarget(tx, actor, orgId, from);
    authorizeGroupTarget(tx, actor, orgId, to);
  }
}

/** A group the grant may read (`404` otherwise, like someone else's group). */
export function authorizeGroupRead(actor: Actor, orgId: string, groupId: string): void {
  const grant = actor.grant;
  if (grant === null) return;
  if (!canRead(grant.constraints, orgId, groupId)) throw groupNotFound();
  requireScope(actor, 'tasks:read');
}

/** A list filter by the read constraint; null when everything in the org is readable. */
export function readFilter(
  tx: Tx,
  actor: Actor,
  orgId: string,
  rows: readonly Pick<TaskRow, 'id' | 'parentId'>[] = [],
): ((row: Pick<TaskRow, 'id' | 'parentId'>) => boolean) | null {
  const grant = actor.grant;
  if (grant === null || canRead(grant.constraints, orgId, null)) return null;
  const groups = new GrantGroups(tx, actor.userId).prime(rows);
  return (row) => canRead(grant.constraints, orgId, groups.groupOf(row));
}

/** Groups (by ID) the read constraint hides; null when it hides none. */
export function groupReadFilter(
  actor: Actor,
  orgId: string,
): ((groupId: string) => boolean) | null {
  const grant = actor.grant;
  if (grant === null || canRead(grant.constraints, orgId, null)) return null;
  return (groupId) => canRead(grant.constraints, orgId, groupId);
}

function groupName(tx: Tx, groupId: string): string {
  const row = tx
    .select({ name: taskGroup.name })
    .from(taskGroup)
    .where(eq(taskGroup.id, groupId))
    .get();
  return row === undefined ? 'another group' : `"${row.name}"`;
}

/** `403 outside_grant`, naming the groups the grant may write in (11 §2.3). */
function outsideGrant(
  tx: Tx,
  userId: string,
  grant: ActorGrant,
  orgId: string,
  why: string,
): AppError {
  const org =
    grant.constraints.orgs === 'all' ? null : grant.constraints.orgs.find((o) => o.orgId === orgId);
  let allowed: string;
  if (org === undefined || org === null || org.write === 'none') {
    allowed = 'This token or app may not write in this organisation.';
  } else if (org.write === 'all') {
    allowed = 'This token or app may write anywhere in this organisation.';
  } else {
    const names = tx
      .select({ id: taskGroup.id, name: taskGroup.name })
      .from(taskGroup)
      .where(and(eq(taskGroup.userId, userId), inArray(taskGroup.id, [...org.write.groups])))
      .all();
    const byId = new Map(names.map((g) => [g.id, g.name]));
    const listed = org.write.groups.map((id) => `"${byId.get(id) ?? id}"`).join(', ');
    allowed = `This token or app may write only in ${listed}.`;
  }
  return new AppError(
    'outside_grant',
    403,
    `${allowed} ${why} Widen it in Settings → Connected apps.`,
  );
}
