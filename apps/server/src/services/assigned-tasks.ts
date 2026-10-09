import { type DueContext, diffDays, todayIn } from '@rooster/core/dates';
import { inSmartView } from '@rooster/core/views';
import { and, asc, eq, gt, isNotNull, isNull, lte } from 'drizzle-orm';
import { member, organization, placement, task, taskGroup } from '../db/schema/index.ts';
import type { Tx } from './context.ts';
import { listMemberships, type Membership } from './org-access.ts';

/** An open task of the user, with the org it belongs to. */
export interface AssignedTask {
  id: string;
  title: string;
  dueDate: string | null;
  dueTime: string | null;
  dueTz: string | null;
  createdAt: number;
  orgId: string;
  orgSlug: string;
  orgName: string;
}

const columns = {
  id: task.id,
  title: task.title,
  dueDate: task.dueDate,
  dueTime: task.dueTime,
  dueTz: task.dueTz,
  createdAt: task.createdAt,
  orgId: organization.id,
  orgSlug: organization.slug,
  orgName: organization.name,
};

/** Due date, then timed before untimed (times ascending), then created: the Overdue order. */
function byDue(a: AssignedTask, b: AssignedTask): number {
  const da = a.dueDate ?? '9999-12-31';
  const db = b.dueDate ?? '9999-12-31';
  if (da !== db) return da < db ? -1 : 1;
  const ta = a.dueTime ?? '99:99';
  const tb = b.dueTime ?? '99:99';
  if (ta !== tb) return ta < tb ? -1 : 1;
  if (a.createdAt !== b.createdAt) return a.createdAt - b.createdAt;
  return a.id < b.id ? -1 : 1;
}

export function dueContext(timezone: string, now: number): DueContext {
  return { today: todayIn(timezone, now), nowMs: now, viewerTz: timezone };
}

/**
 * The user's open, live tasks due today or earlier, across their live orgs (subtasks
 * included, as in the smart views): the Today view's tasks (ADR 0012), due-ordered.
 */
export function tasksDueByToday(tx: Tx, userId: string, ctx: DueContext): AssignedTask[] {
  return tx
    .select(columns)
    .from(task)
    .innerJoin(organization, eq(organization.id, task.orgId))
    .innerJoin(member, and(eq(member.organizationId, task.orgId), eq(member.userId, userId)))
    .where(
      and(
        eq(task.assigneeId, userId),
        isNull(task.deletedAt),
        isNull(task.completedAt),
        isNull(organization.deletedAt),
        isNotNull(task.dueDate),
        // Floating dates compare as strings (05 §1); `inSmartView` settles timed dues.
        lte(task.dueDate, ctx.today),
      ),
    )
    .all()
    .filter((t) => inSmartView(t, 'today', ctx))
    .sort(byDue);
}

/** Splits Today's tasks into overdue and due today, as the Today view does. */
export function splitOverdue(tasks: readonly AssignedTask[], ctx: DueContext) {
  const overdue = tasks.filter((t) => inSmartView(t, 'overdue', ctx));
  const dueToday = tasks.filter(
    (t) => !overdue.includes(t) && t.dueDate !== null && diffDays(t.dueDate, ctx.today) === 0,
  );
  return { overdue, dueToday };
}

/** Open tasks placed in the user's Inbox groups since `since` (placement time), oldest first. */
export function newInInbox(tx: Tx, userId: string, since: number): AssignedTask[] {
  return (
    tx
      .select(columns)
      .from(placement)
      .innerJoin(taskGroup, eq(taskGroup.id, placement.groupId))
      .innerJoin(task, eq(task.id, placement.taskId))
      .innerJoin(organization, eq(organization.id, task.orgId))
      // Membership is checked here too, not left to the placement invariant (05 §4.1).
      .innerJoin(member, and(eq(member.organizationId, task.orgId), eq(member.userId, userId)))
      .where(
        and(
          eq(placement.userId, userId),
          eq(taskGroup.kind, 'inbox'),
          gt(placement.updatedAt, since),
          isNull(task.deletedAt),
          isNull(task.completedAt),
          isNull(organization.deletedAt),
        ),
      )
      .orderBy(asc(placement.updatedAt), asc(task.id))
      .all()
  );
}

/** The org a "today" link should open: the one with most of the tasks, else the first org. */
export function todayOrg(
  tx: Tx,
  userId: string,
  tasks: readonly AssignedTask[],
): Membership['org'] | null {
  const counts = new Map<string, number>();
  for (const t of tasks) counts.set(t.orgId, (counts.get(t.orgId) ?? 0) + 1);
  const orgs = listMemberships(tx, userId).map((m) => m.org);
  let best = orgs.find((o) => o.isPersonal) ?? orgs[0] ?? null;
  let bestCount = best === null ? 0 : (counts.get(best.id) ?? 0);
  for (const org of orgs) {
    const n = counts.get(org.id) ?? 0;
    if (n > bestCount) {
      best = org;
      bestCount = n;
    }
  }
  return best;
}
